import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import type { Client, Message, TextChannel, ThreadChannel } from "discord.js";
import { ApiError, type ApiClient } from "../api/client.js";
import type {
  PaginatedData,
  EventView,
  EventDetailView,
  EventRevision,
  BattleSummary,
  SplitDiscoveryBatch,
  SplitDiscordSync,
  GiveawayView,
  GiveawayDetailView,
} from "../api/types.js";
import {
  buildAllianceLifecycleMessage,
  buildEventAnnouncementMessage,
  buildEventCalendarMessages,
  shouldPingAllianceDiscord,
  withAlliancePingRoles,
  type AllianceLifecycleKind,
} from "../embeds/event.embed.js";
import {
  buildGiveawayAnnouncementMessage,
  buildGiveawayEmbed,
  buildGiveawayActionRow,
  buildGiveawayWinnerMessage,
} from "../embeds/giveaway.embed.js";
import { buildBattleEmbed } from "../embeds/battle.embed.js";
import {
  buildApplicationPanelMessage,
  buildApplicationStatusAnnouncement,
} from "../embeds/application.embed.js";
import { GUILD_NAME } from "../embeds/theme.js";
import { config } from "../config.js";
import type { SettingsService } from "./settings.js";
import { flashCopy } from "./flash-copy.js";
import {
  calendarChannelIds,
  destinationChannel,
  destinationChannelLabel,
} from "./event-channels.js";
import {
  buildEventThreadName,
  closeEventAnnouncementThread,
  createEventAnnouncementThread,
  createStandaloneEventThread,
  deleteEventAnnouncement,
  refreshEventSignupCard,
  sendEventSignupMessage,
} from "./event-announcement-thread.js";
import {
  massDiscordEvent,
  nextEmptyLiveVoiceCheck,
  startDiscordEvent,
  stopDiscordEvent,
  voiceChannelOccupantCount,
} from "./event-lifecycle.js";
import { SplitForumAdapter } from "./split-forum.js";
import {
  discordErrorCode,
  isUnknownDiscordChannel,
  withUnarchivedThread,
} from "./discord-thread.js";

/**
 * Checkpoint file for one guild.
 *
 * Each tenant gets its own file because the checkpoints inside it (last
 * announced event, split cursor, Discord thread ids) are all tenant-local — a
 * shared file would let one server's `lastEventId` suppress another server's
 * announcements. Guilds are Discord snowflakes, so the name needs no escaping,
 * but it is asserted here rather than assumed.
 */
function stateFileName(guildId: string): string {
  if (!/^[0-9]+$/.test(guildId)) {
    throw new Error(`Refusing to build a poller state file for guild id "${guildId}".`);
  }
  return `poller-state-${guildId}.json`;
}

interface PollerState {
  lastEventId: number;
  lastBattleId: number;
  pinged1hEvents: number[];
  /** Discord discussion thread keyed by event ID, used for event follow-ups. */
  eventThreadIds: Record<string, string>;
  /** Parent-channel announcement message ids, needed to retry flash thread creation without re-pinging. */
  eventParentMessageIds: Record<string, string>;
  /** Signup card message id inside each event thread. */
  eventSignupMessageIds: Record<string, string>;
  /** Persistent calendar page message ids keyed by their parent channel id. */
  eventCalendarMessageIds: Record<string, string[]>;
  /** Last rendered payload fingerprint per calendar page; skips unchanged Discord edits. */
  eventCalendarFingerprints: Record<string, string[]>;
  /**
   * Events waiting for their undo window or retrying a failed Discord delivery.
   *
   * `lastEventId` is a processed high-water mark, NOT an announced-one: an
   * The event id is a durable work queue because `lastEventId` is only a
   * processed high-water mark. Entries leave only when the announcement is
   * posted or the event is gone/cancelled.
   */
  pendingAnnounces: Record<
    string,
    { attempts: number; lastError: string; since: string; status?: "undo_window" | "failed" }
  >;
  /** One-release compatibility for checkpoints written before the queue was renamed. */
  failedAnnounces?: PollerState["pendingAnnounces"];
  /** Last Discord-synced `${roster_version}:${status}` per event. */
  eventSignupRevisions: Record<string, string>;
  /** Stable cursor over split (updated_at, id), persisted only after successful Forum sync. */
  splitUpdatedAt: string | null;
  splitAfterId: number | null;
  massedEvents: number[];
  emptyLiveChecks: Record<string, number>;
  /** Live events whose voice channel has been seen occupied at least once. */
  occupiedLiveEvents: number[];
  /** Last completed orphan voice-channel sweep attempt (Unix milliseconds). */
  lastVoiceSweepAt: number;
  applicationsOpen?: boolean;
  lastGiveawayId: number;
  postedGiveawayIds: number[];
  announcedGiveawayDraws: number[];
  /**
   * False until the checkpoints below have been seeded from the live API.
   *
   * Without this, a guild with no checkpoint file starts every cursor at zero
   * and the first poll treats the whole first API page as brand new — up to 50
   * events, 10 battles and every open giveaway re-announced at once. That is
   * what a restart onto an empty state directory (a container without a
   * persistent volume, a wiped file, a newly added tenant) looks like from
   * Discord: the bot spams its entire backlog.
   */
  initialized: boolean;
}

export interface EventCalendarRefreshResult {
  eventCount: number;
  configuredChannels: number;
  updatedChannels: string[];
  failedChannels: EventCalendarChannelFailure[];
  unroutedEvents: number;
  unroutedCallToArms: number;
}

export interface EventCalendarChannelFailure {
  channelId: string;
  reason: string;
}

/** Discord JSON error for a message id that no longer exists. */
const DISCORD_UNKNOWN_MESSAGE = 10008;
/** Discord JSON error for an operation the bot's current channel permissions reject. */
const DISCORD_MISSING_PERMISSIONS = 50013;
/** Give the flash author a short undo window before sending a role-wide ping. */
export const FLASH_UNDO_WINDOW_MS = 30_000;
/** Run the orphan sweep sparsely; per-guild pollers share the same Discord token. */
const VOICE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Do not sweep a just-created voice channel before the Mass joiners have arrived. */
const VOICE_SWEEP_MIN_AGE_MS = 30 * 60 * 1000;

function flashUndoTimeRemaining(event: Pick<EventView, "event_kind" | "created_at">): number {
  if (event.event_kind !== "flash") return 0;
  const createdAt = Date.parse(event.created_at);
  if (!Number.isFinite(createdAt)) return 0;
  return Math.max(0, createdAt + FLASH_UNDO_WINDOW_MS - Date.now());
}

function createDefaultState(): PollerState {
  return {
    lastEventId: 0,
    lastBattleId: 0,
    pinged1hEvents: [],
    eventThreadIds: {},
    eventParentMessageIds: {},
    eventSignupMessageIds: {},
    eventCalendarMessageIds: {},
    eventCalendarFingerprints: {},
    pendingAnnounces: {},
    eventSignupRevisions: {},
    splitUpdatedAt: null,
    splitAfterId: null,
    massedEvents: [],
    emptyLiveChecks: {},
    occupiedLiveEvents: [],
    lastVoiceSweepAt: Date.now(),
    applicationsOpen: undefined,
    lastGiveawayId: 0,
    postedGiveawayIds: [],
    announcedGiveawayDraws: [],
    initialized: false,
  };
}

