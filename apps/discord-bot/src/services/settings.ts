import type { ApiClient } from '../api/client.js';
import type { GuildSettingsView } from '../api/types.js';

/**
 * Fetches the guild's Discord integration settings from the backend instead of reading them from
 * this process's own env vars.
 *
 * The settings live in the backend's `guild_settings` table, editable from the admin Settings
 * page — moving them there is the whole point: an admin can change a channel without redeploying
 * the bot. The GET call runs with no `discordId`, which the backend's bot-auth middleware
 * resolves to a "bot system" context with Admin-level access (the same path the poller already
 * uses for `api/events`/`api/battles`), so no extra bot-specific endpoint or credential is needed.
 *
 * Cached with a short TTL rather than fetched on every call: slash commands and the poller both
 * consult this on nearly every interaction, and a channel ID does not need to be read fresh on
 * every single message. A stale cache is served (with a warning) if a refresh fails, rather than
 * failing the caller outright — a transient backend hiccup should not stop the bot from
 * announcing to whatever channel it last knew about.
 *
 * One instance per tenant: the `api` it is built on must already be stamped with that guild's
 * `X-Guild-Id`, because the backend resolves `guild_settings` inside that tenant's own schema.
 *
 * @example
 * const settings = new SettingsService(api.withGuild(guildId));
 * const channelId = await settings.eventsChannelId();
 */
export class SettingsService {
  private cached: GuildSettingsView | null = null;
  private lastFetchedAt = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly ttlMs = 60_000,
  ) {}

  /** Returns the full settings row, refreshing if the cache is stale. */
  async get(): Promise<GuildSettingsView> {
    const now = Date.now();
    if (this.cached && now - this.lastFetchedAt < this.ttlMs) {
      return this.cached;
    }
    try {
      this.cached = await this.api.get<GuildSettingsView>('api/admin/settings');
      this.lastFetchedAt = now;
    } catch (err) {
      if (!this.cached) {
        throw err;
      }
      console.warn('[Settings] Failed to refresh guild settings, using stale cache:', err);
    }
    return this.cached;
  }

  async eventsChannelId(): Promise<string | null> {
    return (await this.get()).discord_events_channel_id;
  }

  async battlesChannelId(): Promise<string | null> {
    return (await this.get()).discord_battles_channel_id;
  }

  /** Returns the dedicated channel for urgent Call to Arms event announcements. */
  async callToArmsChannelId(): Promise<string | null> {
    return (await this.get()).discord_battles_cta_channel_id;
  }

  async applicationAcceptedRoleId(): Promise<string | null> {
    return (await this.get()).discord_applications_accepted_role_id ?? null;
  }

  /** Returns the category where live event voice channels are created. */
  async eventVoiceCategoryId(): Promise<string | null> {
    return (await this.get()).discord_event_voice_category_id;
  }

  async applicationsSettings(): Promise<GuildSettingsView> {
    return this.get();
  }

  async applicationsStatusChannelId(): Promise<string | null> {
    return (await this.get()).discord_applications_status_channel_id;
  }

  async giveawaysChannelId(): Promise<string | null> {
    return (await this.get()).discord_giveaways_channel_id ?? null;
  }

  async giveawaysRoleId(): Promise<string | null> {
    return (await this.get()).discord_giveaways_role_id ?? null;
  }

  async splitsForumChannelId(): Promise<string | null> {
    return (await this.get()).discord_splits_forum_channel_id;
  }

  async splitTagId(status: 'pending' | 'awaiting_event' | 'completed' | 'not_completed' | 'lost'): Promise<string | null> {
    const settings = await this.get();
    return {
      pending: settings.discord_split_pending_tag_id,
      awaiting_event: settings.discord_split_pending_tag_id,
      completed: settings.discord_split_completed_tag_id,
      not_completed: settings.discord_split_not_completed_tag_id,
      lost: settings.discord_split_lost_tag_id,
    }[status];
  }
}

let baseApi: ApiClient | null = null;
const services = new Map<string, SettingsService>();

/**
 * Initializes the process-wide settings registry. Call once from `index.ts` at startup.
 *
 * `api` is the unscoped client; each guild gets its own `SettingsService` over
 * `api.withGuild(guildId)`, created on first use. `guild_settings` lives in the tenant's own
 * schema, so one cache per guild is required — a shared one would hand another server's channel
 * IDs to the wrong guild.
 *
 * A registry (rather than threading a `SettingsService` through every command's `execute`
 * signature) keeps `BotCommand#execute(interaction, api)` unchanged for the commands that never
 * need it, while still sharing one cache per guild across the ones that do and the poller.
 */
export function initSettingsService(api: ApiClient): void {
  baseApi = api;
  services.clear();
}

/**
 * Returns the `SettingsService` for one guild, creating it on first use.
 *
 * @param guildId Discord guild id — in practice `api.guildId` of the guild-scoped client the
 * caller was handed, so the settings and the API calls around them always target one tenant.
 * @throws When the registry was never initialized, or the caller has no guild context (a DM, or
 * an unscoped client). Both messages start with `SettingsService` so callers that legitimately
 * run without a tenant can recognize them.
 */
export function getSettingsService(guildId: string | null | undefined): SettingsService {
  if (!baseApi) {
    throw new Error('SettingsService not initialized — call initSettingsService() first.');
  }
  if (!guildId) {
    throw new Error('SettingsService requires a guild id — this action has no tenant context.');
  }
  let service = services.get(guildId);
  if (!service) {
    service = new SettingsService(baseApi.withGuild(guildId));
    services.set(guildId, service);
  }
  return service;
}

/** Drops a guild's cached settings, e.g. when the bot is removed from that server. */
export function forgetSettingsService(guildId: string): void {
  services.delete(guildId);
}
