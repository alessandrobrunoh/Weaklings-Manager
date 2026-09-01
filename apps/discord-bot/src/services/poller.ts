import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Client, TextChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  PaginatedData,
  EventView,
  BattleSummary,
  SplitDiscoveryBatch,
  SplitDiscordSync,
} from "../api/types.js";
import { buildEventAnnouncementContent } from "../embeds/event.embed.js";
import { buildBattleEmbed } from "../embeds/battle.embed.js";
import { GUILD_NAME } from "../embeds/theme.js";
import { config } from "../config.js";
import type { SettingsService } from "./settings.js";
import {
  buildEventThreadName,
  createEventAnnouncementThread,
  sendEventSignupMessage,
} from "./event-announcement-thread.js";
import { SplitForumAdapter } from "./split-forum.js";

const STATE_FILE_NAME = "poller-state.json";

interface PollerState {
  lastEventId: number;
  lastBattleId: number;
  pinged1hEvents: number[];
  /** Discord discussion thread keyed by event ID, used for event follow-ups. */
  eventThreadIds: Record<string, string>;
  /** Stable cursor over split (updated_at, id), persisted only after successful Forum sync. */
  splitUpdatedAt: string | null;
  splitAfterId: number | null;
}

function createDefaultState(): PollerState {
  return {
    lastEventId: 0,
    lastBattleId: 0,
    pinged1hEvents: [],
    eventThreadIds: {},
    splitUpdatedAt: null,
    splitAfterId: null,
  };
}

/**
 * Keeps poller checkpoint files in a dedicated writable directory.
 *
 * The container runs as a non-root user, so relying on the process working
 * directory is fragile. This helper centralizes directory creation and gives
 * startup a clear failure when deployment permissions are wrong.
 *
 * @example
 * ```ts
 * ensureStateDirectory("/app/data");
 * ```
 */