function restoreEventCalendarMessageIds(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).flatMap(([channelId, stored]) => {
      if (typeof stored === "string" && stored.length > 0) {
        return [[channelId, [stored]]];
      }
      if (Array.isArray(stored)) {
        return [
          [
            channelId,
            stored.filter((messageId): messageId is string => typeof messageId === "string"),
          ],
        ];
      }
      return [];
    }),
  );
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
 * const state = loadState("/app/data", "123456789012345678");
 * console.log(state.lastEventId);
 * ```
 */
function loadState(stateDirectory: string, fileName: string): PollerState {
  ensureStateDirectory(stateDirectory);

  const stateFile = join(stateDirectory, fileName);
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
      eventParentMessageIds: parsedState.eventParentMessageIds ?? {},
      eventSignupMessageIds: parsedState.eventSignupMessageIds ?? {},
      eventCalendarMessageIds: restoreEventCalendarMessageIds(
        parsedState.eventCalendarMessageIds,
      ),
      eventCalendarFingerprints: parsedState.eventCalendarFingerprints ?? {},
      pendingAnnounces: parsedState.pendingAnnounces ?? parsedState.failedAnnounces ?? {},
      eventSignupRevisions: parsedState.eventSignupRevisions ?? {},
      splitUpdatedAt: parsedState.splitUpdatedAt ?? null,
      splitAfterId: parsedState.splitAfterId ?? null,
      massedEvents: parsedState.massedEvents ?? [],
      emptyLiveChecks: parsedState.emptyLiveChecks ?? {},
      occupiedLiveEvents: parsedState.occupiedLiveEvents ?? [],
      // Old checkpoints start the sweep interval from now, avoiding a tenant
      // herd of channel-list/delete requests immediately after bot restart.
      lastVoiceSweepAt: parsedState.lastVoiceSweepAt ?? Date.now(),
      applicationsOpen: parsedState.applicationsOpen,
      lastGiveawayId: parsedState.lastGiveawayId ?? 0,
      postedGiveawayIds: parsedState.postedGiveawayIds ?? [],
      announcedGiveawayDraws: parsedState.announcedGiveawayDraws ?? [],
      // A file written before this flag existed already holds real checkpoints,
      // so it is initialized. Treating it as fresh would re-seed the cursors to
      // "now" and silently swallow anything created while the bot was down.
      initialized: parsedState.initialized ?? true,
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
 * saveState("/app/data", "poller-state-1.json", { lastEventId: 42, lastBattleId: 7 });
 * ```
 */
