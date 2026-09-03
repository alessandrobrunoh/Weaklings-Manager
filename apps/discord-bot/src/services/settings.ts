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
 * @example
 * const settings = new SettingsService(api);
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

  async eventRoleId(): Promise<string | null> {
    return (await this.get()).discord_event_role_id;
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

let instance: SettingsService | null = null;

/**
 * Initializes the process-wide `SettingsService` singleton. Call once from `index.ts` at startup.
 *
 * A singleton (rather than threading a `SettingsService` through every command's `execute`
 * signature) keeps `BotCommand#execute(interaction, api)` unchanged for the 13 commands that
 * never need it, while still sharing one cache across the 2 that do (`event-create`,
 * `event-start`) and the poller.
 */
export function initSettingsService(api: ApiClient): SettingsService {
  instance = new SettingsService(api);
  return instance;
}

/** Returns the singleton initialized by {@link initSettingsService}. */
export function getSettingsService(): SettingsService {
  if (!instance) {
    throw new Error('SettingsService not initialized — call initSettingsService() first.');
  }
  return instance;
}