function ensureStateDirectory(stateDirectory: string): void {
  try {
    if (!existsSync(stateDirectory)) {
      mkdirSync(stateDirectory, { recursive: true });
    }
  } catch (error) {
    throw new Error(
      `Failed to prepare poller state directory at ${stateDirectory}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Restores poller progress without losing the bot on corrupt JSON.
 *
 * A malformed checkpoint should not prevent Discord commands from coming
 * online, but filesystem permission errors must still fail loudly because the
 * service would otherwise spam duplicate announcements after each restart.
 *
 * @example
 * ```ts
 * const state = loadState("/app/data");
 * console.log(state.lastEventId);
 * ```
 */
function loadState(stateDirectory: string): PollerState {
  ensureStateDirectory(stateDirectory);

  const stateFile = join(stateDirectory, STATE_FILE_NAME);
  if (!existsSync(stateFile)) {
    return createDefaultState();
  }

  try {
    const parsedState = JSON.parse(
      readFileSync(stateFile, "utf-8"),
    ) as Partial<PollerState>;
    return {
      lastEventId: parsedState.lastEventId ?? 0,
      lastBattleId: parsedState.lastBattleId ?? 0,
      pinged1hEvents: parsedState.pinged1hEvents ?? [],
      eventThreadIds: parsedState.eventThreadIds ?? {},
      splitUpdatedAt: parsedState.splitUpdatedAt ?? null,
      splitAfterId: parsedState.splitAfterId ?? null,
    };
  } catch (error) {
    console.warn(
      `[Poller] Ignoring unreadable state file at ${stateFile}:`,
      error,
    );
    return createDefaultState();
  }
}

/**
 * Persists progress after each successful Discord announcement.
 *
 * The write is synchronous on purpose: a crash immediately after sending a
 * message must not roll the checkpoint back and re-announce the same event or
 * battle on the next start.
 *
 * @example
 * ```ts
 * saveState("/app/data", { lastEventId: 42, lastBattleId: 7, pinged1hEvents: [] });
 * ```
 */
function saveState(stateDirectory: string, state: PollerState): void {
  ensureStateDirectory(stateDirectory);
  writeFileSync(
    join(stateDirectory, STATE_FILE_NAME),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

/**
 * Polling service that checks for new events and battles and posts them
 * to the configured Discord channels.
 */
export class Poller {
  private readonly state: PollerState;
  private readonly stateDirectory = config.POLLER_STATE_DIR;
  private timer: NodeJS.Timeout | undefined;
  /** Guards against a manually-triggered check overlapping a scheduled one —
   *  both would otherwise read the same stale `lastEventId`/`lastBattleId`
   *  and could announce the same event or battle twice. */
  private polling = false;

  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly settings: SettingsService,
    private readonly intervalMs: number,
  ) {
    this.state = loadState(this.stateDirectory);
    console.log(
      `[Poller] Starting — last event ID: ${this.state.lastEventId}, last battle ID: ${this.state.lastBattleId}`,
    );
  }

  /** Start the polling loop. */
  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Runs one poll cycle immediately instead of waiting for the next scheduled
   * tick — used by `/event-create` so a bot-created event is announced right
   * away rather than up to `intervalMs` later, while still going through
   * this single announcement path (see services/poller.ts module docs) so it
   * is never posted a second time.
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      // Event announcements must complete before checking reminders so a newly
      // created event already has its discussion thread recorded.
      await this.checkNewEvents();
      await Promise.allSettled([
        this.checkNewBattles(),
        this.checkUpcomingEvents(),
        this.checkSplitSync(),
      ]);
    } finally {
      this.polling = false;
    }
  }

  /** Fetches recently-created events and announces any not covered by the checkpoint. */
  private async checkNewEvents(): Promise<void> {
    try {
      // The API defaults to event-date ordering. That is unsuitable for a creation
      // checkpoint: an event scheduled far in the future can fall outside page 1.
      const result = await this.api.get<PaginatedData<EventView>>(
        "api/events",
        undefined,
        {
          page: 1,
          limit: 50,
          sort: "created_at",
          order: "desc",
        },
      );

      const newestEventId = result.items.reduce(
        (max, event) => Math.max(max, event.id),
        0,
      );
      if (newestEventId > 0 && newestEventId < this.state.lastEventId) {
        console.warn(
          `[Poller] Event checkpoint ${this.state.lastEventId} is newer than the API (${newestEventId}); resetting it`,
        );
        this.state.lastEventId = 0;
        saveState(this.stateDirectory, this.state);
      }

      const newEvents = result.items
        .filter((e) => e.id > this.state.lastEventId)
        .sort((a, b) => a.id - b.id);

      if (newEvents.length === 0) {
        return;
      }

      const [eventsChannelId, callToArmsChannelId] = await Promise.all([
        this.settings.eventsChannelId(),
        this.settings.callToArmsChannelId(),
      ]);

      for (const event of newEvents) {
        const channelId = event.call_to_arms ? callToArmsChannelId : eventsChannelId;
        if (!channelId) {
          console.warn(
            `[Poller] Cannot announce event #${event.id}: no ${event.call_to_arms ? "Call to Arms" : "events"} channel is configured`,
          );
          return;
        }
        const channel = await this.getTextChannel(channelId);
        if (!channel) {
          return;
        }

        const roleIds = event.discord_role_ids ?? []
        const announcementMessage = await channel.send({
          content: buildEventAnnouncementContent(event),
          allowedMentions: roleIds.length > 0
            ? { roles: roleIds }
            : { parse: [] },
        });
        const thread = await createEventAnnouncementThread(
          announcementMessage,
          event,
          "Poller",
        );
        if (thread) {
          this.state.eventThreadIds[String(event.id)] = thread.id;
          await sendEventSignupMessage(thread, event, "Poller");
        }

        this.state.lastEventId = event.id;
        saveState(this.stateDirectory, this.state);
        console.log(
          `[Poller] Announced ${event.call_to_arms ? "Call to Arms" : "event"} #${event.id}: ${event.title}`,
        );
      }
    } catch (err) {
      console.error("[Poller] Failed to check events:", err);
    }
  }

  /**
   * Synchronizes split Forum posts from the backend-owned incremental contract.
   * The `(updated_at, id)` cursor advances after each successfully maintained Discord post.
   */
  private async checkSplitSync(): Promise<void> {
    try {
      const forumChannelId = await this.settings.splitsForumChannelId();
      if (!forumChannelId) return;

      const adapter = new SplitForumAdapter(this.client, this.api, forumChannelId);
      let hasMore = true;
      while (hasMore) {
        const params: Record<string, string | number> = { limit: 50 };
        if (this.state.splitUpdatedAt) {
          params.updated_after = this.state.splitUpdatedAt;
          if (this.state.splitAfterId !== null) params.after_id = this.state.splitAfterId;
        }

        const batch = await this.api.get<SplitDiscoveryBatch>(
          "api/splits/discord-sync",
          undefined,
          params,
        );
        for (const split of batch.items) {
          const item = await this.api.get<SplitDiscordSync>(
            `api/splits/${split.id}/discord-sync`,
          );
          if (!await adapter.sync(item)) return;

          this.state.splitUpdatedAt = split.updated_at ?? split.created_at;
          this.state.splitAfterId = split.id;
          saveState(this.stateDirectory, this.state);
        }
        hasMore = batch.has_more;
      }
    } catch (err) {
      // A split sync failure is isolated from event/battle announcements and retried next tick.
      console.error("[Poller] Failed to sync split Forum posts:", err);
    }
  }

  /** Checks for scheduled events starting in <= 1 hour and notifies their discussion thread. */
  private async checkUpcomingEvents(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<EventView>>(
        "api/events",
        undefined,
        {
          page: 1,
          limit: 20,
        },
      );

      const now = new Date().getTime();
      const oneHourMs = 60 * 60 * 1000;

      const upcomingEvents = result.items.filter((e) => {
        if (e.status !== "scheduled") return false;
        if (this.state.pinged1hEvents.includes(e.id)) return false;

        const eventTime = new Date(e.event_date_utc).getTime();
        const diff = eventTime - now;
        return diff > 0 && diff <= oneHourMs;
      });

      if (upcomingEvents.length === 0) return;

      for (const event of upcomingEvents) {
        const threadId = this.state.eventThreadIds[String(event.id)];
        let thread = threadId ? await this.client.channels.fetch(threadId) : null;

        // Events announced before thread IDs were persisted can still be recovered
        // while their discussion thread is active.
        if (!thread?.isThread()) {
          const eventsChannel = await this.getTextChannel(await this.settings.eventsChannelId());
          const activeThreads = eventsChannel ? await eventsChannel.threads.fetchActive() : null;
          thread = activeThreads?.threads.find(
            (candidate) => candidate.name === buildEventThreadName(event.title),
          ) ?? null;
        }
        if (!thread?.isThread()) {
          console.warn(
            `[Poller] Cannot send 1h warning for event #${event.id}: no active announcement thread was found`,
          );
          continue;
        }

        this.state.eventThreadIds[String(event.id)] = thread.id;
        const roleIds = event.discord_role_ids ?? [];
        const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(" ");
        await thread.send({
          content: `🚨 ${roleMentions} The event **${event.title}** starts in less than 1 hour! Get ready!`,
          allowedMentions: roleIds.length > 0 ? { roles: roleIds } : { parse: [] },
        });

        this.state.pinged1hEvents.push(event.id);
        saveState(this.stateDirectory, this.state);
        console.log(`[Poller] Posted 1h warning in the thread for event #${event.id}`);
      }

      // Cleanup old pinged events (keep last 50)
      if (this.state.pinged1hEvents.length > 50) {
        this.state.pinged1hEvents = this.state.pinged1hEvents.slice(-50);
        const retainedEventIds = new Set(this.state.pinged1hEvents.map(String));
        this.state.eventThreadIds = Object.fromEntries(
          Object.entries(this.state.eventThreadIds).filter(([eventId]) => retainedEventIds.has(eventId)),
        );
        saveState(this.stateDirectory, this.state);
      }
    } catch (err) {
      console.error("[Poller] Failed to check upcoming events:", err);
    }
  }

  /** Fetches the latest battles and announces any with ID > lastBattleId. */
  private async checkNewBattles(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<BattleSummary>>(
        "api/battles",
        undefined,
        {
          page: 1,
          limit: 10,
        },
      );

      const newBattles = result.items
        .filter((b) => b.battle_id > this.state.lastBattleId)
        .sort((a, b) => a.battle_id - b.battle_id);

      if (newBattles.length === 0) return;

      const channel = await this.getTextChannel(await this.settings.battlesChannelId());
      if (!channel) return;

      for (const battle of newBattles) {
        const embed = buildBattleEmbed(battle, GUILD_NAME);
        await channel.send({ embeds: [embed] });

        this.state.lastBattleId = battle.battle_id;
        saveState(this.stateDirectory, this.state);
        console.log(`[Poller] Announced battle #${battle.battle_id}`);
      }
    } catch (err) {
      console.error("[Poller] Failed to check battles:", err);
    }
  }

  private async getTextChannel(channelId: string | null): Promise<TextChannel | null> {
    if (!channelId) {
      return null;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[Poller] Channel ${channelId} is not a text channel.`);
        return null;
      }
      return channel as TextChannel;
    } catch (err) {
      console.error(`[Poller] Could not fetch channel ${channelId}:`, err);
      return null;
    }
  }
}

let instance: Poller | null = null;

/** Registers the process-wide `Poller` singleton. Call once from `index.ts` at startup. */
export function registerPoller(poller: Poller): void {
  instance = poller;
}

/**
 * Returns the singleton registered by {@link registerPoller}, or `null` before startup has
 * finished constructing it. Callers that only want a best-effort immediate check (like
 * `/event-create`) should treat `null` as "the scheduled tick will pick it up instead" rather
 * than an error.
 */
export function getPoller(): Poller | null {
  return instance;
}