function saveState(stateDirectory: string, fileName: string, state: PollerState): void {
  ensureStateDirectory(stateDirectory);
  writeFileSync(
    join(stateDirectory, fileName),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

/**
 * Polling service that checks for new events and battles and posts them
 * to the configured Discord channels.
 *
 * One instance per tenant guild. `api` must already be stamped with that
 * guild's `X-Guild-Id` (see {@link ApiClient.withGuild}) and `settings` must be
 * the matching per-guild service — the backend resolves every request against
 * that header and rejects an unscoped one with a 400, because no tenant
 * database is bound to it.
 */
export class Poller {
  /** Guild this poller announces for, taken from the scoped `api`. */
  readonly guildId: string;
  private readonly stateDirectory: string;
  private readonly stateFileName: string;
  private readonly state: PollerState;
  private timer: NodeJS.Timeout | undefined;
  private delayedPollTimer: NodeJS.Timeout | undefined;
  private delayedPollAt = 0;
  /** Guards against a manually-triggered check overlapping a scheduled one —
   *  both would otherwise read the same stale `lastEventId`/`lastBattleId`
   *  and could announce the same event or battle twice. */
  private polling = false;
  /** Serializes scheduled and manual calendar writes without sharing API identities. */
  private calendarSyncQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly settings: SettingsService,
    private readonly intervalMs: number,
    stateDirectory: string = config.POLLER_STATE_DIR,
  ) {
    if (!api.guildId) {
      throw new Error("A Poller needs a guild-scoped ApiClient — call api.withGuild(guildId).");
    }
    this.guildId = api.guildId;
    this.stateDirectory = stateDirectory;
    this.stateFileName = stateFileName(this.guildId);
    this.state = loadState(this.stateDirectory, this.stateFileName);
    console.log(
      `[Poller] Starting for guild ${this.guildId} — last event ID: ${this.state.lastEventId}, last battle ID: ${this.state.lastBattleId}`,
    );
  }

  private save(): void {
    saveState(this.stateDirectory, this.stateFileName, this.state);
  }

  /** Reads unified routes, with a test/rolling-deploy fallback to the old accessors. */
  private async loadEventChannelRoutes(): Promise<{
    events: string | null;
    callToArms: string | null;
    flashMass: string | null;
  }> {
    const settings = this.settings as SettingsService & {
      eventChannelRoutes?: () => Promise<{
        events: string | null;
        callToArms: string | null;
        flashMass: string | null;
      }>;
      flashMassChannelId?: () => Promise<string | null>;
    };
    if (settings.eventChannelRoutes) {
      return settings.eventChannelRoutes();
    }
    const [events, callToArms, flashMass] = await Promise.all([
      settings.eventsChannelId(),
      settings.callToArmsChannelId(),
      settings.flashMassChannelId?.() ?? Promise.resolve(null),
    ]);
    return { events, callToArms, flashMass };
  }

  /** Start the polling loop. */
  start(): void {
    // Seeding runs before the first real cycle so a command that asks for an
    // immediate poll (`/event-create` calls `pollNow`) never lands on an
    // unseeded poller: the event it just created would be folded into the
    // baseline and never announced. `poll` keeps its own guard for the case
    // where this first attempt fails and has to be retried on a later tick.
    void (async () => {
      if (!this.state.initialized) {
        await this.adoptCheckpointBaseline();
      }
      await this.poll();
    })();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.delayedPollTimer) clearTimeout(this.delayedPollTimer);
    this.delayedPollTimer = undefined;
    this.delayedPollAt = 0;
  }

  /** Schedules a one-off poll without creating one timer per pending flash mass. */
  private schedulePollAfter(delayMs: number): void {
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this.delayedPollTimer && dueAt >= this.delayedPollAt) return;
    if (this.delayedPollTimer) clearTimeout(this.delayedPollTimer);

    this.delayedPollAt = dueAt;
    this.delayedPollTimer = setTimeout(() => {
      this.delayedPollTimer = undefined;
      this.delayedPollAt = 0;
      void this.poll();
    }, Math.max(0, dueAt - Date.now()));
    this.delayedPollTimer.unref();
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
      if (!this.state.initialized) {
        await this.adoptCheckpointBaseline();
        return;
      }
      await this.checkApplicationStatus();
      // Event announcements must complete before checking reminders so a newly
      // created event already has its discussion thread recorded.
      await this.checkNewEvents();
      const revisions = await this.loadEventRevisions();
      await this.checkClosedEvents(revisions);
      await this.checkEventRosterSync(revisions);
      await this.updateEventCalendars();
      await this.checkNewGiveaways();
      await this.checkGiveawayResults();
      await this.checkEventLifecycle();
      await this.sweepOrphanEventVoiceChannels();
      await Promise.allSettled([
        this.checkNewBattles(),
        this.checkUpcomingEvents(),
        this.checkSplitSync(),
      ]);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Seeds every announcement cursor from the live API and sends nothing.
   *
   * Runs once, on the first poll of a guild that has no usable checkpoint file.
   * Announcements are only ever meant to fire for something created while the
   * bot is watching; anything that already exists when the bot first looks has
   * had its chance and must stay silent. Cursors start at zero, so without this
   * the first poll would read the whole first page as new and replay the
   * backlog into Discord.
   *
   * This cycle deliberately returns before any other check: the point is that a
   * restart onto an empty state directory produces no messages at all, not
   * fewer messages. Normal polling resumes on the next tick.
   */
  private async adoptCheckpointBaseline(): Promise<void> {
    try {
      const [events, battles, giveaways] = await Promise.all([
        this.api
          .get<PaginatedData<EventView>>("api/events", undefined, {
            page: 1,
            limit: 50,
            sort: "created_at",
            order: "desc",
          })
          .catch(() => ({ items: [] as EventView[] })),
        this.api
          .get<PaginatedData<BattleSummary>>("api/battles", undefined, {
            page: 1,
            limit: 10,
          })
          .catch(() => ({ items: [] as BattleSummary[] })),
        this.api
          .get<PaginatedData<GiveawayView>>("api/giveaways", undefined, {
            page: 1,
            limit: 50,
          })
          .catch(() => ({ items: [] as GiveawayView[] })),
      ]);

      this.state.lastEventId = events.items.reduce(
        (max, event) => Math.max(max, event.id),
        this.state.lastEventId,
      );
      this.state.lastBattleId = battles.items.reduce(
        (max, battle) => Math.max(max, battle.battle_id),
        this.state.lastBattleId,
      );
      this.state.lastGiveawayId = giveaways.items.reduce(
        (max, giveaway) => Math.max(max, giveaway.id),
        this.state.lastGiveawayId,
      );
      // The application panel announces transitions, not a current value, so
      // recording the current one here keeps the first real change as the first
      // message rather than announcing the status the bot booted into.
      this.state.applicationsOpen = await this.settings
        .applicationsSettings()
        .then((settings) => settings.discord_applications_open)
        .catch(() => this.state.applicationsOpen);

      this.state.initialized = true;
      this.save();
      console.log(
        `[Poller] Seeded checkpoints for guild ${this.guildId} without announcing — event #${this.state.lastEventId}, battle #${this.state.lastBattleId}, giveaway #${this.state.lastGiveawayId}`,
      );
    } catch (error) {
      // Leave the state uninitialized so the next tick retries. Announcing from
      // a zeroed cursor would be worse than waiting.
      console.error(
        `[Poller] Could not seed checkpoints for guild ${this.guildId}; staying silent until it succeeds:`,
        error,
      );
    }
  }

  /** Announces only real application availability transitions. */
  private async checkApplicationStatus(): Promise<void> {
    try {
      const settings = await this.settings.applicationsSettings();
      const previous = this.state.applicationsOpen;
      this.state.applicationsOpen = settings.discord_applications_open;
      if (previous === undefined || previous === settings.discord_applications_open) return;
      await this.updateApplicationPanel(settings);
      const channelId = settings.discord_applications_status_channel_id;
      if (!channelId) {
        console.warn('[Poller] Application status changed but no status channel is configured');
        return;
      }
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased()) return;
      await channel.send(buildApplicationStatusAnnouncement(settings));
      this.save();
    } catch (error) {
      console.warn('[Poller] Could not announce application status:', error);
    }
  }

  private async updateApplicationPanel(settings: import('../api/types.js').GuildSettingsView): Promise<void> {
    const channelId = settings.discord_applications_channel_id;
    const messageId = settings.discord_applications_panel_message_id;
    if (!channelId || !messageId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased() || !('messages' in channel)) return;
      const message = await channel.messages.fetch(messageId);
      // Clearing embeds is required when converting a legacy panel to
      // Components V2; Discord rejects an edit that leaves the old embed in
      // place while setting IS_COMPONENTS_V2.
      await message.edit({
        ...buildApplicationPanelMessage(settings),
        embeds: [],
      });
    } catch (error) {
      console.warn('[Poller] Could not update application panel:', error);
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
        // The checkpoint points at an event id that no longer sorts to the top of the
        // API window — almost always because that event (or a newer one) was deleted,
        // not because the database was wiped. Resetting to 0 here used to treat every
        // event in the current page as "new" and mass re-announce up to 50 old events
        // (and re-open their threads) on the very next poll. Clamp to the current max
        // instead: every event id at or below it has already had its chance to be
        // announced, so this converges to "nothing new" rather than "everything is
        // new". Only a genuine full database reset would need the checkpoint file
        // cleared by hand.
        console.warn(
          `[Poller] Event checkpoint ${this.state.lastEventId} is ahead of the newest known event (${newestEventId}); clamping instead of resetting to avoid re-announcing old events`,
        );
        this.state.lastEventId = newestEventId;
        this.save();
      }

      const newEvents = result.items
        .filter((e) => e.id > this.state.lastEventId)
        .sort((a, b) => a.id - b.id);

      if (newEvents.length === 0 && Object.keys(this.state.pendingAnnounces).length === 0) {
        return;
      }

      // An announcement belongs to the moment an event is created and to nothing
      // else. Anything already started, stopped, cancelled or archived by the
      // time the bot sees it is history: announcing it would put a call to arms
      // in the channel for a mass that is already over. Their ids still advance
      // the checkpoint so they are never reconsidered.
      const announceable = newEvents.filter(
        (event) => event.status === "scheduled" && !event.archived_at,
      );

      const routes = await this.loadEventChannelRoutes();

      // Pending announcements are retried before the new batch, so a held or
      // stuck event never blocks later ones and never gets silently dropped.
      for (const eventId of Object.keys(this.state.pendingAnnounces)) {
        let eventView: EventView | undefined = announceable.find(
          (event) => String(event.id) === eventId,
        );
        if (!eventView) {
          try {
            eventView = await this.api.get<EventView>(`api/events/${eventId}`);
          } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
              // The event is gone (deleted) — nothing left to announce.
              delete this.state.pendingAnnounces[eventId];
              this.save();
            } else {
              console.warn(
                `[Poller] announce_result=retry_deferred guild=${this.guildId} event=${eventId} stage=lookup error=${String(error)}`,
              );
            }
            continue;
          }
        }
        if (
          eventView.status !== "scheduled" ||
          eventView.archived_at ||
          this.state.eventThreadIds[String(eventView.id)]
        ) {
          delete this.state.pendingAnnounces[eventId];
          this.save();
          continue;
        }
        await this.announceEvent(eventView, routes);
      }

      for (const event of announceable) {
        // Idempotence claim: an event that already has a thread recorded has
        // been announced, whatever happened to `lastEventId`.
        if (this.state.eventThreadIds[String(event.id)]) {
          continue;
        }
        await this.announceEvent(event, routes);
      }

      const newestProcessed = newEvents[newEvents.length - 1]?.id;
      if (newestProcessed && newestProcessed > this.state.lastEventId) {
        this.state.lastEventId = newestProcessed;
        this.save();
      }
    } catch (err) {
      console.error("[Poller] Failed to check events:", err);
    }
  }

  /**
   * Announces one event and records the outcome honestly.
   *
   * Success means a Discord thread exists and is recorded in the checkpoint;
   * anything else is a failure that lands in `pendingAnnounces` with a
   * structured line (guild, event, stage, result) — "Announced" is never
   * logged unless the ping actually went out, and a missing channel or a
   * thread rejection never swallows the event: the next poll retries it.
   */
  private async announceEvent(event: EventView, routes: {
    events: string | null;
    callToArms: string | null;
    flashMass: string | null;
  }): Promise<void> {
    const eventKey = String(event.id);
    const fail = (stage: string, lastError: string) => {
      const previous = this.state.pendingAnnounces[eventKey];
      this.state.pendingAnnounces[eventKey] = {
        attempts: (previous?.attempts ?? 0) + 1,
        lastError,
        since: previous?.since ?? new Date().toISOString(),
        status: "failed",
      };
      this.save();
      console.warn(
        `[Poller] announce_result=failed stage=${stage} guild=${this.guildId} event=${event.id} attempts=${this.state.pendingAnnounces[eventKey]!.attempts} error=${lastError}`,
      );
    };

    try {
      const undoRemaining = flashUndoTimeRemaining(event);
      if (undoRemaining > 0) {
        const previous = this.state.pendingAnnounces[eventKey];
        const undoUntil = new Date(Date.parse(event.created_at) + FLASH_UNDO_WINDOW_MS);
        this.state.pendingAnnounces[eventKey] = {
          attempts: previous?.attempts ?? 0,
          lastError: `flash undo window open until ${undoUntil.toISOString()}`,
          since: previous?.since ?? new Date().toISOString(),
          status: "undo_window",
        };
        this.save();
        this.schedulePollAfter(undoRemaining);
        console.info(
          `[Poller] announce_result=pending stage=undo_window guild=${this.guildId} event=${event.id} remaining_ms=${undoRemaining}`,
        );
        return;
      }

      // Fetch the detail before resolving the guild channel so an alliance
      // announcement does not depend on the originating guild having its
      // own event channel configured. The alliance channel is a separate
      // delivery target and should still receive the event when the guild
      // announcement cannot be sent.
      const eventDetail = await this.api.get<EventDetailView>(`api/events/${event.id}`);
      await this.postAllianceAnnouncement(eventDetail);

      const label = destinationChannelLabel(event);
      const channelId = destinationChannel(event, routes);
      if (!channelId) {
        // `continue`-per-event, never a mid-batch `return`: one missing
        // channel must not freeze announcements for every later event.
        fail(
          "route",
          `no ${label} channel is configured (Admin → Discord integration)`,
        );
        return;
      }
      const channel = await this.getTextChannel(channelId);
      if (!channel) {
        fail("channel", `${label} channel ${channelId} is missing or not a text channel`);
        return;
      }

      // Flash needs a visible role ping in the channel before the discussion
      // thread. Reuse the saved parent message on retry so a failed thread
      // creation never repeats the role-wide ping.
      let thread: ThreadChannel | null;
      if (event.event_kind === "flash") {
        let parent: Message | null = null;
        const savedParentId = this.state.eventParentMessageIds[eventKey];
        if (savedParentId) {
          try {
            parent = await channel.messages.fetch(savedParentId);
          } catch (error) {
            if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) {
              fail("parent_fetch", `could not fetch saved flash announcement ${savedParentId}`);
              return;
            }
            delete this.state.eventParentMessageIds[eventKey];
          }
        }
        if (!parent) {
          parent = await channel.send(buildEventAnnouncementMessage(eventDetail));
          this.state.eventParentMessageIds[eventKey] = parent.id;
          this.save();
        }
        thread = await createEventAnnouncementThread(parent, eventDetail, "Poller");
      } else {
        // Organized events preserve the current standalone-thread behavior.
        thread = await createStandaloneEventThread(channel, eventDetail, "Poller");
      }
      if (!thread) {
        fail("thread", "Discord rejected the discussion thread creation");
        return;
      }
      this.state.eventThreadIds[eventKey] = thread.id;
      const signupMessageId = await sendEventSignupMessage(thread, eventDetail, "Poller");
      if (signupMessageId) {
        this.state.eventSignupMessageIds[eventKey] = signupMessageId;
      } else {
        // The thread exists and is recorded, so the ping went out; only the
        // interactive card is missing. Degraded, not failed — logged so the
        // gap is visible without a retry loop that would duplicate the thread.
        console.warn(
          `[Poller] announce_result=degraded stage=signup guild=${this.guildId} event=${event.id} error=signup card was not posted`,
        );
      }
      this.state.eventSignupRevisions[eventKey] =
        `${eventDetail.roster_version ?? 0}:${eventDetail.status}`;

      delete this.state.pendingAnnounces[eventKey];
      this.save();
      console.log(
        `[Poller] announce_result=success guild=${this.guildId} event=${event.id} kind=${event.event_kind} thread=${thread.id} — ${event.title}`,
      );
    } catch (error) {
      fail("unexpected", error instanceof Error ? error.message : String(error));
    }
  }

  /** Keeps editable event calendar pages in each configured announcement channel. */
  private async updateEventCalendars(): Promise<void> {
    try {
      const result = await this.syncEventCalendars();
      for (const failure of result.failedChannels) {
        console.warn(
          `[Poller] Could not update the event calendar in channel ${failure.channelId}: ${failure.reason}`,
        );
      }
      if (result.unroutedEvents > 0) {
        console.warn(
          `[Poller] ${result.unroutedEvents} standard event(s) have no events channel configured`,
        );
      }
      if (result.unroutedCallToArms > 0) {
        console.warn(
          `[Poller] ${result.unroutedCallToArms} Call to Arms event(s) have no CTA channel configured`,
        );
      }
    } catch (error) {
      console.warn(`[Poller] Could not update event calendars for guild ${this.guildId}:`, error);
    }
  }

  /** Refreshes the event calendars on demand, using the caller's backend permissions. */
  async refreshEventCalendars(discordUserId: string): Promise<EventCalendarRefreshResult> {
    return this.syncEventCalendars(discordUserId);
  }

  private async syncEventCalendars(
    discordUserId?: string,
  ): Promise<EventCalendarRefreshResult> {
    const sync = this.calendarSyncQueue.then(() =>
      this.performEventCalendarSync(discordUserId),
    );
    this.calendarSyncQueue = sync.then(
      () => undefined,
      () => undefined,
    );
    return sync;
  }

  private async performEventCalendarSync(
    discordUserId?: string,
  ): Promise<EventCalendarRefreshResult> {
    const routes = await this.loadEventChannelRoutes();
    const configuredChannelIds = calendarChannelIds(routes);
    if (configuredChannelIds.length === 0 && !discordUserId) {
      return {
        eventCount: 0,
        configuredChannels: 0,
        updatedChannels: [],
        failedChannels: [],
        unroutedEvents: 0,
        unroutedCallToArms: 0,
      };
    }

    const events = await this.api.get<EventView[]>("api/events/calendar", discordUserId);
    const channels = new Map<string, EventView[]>();
    let unroutedEvents = 0;
    let unroutedCallToArms = 0;
    for (const event of events) {
      if (flashUndoTimeRemaining(event) > 0) continue;
      const channelId = destinationChannel(event, routes);
      if (!channelId) {
        if (event.event_kind === 'flash') {
          console.warn(
            `[Poller] Flash mass #${event.id} has no flash mass channel configured (Admin → Discord integration)`,
          );
        } else if (event.call_to_arms) {
          unroutedCallToArms++;
        } else {
          unroutedEvents++;
        }
        continue;
      }
      channels.set(channelId, [...(channels.get(channelId) ?? []), event]);
    }

    const updatedChannels: string[] = [];
    const failedChannels: EventCalendarChannelFailure[] = [];
    for (const channelId of configuredChannelIds) {
      try {
        const channel = await this.getTextChannel(channelId);
        if (!channel) {
          throw new Error("The configured channel is missing or is not a text channel.");
        }
        // Adapter doubles without a thread manager cannot represent the persistent calendar.
        if (!channel.threads?.create) {
          if (!discordUserId) continue;
          throw new Error("The configured channel cannot host the event discussion threads.");
        }

        const channelEvents = channels.get(channelId) ?? [];
        // The flash channel gets its own panel so the two calendars are
        // distinguishable at a glance; organized channels keep the classic one.
        const locale = this.client.guilds?.cache?.get(this.guildId)?.preferredLocale;
        const payloads =
          channelId === routes.flashMass
            ? buildEventCalendarMessages(channelEvents, this.state.eventThreadIds, {
                heading: flashCopy(locale, "flashCalendarHeading"),
                subtitle: flashCopy(locale, "flashCalendarSubtitle"),
                locale: locale ?? undefined,
              })
            : buildEventCalendarMessages(channelEvents, this.state.eventThreadIds);
        const messageIds = [...(this.state.eventCalendarMessageIds[channelId] ?? [])];
        const fingerprints = [...(this.state.eventCalendarFingerprints[channelId] ?? [])];
        for (const [pageIndex, payload] of payloads.entries()) {
          const fingerprint = JSON.stringify({
            flags: payload.flags,
            components: payload.components.map((component) => component.toJSON()),
            allowedMentions: payload.allowedMentions,
          });
          const messageId = messageIds[pageIndex];
          let message: Message | undefined;
          if (messageId) {
            try {
              message = await channel.messages.fetch(messageId);
            } catch (error) {
              if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) {
                throw new Error("The saved calendar message could not be fetched.", { cause: error });
              }
            }
          }
          if (!message) {
            message = await channel.send(payload);
            messageIds[pageIndex] = message.id;
            fingerprints[pageIndex] = fingerprint;
            this.state.eventCalendarMessageIds[channelId] = messageIds;
            this.state.eventCalendarFingerprints[channelId] = fingerprints;
            this.save();
          } else if (fingerprints[pageIndex] === fingerprint) {
            // The calendar content did not change. Fetching above still detects
            // a manually deleted panel, but avoiding an identical edit cuts the
            // per-route Discord write rate substantially across tenants.
            continue;
          } else {
            // Clearing embeds is required when converting an older calendar panel to Components V2.
            try {
              await message.edit({ ...payload, embeds: [] });
              fingerprints[pageIndex] = fingerprint;
            } catch (error) {
              if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) throw error;
              message = await channel.send(payload);
              messageIds[pageIndex] = message.id;
              fingerprints[pageIndex] = fingerprint;
              this.state.eventCalendarMessageIds[channelId] = messageIds;
              this.state.eventCalendarFingerprints[channelId] = fingerprints;
              this.save();
            }
          }
        }
        for (const messageId of messageIds.slice(payloads.length)) {
          try {
            const staleMessage = await channel.messages.fetch(messageId);
            await staleMessage.delete();
          } catch (error) {
            if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) {
              throw new Error("An obsolete calendar page could not be deleted.", { cause: error });
            }
          }
        }
        this.state.eventCalendarMessageIds[channelId] = messageIds.slice(0, payloads.length);
        this.state.eventCalendarFingerprints[channelId] = fingerprints.slice(0, payloads.length);
        this.save();
        updatedChannels.push(channelId);
      } catch (error) {
        failedChannels.push({
          channelId,
          reason: this.eventCalendarFailureReason(error),
        });
        console.warn(`[Poller] Could not update event calendar in channel ${channelId}:`, error);
      }
    }

    this.save();
    return {
      eventCount: events.length,
      configuredChannels: configuredChannelIds.length,
      updatedChannels,
      failedChannels,
      unroutedEvents,
      unroutedCallToArms,
    };
  }

  private eventCalendarFailureReason(error: unknown): string {
    const cause = error instanceof Error && "cause" in error ? error.cause : error;
    if (cause instanceof RangeError) return cause.message;
    const code = discordErrorCode(cause);
    if (code === DISCORD_MISSING_PERMISSIONS) {
      return "The bot is missing a Discord permission required to refresh this channel's calendar.";
    }
    if (code === 10003) {
      return "The configured channel no longer exists.";
    }
    if (
      error instanceof Error &&
      (error.message === "The configured channel is missing or is not a text channel." ||
        error.message === "The configured channel cannot host the event discussion threads." ||
        error.message === "The saved calendar message could not be fetched." ||
        error.message === "An obsolete calendar page could not be deleted.")
    ) {
      return error.message;
    }
    return "Discord rejected the calendar update. Check the bot's channel access and logs.";
  }

  /** Closes a known event discussion thread immediately after a Discord stop command. */
  async closeEventThread(
    eventId: number,
    options: { keepMapping?: boolean } = {},
  ): Promise<boolean> {
    return this.finishEventThread(eventId, closeEventAnnouncementThread, "close", options);
  }

  /** Deletes the parent announcement when an event is archived from the website. */
  async deleteEventThread(eventId: number): Promise<boolean> {
    return this.finishEventThread(eventId, deleteEventAnnouncement, "delete");
  }

  /**
   * Remembers a discussion thread so a cancelled event can be reopened later.
   *
   * Discord cancel used to drop the mapping as soon as the thread closed, which
   * made website restore a no-op on Discord: the poller no longer knew which
   * thread to unarchive.
   */
  rememberEventThread(
    eventId: number,
    threadId: string,
    signupMessageId?: string | null,
    revision?: string | null,
  ): void {
    this.state.eventThreadIds[String(eventId)] = threadId;
    if (signupMessageId) {
      this.state.eventSignupMessageIds[String(eventId)] = signupMessageId;
    }
    if (revision) {
      this.state.eventSignupRevisions[String(eventId)] = revision;
    }
    this.save();
  }

  private async finishEventThread(
    eventId: number,
    finish: typeof closeEventAnnouncementThread,
    action: "close" | "delete",
    options: { keepMapping?: boolean } = {},
  ): Promise<boolean> {
    const threadId = this.state.eventThreadIds[String(eventId)];
    if (!threadId) return false;

    try {
      const channel = await this.client.channels.fetch(threadId);
      if (!channel?.isThread()) {
        this.forgetEventThread(eventId);
        return true;
      }
      const done = await finish(channel, eventId, "Poller");
      if (done && !options.keepMapping) this.forgetEventThread(eventId);
      return done;
    } catch (error) {
      if (isUnknownDiscordChannel(error)) {
        console.warn(
          `[Poller] Discord thread for event #${eventId} is gone; dropping mapping`,
        );
        this.forgetEventThread(eventId);
        return true;
      }
      console.warn(`[Poller] Could not ${action} event thread for #${eventId}:`, error);
      return false;
    }
  }

  /**
   * One cheap fingerprint query for every known event thread.
   * `null` means the request failed and callers must not treat missing ids as deleted.
   */
  private async loadEventRevisions(): Promise<Map<string, EventRevision> | null> {
    const ids = Object.keys(this.state.eventThreadIds);
    if (ids.length === 0) return new Map();
    try {
      const items = await this.api.get<EventRevision[]>("api/events/revisions", undefined, {
        ids: ids.join(","),
      });
      return new Map((items ?? []).map((item) => [String(item.id), item]));
    } catch (error) {
      console.warn("[Poller] Could not load event revisions:", error);
      return null;
    }
  }

  /** Closes persisted event discussion threads when the backend event reaches a terminal status. */
  private async checkClosedEvents(
    revisions: Map<string, EventRevision> | null,
  ): Promise<void> {
    if (!revisions) return;
    const terminalStatuses = new Set(["stopped", "auto_stopped", "cancelled"]);
    for (const [eventId, threadId] of Object.entries(this.state.eventThreadIds)) {
      try {
        const event = revisions.get(eventId);
        if (!event) {
          // The backend record is gone (deleted event). Close leftover Discord
          // state once, then drop the mapping so the next poll does not 404 forever.
          console.warn(
            `[Poller] Event #${eventId} no longer exists; closing leftover Discord thread`,
          );
          await this.closeEventThread(Number(eventId));
          this.forgetEventThread(eventId);
          continue;
        }
        if (event.archived_at) {
          if (threadId) await this.deleteEventThread(event.id);
          continue;
        }
        if (event.status === "cancelled") {
          await this.closeCancelledEvent(event, threadId);
          continue;
        }
        if (!terminalStatuses.has(event.status)) continue;

        if (threadId) await this.closeEventThread(event.id);
      } catch (error) {
        // Keep the mapping so a temporary Discord/API failure is retried on the next poll.
        console.warn(`[Poller] Could not close event thread for #${eventId}:`, error);
      }
    }
  }

  /**
   * Locks a cancelled event thread without forgetting it, so restore can reopen it.
   *
   * An already-archived thread means Discord cancel already closed it; skip the
   * alliance ping so a kept mapping does not re-announce cancellation every poll.
   */
  private async closeCancelledEvent(event: EventRevision, threadId: string | undefined): Promise<void> {
    const eventId = event.id;
    const thread = threadId ? await this.getEventThread(eventId) : null;
    if (!thread) {
      this.forgetEventThread(eventId);
      return;
    }
    if (thread.archived) {
      // Discord cancel already closed it. Stamp cancelled so a later restore is a
      // revision change and roster sync will unarchive the thread.
      this.state.eventSignupRevisions[String(eventId)] =
        `${event.roster_version}:${event.status}`;
      this.save();
      return;
    }

    try {
      const detail = await this.eventApi().get<EventDetailView>(`api/events/${eventId}`);
      await this.postAllianceLifecycle(detail, "cancel");
      const messageId = await refreshEventSignupCard(
        thread,
        detail,
        "Poller",
        this.state.eventSignupMessageIds[String(eventId)],
      );
      if (messageId) {
        this.state.eventSignupMessageIds[String(eventId)] = messageId;
        this.state.eventSignupRevisions[String(eventId)] =
          `${detail.roster_version ?? 0}:${detail.status}`;
        this.save();
      }
    } catch (error) {
      console.warn(`[Poller] Could not ping alliance Discord for cancelled event #${eventId}:`, error);
    }
    await this.closeEventThread(eventId, { keepMapping: true });
  }

  private forgetEventThread(eventId: number | string): void {
    const key = String(eventId);
    if (
      !(key in this.state.eventThreadIds) &&
      !(key in this.state.eventSignupMessageIds) &&
      !(key in this.state.eventParentMessageIds) &&
      !(key in this.state.pendingAnnounces)
    ) return;
    delete this.state.eventThreadIds[key];
    delete this.state.eventParentMessageIds[key];
    delete this.state.eventSignupMessageIds[key];
    delete this.state.eventSignupRevisions[key];
    delete this.state.pendingAnnounces[key];
    this.save();
  }

  /**
   * Rewrites each known event signup card when the website roster or status changes,
   * and refreshes any loot-split Forum post linked to that event.
   */
  private async checkEventRosterSync(
    revisions: Map<string, EventRevision> | null,
  ): Promise<void> {
    if (!revisions) return;
    const eventIds = Object.keys(this.state.eventThreadIds);
    if (eventIds.length === 0) return;

    let adapter: SplitForumAdapter | null = null;
    try {
      const forumChannelId = await this.settings.splitsForumChannelId();
      if (forumChannelId) {
        adapter = new SplitForumAdapter(this.client, this.api, forumChannelId);
      }
    } catch (error) {
      console.warn("[Poller] Could not resolve splits Forum channel for roster sync:", error);
    }

    for (const eventId of eventIds) {
      const fingerprint = revisions.get(eventId);
      if (!fingerprint) continue;
      // Cancelled/stopped threads stay locked history. Refreshing them would
      // unarchive the card on every roster bump; restore is the only reopen path.
      if (
        fingerprint.status === "stopped"
        || fingerprint.status === "auto_stopped"
        || fingerprint.status === "cancelled"
      ) {
        continue;
      }
      const revision = `${fingerprint.roster_version}:${fingerprint.status}`;
      if (this.state.eventSignupRevisions[eventId] === revision) continue;
      try {
        const detail = await this.api.get<EventDetailView>(`api/events/${eventId}`);

        const thread = await this.getEventThread(Number(eventId));
        if (!thread) continue;

        const messageId = await refreshEventSignupCard(
          thread,
          detail,
          "Poller",
          this.state.eventSignupMessageIds[eventId],
        );
        if (!messageId) continue;
        this.state.eventSignupMessageIds[eventId] = messageId;
        this.state.eventSignupRevisions[eventId] = revision;
        this.save();

        if (!adapter || !detail.splits?.length) continue;
        for (const split of detail.splits) {
          try {
            const item = await this.api.get<SplitDiscordSync>(
              `api/splits/${split.id}/discord-sync`,
            );
            await adapter.sync(item);
          } catch (error) {
            console.warn(
              `[Poller] Could not refresh linked split #${split.id} for event #${eventId}:`,
              error,
            );
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          await this.closeEventThread(Number(eventId));
          continue;
        }
        console.warn(`[Poller] Could not sync Discord roster for event #${eventId}:`, error);
      }
    }
  }

  /** Executes Mass and Start automatically, then auto-stops live events after occupied voice goes empty. */
  private async checkEventLifecycle(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<EventView>>("api/events", undefined, { page: 1, limit: 50 });
      const now = Date.now();
      for (const event of result.items) {
        if (event.status === "scheduled") {
          const massAt = new Date(event.mass_time_utc ?? event.event_date_utc).getTime();
          if (Number.isFinite(massAt) && now >= massAt && !this.state.massedEvents.includes(event.id)) {
            try {
              const thread = await this.getEventThread(event.id);
              const massed = await massDiscordEvent(this.client, this.api, "", event.id, thread ?? undefined);
              await this.postAllianceLifecycle(massed.event, "mass");
              this.state.massedEvents.push(event.id);
              this.save();
            } catch (error) {
              console.warn(`[Poller] Could not mass event #${event.id}:`, error);
            }
          }
          const startAt = new Date(event.start_time_utc ?? event.event_date_utc).getTime();
          if (Number.isFinite(startAt) && now >= startAt) {
            try {
              const thread = await this.getEventThread(event.id);
              const started = await startDiscordEvent(this.client, this.api, "", event.id, thread ?? undefined);
              await this.postAllianceLifecycle(started.event, "start");
              this.save();
            } catch (error) {
              console.warn(`[Poller] Could not start event #${event.id}:`, error);
            }
          }
          continue;
        }
        if (event.status !== "live" || !event.discord_voice_channel_id) {
          this.forgetLiveVoiceWatch(event.id);
          continue;
        }
        try {
          const channel = await this.client.channels.fetch(event.discord_voice_channel_id);
          const key = String(event.id);
          if (!channel?.isVoiceBased()) {
            delete this.state.emptyLiveChecks[key];
            continue;
          }
          const seenOccupied = this.state.occupiedLiveEvents.includes(event.id);
          const next = nextEmptyLiveVoiceCheck(
            this.state.emptyLiveChecks[key] ?? 0,
            voiceChannelOccupantCount(channel),
            seenOccupied,
          );
          if (next.seenOccupied && !seenOccupied) {
            this.state.occupiedLiveEvents.push(event.id);
          }
          this.state.emptyLiveChecks[key] = next.emptyTicks;
          if (next.shouldStop) {
            await stopDiscordEvent(this.client, this.api, "", event.id);
            await this.closeEventThread(event.id);
            this.forgetLiveVoiceWatch(event.id);
          }
          this.save();
        } catch (error) {
          console.warn(`[Poller] Could not inspect live event #${event.id}:`, error);
        }
      }
    } catch (error) {
      console.error("[Poller] Failed to process event lifecycle:", error);
    }
  }

  /**
   * Removes old, empty voice channels created by the event lifecycle when their
   * event no longer needs them. Only channels with the bot's `Event <id> —`
   * name are considered; active scheduled/live bindings and occupied channels
   * are always preserved.
   */
  private async sweepOrphanEventVoiceChannels(): Promise<void> {
    if (Date.now() - this.state.lastVoiceSweepAt < VOICE_SWEEP_INTERVAL_MS) return;

    const startedAt = Date.now();
    let scanned = 0;
    let deleted = 0;
    let errors = 0;
    const settings = this.settings as SettingsService & {
      eventVoiceCategoryId?: () => Promise<string | null>;
    };

    try {
      const categoryId = await settings.eventVoiceCategoryId?.();
      if (!categoryId) return;

      const category = await this.client.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error("The configured event voice category is missing or is not a category.");
      }

      for (const channel of category.children.cache.values()) {
        if (!channel.isVoiceBased()) continue;
        const match = /^Event (\d+) —/.exec(channel.name);
        if (!match) continue;
        if (Date.now() - channel.createdTimestamp < VOICE_SWEEP_MIN_AGE_MS) continue;

        scanned++;
        if (voiceChannelOccupantCount(channel) > 0) continue;

        const eventId = Number(match[1]);
        let event: EventDetailView | null = null;
        try {
          event = await this.api.get<EventDetailView>(`api/events/${eventId}`);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) {
            errors++;
            console.warn(
              `[Poller] voice_sweep guild=${this.guildId} event=${eventId} result=lookup_failed error=${String(error)}`,
            );
            continue;
          }
        }

        if (
          event &&
          (event.status === "scheduled" || event.status === "live") &&
          event.discord_voice_channel_id === channel.id
        ) {
          continue;
        }

        if (event?.discord_voice_channel_id === channel.id) {
          try {
            await this.api.delete(`api/events/${eventId}/discord-voice-channel`);
          } catch (error) {
            errors++;
            console.warn(
              `[Poller] voice_sweep guild=${this.guildId} event=${eventId} result=binding_clear_failed error=${String(error)}`,
            );
            continue;
          }
        }

        try {
          await channel.delete(`Remove stale event voice channel for event #${eventId}`);
          deleted++;
        } catch (error) {
          errors++;
          console.warn(
            `[Poller] voice_sweep guild=${this.guildId} event=${eventId} result=delete_failed error=${String(error)}`,
          );
        }
      }
    } catch (error) {
      errors++;
      console.warn(`[Poller] voice_sweep guild=${this.guildId} result=failed error=${String(error)}`);
    } finally {
      this.state.lastVoiceSweepAt = Date.now();
      this.save();
      console.info(
        `[Poller] voice_sweep guild=${this.guildId} scanned=${scanned} deleted=${deleted} errors=${errors} duration_ms=${Date.now() - startedAt}`,
      );
    }
  }

  private forgetLiveVoiceWatch(eventId: number): void {
    delete this.state.emptyLiveChecks[String(eventId)];
    this.state.occupiedLiveEvents = this.state.occupiedLiveEvents.filter((id) => id !== eventId);
  }

  private async getEventThread(eventId: number): Promise<import("discord.js").ThreadChannel | null> {
    const threadId = this.state.eventThreadIds[String(eventId)];
    if (!threadId) return null;
    try {
      const channel = await this.client.channels.fetch(threadId);
      return channel?.isThread() ? channel : null;
    } catch {
      return null;
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
          this.save();
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
        await withUnarchivedThread(
          thread,
          `Event #${event.id} 1h warning`,
          (active) => active.send({
            content: `🚨 ${roleMentions} The event **${event.title}** starts in less than 1 hour! Get ready!`,
            allowedMentions: roleIds.length > 0 ? { roles: roleIds } : { parse: [] },
          }),
        );

        this.state.pinged1hEvents.push(event.id);
        this.save();
        console.log(`[Poller] Posted 1h warning in the thread for event #${event.id}`);
      }

      // Cleanup old pinged events (keep last 50)
      if (this.state.pinged1hEvents.length > 50) {
        this.state.pinged1hEvents = this.state.pinged1hEvents.slice(-50);
        const retainedEventIds = new Set(this.state.pinged1hEvents.map(String));
        this.state.eventThreadIds = Object.fromEntries(
          Object.entries(this.state.eventThreadIds).filter(([eventId]) => retainedEventIds.has(eventId)),
        );
        this.save();
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
        this.save();
        console.log(`[Poller] Announced battle #${battle.battle_id}`);
      }
    } catch (err) {
      console.error("[Poller] Failed to check battles:", err);
    }
  }

  /** Announces newly created giveaways into the configured channel. */
  private async checkNewGiveaways(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<GiveawayView>>(
        "api/giveaways",
        undefined,
        { page: 1, limit: 50, sort: "created_at", order: "desc" },
      );
      const newestId = result.items.reduce((max, item) => Math.max(max, item.id), 0);
      if (newestId > 0 && newestId < this.state.lastGiveawayId) {
        console.warn(
          `[Poller] Giveaway checkpoint ${this.state.lastGiveawayId} is ahead of the newest known giveaway (${newestId}); clamping`,
        );
        this.state.lastGiveawayId = newestId;
        this.save();
      }
      const newGiveaways = result.items
        .filter((item) => item.id > this.state.lastGiveawayId)
        .sort((a, b) => a.id - b.id);
      if (newGiveaways.length === 0) return;

      const channelId = await this.settings.giveawaysChannelId();
      const roleId = await this.settings.giveawaysRoleId();
      if (!channelId) {
        console.warn("[Poller] Cannot announce giveaways: no giveaways channel is configured");
        return;
      }
      const channel = await this.getTextChannel(channelId);
      if (!channel) return;

      for (const summary of newGiveaways) {
        const detail = await this.api.get<GiveawayDetailView>(`api/giveaways/${summary.id}`);
        const message = await channel.send(buildGiveawayAnnouncementMessage(detail, roleId));
        await this.api.put(
          `api/giveaways/${detail.id}/discord-message`,
          { message_id: message.id, channel_id: channel.id },
        );
        this.state.lastGiveawayId = detail.id;
        if (!this.state.postedGiveawayIds.includes(detail.id)) {
          this.state.postedGiveawayIds.push(detail.id);
        }
        this.save();
        console.log(`[Poller] Announced giveaway #${detail.id}: ${detail.title}`);
      }
    } catch (error) {
      console.error("[Poller] Failed to check giveaways:", error);
    }
  }

  /** Updates announced giveaway messages after a draw, cancel, or empty expiry. */
  private async checkGiveawayResults(): Promise<void> {
    const pending = this.state.postedGiveawayIds.filter(
      (id) => !this.state.announcedGiveawayDraws.includes(id),
    );
    for (const giveawayId of pending) {
      try {
        const detail = await this.api.get<GiveawayDetailView>(`api/giveaways/${giveawayId}`);
        if (detail.status === "open") continue;
        if (detail.discord_channel_id && detail.discord_message_id) {
          const channel = await this.getTextChannel(detail.discord_channel_id);
          const message = channel
            ? await channel.messages.fetch(detail.discord_message_id).catch(() => null)
            : null;
          if (message) {
            await message.edit({
              embeds: [buildGiveawayEmbed(detail)],
              components: [buildGiveawayActionRow(detail)],
            });
            if (detail.status === "drawn") {
              await channel?.send(buildGiveawayWinnerMessage(detail)).catch(() => undefined);
            }
          }
        }
        this.state.announcedGiveawayDraws.push(giveawayId);
        this.save();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          this.state.announcedGiveawayDraws.push(giveawayId);
          this.save();
          continue;
        }
        console.warn(`[Poller] Could not update giveaway #${giveawayId}:`, error);
      }
    }
  }

  private eventApi(event?: { origin_guild_id?: string | null }): ApiClient {
    const origin = event?.origin_guild_id?.trim();
    if (origin && origin !== this.api.guildId) {
      return this.api.withGuild(origin);
    }
    return this.api;
  }

  private async postAllianceAnnouncement(event: EventView): Promise<void> {
    if (!shouldPingAllianceDiscord(event)) return;
    // The originating guild announcement may fail after the alliance post
    // succeeds (for example, when its channel is not configured). The event
    // is retried on the next poll, so use the persisted message id as the
    // idempotency key and do not duplicate the alliance announcement.
    if (event.alliance_discord_message_id) return;
    const channel = await this.getTextChannel(event.alliance_discord_channel_id ?? null);
    if (!channel) {
      console.warn(
        `[Poller] Cannot announce event #${event.id} on alliance Discord: channel missing`,
      );
      return;
    }
    try {
      const message = await channel.send(
        buildEventAnnouncementMessage(withAlliancePingRoles(event)),
      );
      await this.eventApi(event).patch(`api/events/${event.id}`, {
        alliance_discord_message_id: message.id,
      });
      console.log(`[Poller] Announced event #${event.id} on alliance Discord`);
    } catch (error) {
      console.warn(`[Poller] Could not announce event #${event.id} on alliance Discord:`, error);
    }
  }

  private async postAllianceLifecycle(
    event: EventView,
    kind: AllianceLifecycleKind,
  ): Promise<void> {
    if (!shouldPingAllianceDiscord(event)) return;
    const channel = await this.getTextChannel(event.alliance_discord_channel_id ?? null);
    if (!channel) return;
    try {
      await channel.send(buildAllianceLifecycleMessage(event, kind));
    } catch (error) {
      console.warn(
        `[Poller] Could not post alliance ${kind} notice for event #${event.id}:`,
        error,
      );
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

const pollers = new Map<string, Poller>();

/** Registers a guild's `Poller`, replacing any previous one for that guild. */
export function registerPoller(poller: Poller): void {
  pollers.set(poller.guildId, poller);
}

/** Stops and forgets a guild's poller, e.g. when the bot leaves that server. */
export function unregisterPoller(guildId: string): void {
  const poller = pollers.get(guildId);
  if (!poller) return;
  poller.stop();
  pollers.delete(guildId);
}

/** Every registered poller, for shutdown. */
export function registeredPollers(): Poller[] {
  return [...pollers.values()];
}

/**
 * Returns the poller for one guild, or `null` when that guild has none yet — startup has not
 * reached it, or it is not a registered tenant. Callers that only want a best-effort immediate
 * check (like `/event-create`) should treat `null` as "the scheduled tick will pick it up
 * instead" rather than an error.
 */
export function getPoller(guildId: string | null | undefined): Poller | null {
  if (!guildId) return null;
  return pollers.get(guildId) ?? null;
}
