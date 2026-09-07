import type { ApiClient } from "../api/client.js";

/**
 * The three `api/progression/settings` fields the message-XP gate needs to
 * pre-filter locally. A minimal shape rather than the full settings view —
 * this file has no reason to know about level curves or event XP rates.
 */
interface MessageXpSettings {
  message_cooldown_secs: number;
  message_min_chars: number;
  message_channel_deny_list: string[];
}

/** How long a fetched (or failed) settings answer is reused. */
export const SETTINGS_TTL_MS = 60_000;

interface CachedSettings {
  settings: MessageXpSettings | null;
  fetchedAt: number;
}

/**
 * Decides, from already-known settings and the caller's own last award, the
 * kind of `POST api/progression/award/message` this file exists to avoid.
 *
 * Every one of these three checks mirrors a check the backend itself makes
 * (`ProgressionService::award_message`) before it ever writes a ledger row —
 * this function exists to answer the same question one HTTP round trip
 * earlier, not to invent a new policy. `settings === null` (feature not
 * fetched yet, or the guild's `progression` module is off) always answers
 * "call the backend": with no local knowledge to trust, understating how
 * often to award is worse than one avoidable network call.
 */
export function shouldSkipMessageAwardLocally(
  settings: MessageXpSettings | null,
  length: number,
  channelId: string,
  now: number,
  lastAwardedAt: number | undefined,
): boolean {
  if (!settings) {
    return false;
  }
  if (length < settings.message_min_chars) {
    return true;
  }
  if (settings.message_channel_deny_list.includes(channelId)) {
    return true;
  }
  if (settings.message_cooldown_secs > 0 && lastAwardedAt !== undefined) {
    const elapsedSecs = (now - lastAwardedAt) / 1000;
    if (elapsedSecs < settings.message_cooldown_secs) {
      return true;
    }
  }
  return false;
}

/**
 * Per-tenant gate in front of the message-XP award call.
 *
 * Every message the bot sees in a busy server used to cost a full HTTP round
 * trip to the backend even when the sender was almost certainly still on
 * cooldown from their last one — `award_message` itself would then do the
 * same cooldown/length/channel checks and answer "skipped" without writing
 * anything. This gate answers the same three checks locally once it has seen
 * `api/progression/settings`, so a chatty user's messages between awards
 * cost nothing but a `Map` lookup.
 *
 * Deliberately fails open: any settings-fetch failure (network hiccup, or the
 * guild's `progression` module not enabled — `/settings` is feature-gated
 * even for a bot request) disables local filtering for that guild rather than
 * guessing, so a call that would have been correctly skipped is still
 * skipped, just one round trip later than necessary — never the other way
 * around.
 */
export class MessageXpGate {
  private cachedSettings: CachedSettings | null = null;
  private readonly lastAwardedAt = new Map<string, number>();

  constructor(
    private readonly api: ApiClient,
    private readonly ttlMs = SETTINGS_TTL_MS,
  ) {}

  private async settings(): Promise<MessageXpSettings | null> {
    const now = Date.now();
    if (this.cachedSettings && now - this.cachedSettings.fetchedAt < this.ttlMs) {
      return this.cachedSettings.settings;
    }
    let settings: MessageXpSettings | null;
    try {
      settings = await this.api.get<MessageXpSettings>("api/progression/settings");
    } catch {
      // Network error, or a 403 because this guild's `progression` module
      // isn't enabled — either way, filter nothing rather than guess.
      settings = null;
    }
    this.cachedSettings = { settings, fetchedAt: now };
    return settings;
  }

  /**
   * Whether `api/progression/award/message` is worth calling for this
   * message. `discordId` and `channelId` identify the same fields the actual
   * award call carries.
   */
  async shouldAward(discordId: string, channelId: string, length: number): Promise<boolean> {
    const settings = await this.settings();
    const now = Date.now();
    const skip = shouldSkipMessageAwardLocally(
      settings,
      length,
      channelId,
      now,
      this.lastAwardedAt.get(discordId),
    );
    return !skip;
  }

  /** Records a real `awarded: true` response so the next cooldown check has it. */
  recordAward(discordId: string): void {
    this.lastAwardedAt.set(discordId, Date.now());
  }
}

let baseApi: ApiClient | null = null;
const gates = new Map<string, MessageXpGate>();

/**
 * Initializes the process-wide gate registry. Call once from `index.ts` at
 * startup, alongside {@link initSettingsService}.
 */
export function initMessageXpGate(api: ApiClient): void {
  baseApi = api;
  gates.clear();
}

/** Returns the {@link MessageXpGate} for one guild, creating it on first use. */
export function getMessageXpGate(guildId: string): MessageXpGate {
  if (!baseApi) {
    throw new Error("MessageXpGate not initialized — call initMessageXpGate() first.");
  }
  let gate = gates.get(guildId);
  if (!gate) {
    gate = new MessageXpGate(baseApi.withGuild(guildId));
    gates.set(guildId, gate);
  }
  return gate;
}

/** Drops a guild's cached settings and per-user cooldowns, e.g. when the bot is removed. */
export function forgetMessageXpGate(guildId: string): void {
  gates.delete(guildId);
}
