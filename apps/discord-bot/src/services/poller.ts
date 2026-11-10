import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client, ForumChannel, Message, TextChannel, ThreadChannel } from "discord.js";
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
  buildEventEmbed,
  buildEventThreadActionRows,
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
  addEventThreadMember,
  closeEventAnnouncementThread,
  createEventAnnouncementThread,
  createPrivateEventThread,
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
    { attempts: number; lastError: string; since: string; status?: "undo_window" | "failed" | "ambiguous" }
  >;
  /** One-release compatibility for checkpoints written before the queue was renamed. */
  failedAnnounces?: PollerState["pendingAnnounces"];
  /** Last Discord-synced roster/status/content revision per event. */
  eventSignupRevisions: Record<string, string>;
  /** Archived announcements deleted from Discord, retained to safely detect restore. */
  archivedEventIds: number[];
  /** Stable cursor over split (updated_at, id), persisted only after successful Forum sync. */
  splitUpdatedAt: string | null;
  splitAfterId: number | null;
  /**
   * Splits whose Forum sync failed after the cursor moved past them. They are
   * retried with backoff so one broken split never blocks the ones behind it.
   */
  splitRetries: Record<string, { attempts: number; nextAt: number }>;
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
  /** Giveaway messages sent to Discord whose backend `discord-message` PUT has not been acknowledged yet. */
  unackedGiveawayMessages: Record<string, { message_id: string; channel_id: string }>;
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
  /**
   * Optional modules whose list the backend refused (403) when the checkpoints
   * were seeded, because the tenant's rank does not include them. Their cursor
   * is still zero, so the first list the backend does answer is adopted as
   * history instead of being announced; see {@link Poller.adoptLateModule}.
   */
  unseededModules: OptionalModule[];
}

/** Modules the poller can announce from, other than events. */
type OptionalModule = "battles" | "giveaways";

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

/** Max ids per `api/events/revisions` request; the backend truncates longer lists. */
const EVENT_REVISION_CHUNK = 100;
/** Page size and bounds for scanning scheduled/live events. */
const EVENT_SCAN_PAGE_SIZE = 100;
/**
 * How far past its start a still-scheduled event may be before the lifecycle
 * stops acting on it. The scan walks all scheduled events oldest first, so
 * abandoned or test events that were never started would otherwise be massed
 * and started on the first tick, pinging roles for events nobody expects.
 */
const LIFECYCLE_MAX_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** Retry schedule for splits whose Forum sync failed. */
const SPLIT_RETRY_MAX_ATTEMPTS = 8;
const SPLIT_RETRY_BASE_MS = 60_000;
const SPLIT_RETRY_MAX_MS = 60 * 60_000;
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

/**
 * True for the backend's definite "this tenant does not have that module"
 * answer (the module is missing from its rank, or not offered to its kind).
 * Anything else - a 5xx, a timeout, a malformed body - is a fault, not an
 * entitlement, and must keep failing loudly.
 */
function isModuleRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

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
    archivedEventIds: [],
    splitUpdatedAt: null,
    splitAfterId: null,
    splitRetries: {},
    massedEvents: [],
    emptyLiveChecks: {},
    occupiedLiveEvents: [],
    lastVoiceSweepAt: Date.now(),
    applicationsOpen: undefined,
    lastGiveawayId: 0,
    postedGiveawayIds: [],
    announcedGiveawayDraws: [],
    unackedGiveawayMessages: {},
    initialized: false,
    unseededModules: [],
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

/** Result of reading a checkpoint file. */
interface LoadedState {
  state: PollerState;
  /**
   * True when a checkpoint exists on disk but neither it nor its backup could
   * be read. The poller must stay silent and must not overwrite the file:
   * reseeding from "now" would swallow everything created in the meantime and
   * forget every Discord thread binding.
   */
  unreadable: boolean;
}

function backupFileName(fileName: string): string {
  return `${fileName}.bak`;
}

/** Parses one checkpoint file, throwing when it is not a JSON object. */
function readStateFile(stateFile: string): PollerState {
  const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("poller state file does not contain a JSON object");
  }
  return normalizeState(parsed as Partial<PollerState>);
}

function normalizeState(parsedState: Partial<PollerState>): PollerState {
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
    archivedEventIds: parsedState.archivedEventIds ?? [],
    splitUpdatedAt: parsedState.splitUpdatedAt ?? null,
    splitAfterId: parsedState.splitAfterId ?? null,
    splitRetries: parsedState.splitRetries ?? {},
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
    unackedGiveawayMessages: parsedState.unackedGiveawayMessages ?? {},
    // A file written before this flag existed already holds real checkpoints,
    // so it is initialized. Treating it as fresh would re-seed the cursors to
    // "now" and silently swallow anything created while the bot was down.
    initialized: parsedState.initialized ?? true,
    unseededModules: parsedState.unseededModules ?? [],
  };
}

/**
 * Restores poller progress without losing the bot on corrupt JSON.
 *
 * Only a missing file with no backup is a fresh guild that may be seeded from
 * the live API. A file that exists but cannot be parsed falls back to the last
 * good backup; with no usable backup it is reported as `unreadable` so the
 * caller refuses to reseed (which would silently drop every announcement made
 * while the state was unavailable) and leaves the file for an operator.
 *
 * @example
 * ```ts
 * const { state, unreadable } = loadState("/app/data", "poller-state-123456789012345678.json");
 * console.log(state.lastEventId, unreadable);
 * ```
 */
function loadState(stateDirectory: string, fileName: string): LoadedState {
  ensureStateDirectory(stateDirectory);

  const stateFile = join(stateDirectory, fileName);
  const backupFile = join(stateDirectory, backupFileName(fileName));
  const hasMain = existsSync(stateFile);
  const hasBackup = existsSync(backupFile);
  if (!hasMain && !hasBackup) {
    return { state: createDefaultState(), unreadable: false };
  }

  if (hasMain) {
    try {
      return { state: readStateFile(stateFile), unreadable: false };
    } catch (error) {
      console.warn(`[Poller] State file ${stateFile} is unreadable:`, error);
    }
  }
  if (hasBackup) {
    try {
      const state = readStateFile(backupFile);
      console.warn(`[Poller] Recovered checkpoints from backup ${backupFile}`);
      return { state, unreadable: false };
    } catch (error) {
      console.warn(`[Poller] State backup ${backupFile} is unreadable:`, error);
    }
  }
  console.error(
    `[Poller] No usable checkpoint for ${fileName}; refusing to reseed. Fix or delete ${stateFile} to start from the current API state.`,
  );
  return { state: createDefaultState(), unreadable: true };
}

/**
 * Persists progress after each successful Discord announcement.
 *
 * The write is synchronous on purpose: a crash immediately after sending a
 * message must not roll the checkpoint back and re-announce the same event or
 * battle on the next start. It goes through a temporary file plus an atomic
 * rename so a crash mid-write cannot leave a truncated checkpoint, and the
 * previous good file is kept as `.bak`.
 *
 * @example
 * ```ts
 * saveState("/app/data", "poller-state-1.json", { lastEventId: 42, lastBattleId: 7 });
 * ```
 */
function saveState(stateDirectory: string, fileName: string, state: PollerState): void {
  ensureStateDirectory(stateDirectory);
  const stateFile = join(stateDirectory, fileName);
  const tmpFile = `${stateFile}.tmp`;

  const fd = openSync(tmpFile, "w");
  try {
    writeSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (existsSync(stateFile)) {
    try {
      // Only a parseable file is worth keeping as the backup.
      JSON.parse(readFileSync(stateFile, "utf-8"));
      copyFileSync(stateFile, join(stateDirectory, backupFileName(fileName)));
    } catch {
      // A corrupt current file must not overwrite the last good backup.
    }
  }
  renameSync(tmpFile, stateFile);
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
/**
 * Best-effort Discord id of the event organizer, for private-thread invites.
 *
 * The event detail carries no organizer Discord field; the roster does. When the
 * organizer has not signed up there is nothing to invite and `null` is fine —
 * the private thread still works, it just starts without an invite.
 */
function eventOrganizerDiscordId(event: EventDetailView): string | null {
  return (
    event.participants?.find((participant) => participant.user_id === event.created_by)
      ?.discord_id ?? null
  );
}

export class Poller {
  /** Guild this poller announces for, taken from the scoped `api`. */
  readonly guildId: string;
  private readonly stateDirectory: string;
  private readonly stateFileName: string;
  private readonly state: PollerState;
  /** True when the checkpoint file exists but cannot be read; the poller stays idle and never writes. */
  private readonly stateUnreadable: boolean;
  private timer: NodeJS.Timeout | undefined;
  private delayedPollTimer: NodeJS.Timeout | undefined;
  private delayedPollAt = 0;
  /** Guards against a manually-triggered check overlapping a scheduled one —
   *  both would otherwise read the same stale `lastEventId`/`lastBattleId`
   *  and could announce the same event or battle twice. */
  private inflightPoll: Promise<void> | null = null;
  /** Set by `pollNow()` while a cycle is running: run one more cycle right after it. */
  private rerunRequested = false;
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
    const loaded = loadState(this.stateDirectory, this.stateFileName);
    this.state = loaded.state;
    this.stateUnreadable = loaded.unreadable;
    console.log(
      `[Poller] Starting for guild ${this.guildId} — last event ID: ${this.state.lastEventId}, last battle ID: ${this.state.lastBattleId}`,
    );
  }

  private save(): void {
    // Never overwrite a checkpoint we could not read; an operator needs it.
    if (this.stateUnreadable) return;
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
      if (this.stateUnreadable) {
        this.warnStateUnreadable();
        return;
      }
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
    if (this.inflightPoll) {
      // A cycle that began before the caller's change cannot be trusted to have
      // seen it, so queue exactly one follow-up instead of silently dropping the request.
      this.rerunRequested = true;
      return this.inflightPoll;
    }
    return this.poll();
  }

  private warnStateUnreadable(): void {
    console.error(
      `[Poller] Guild ${this.guildId} is paused: its checkpoint file is unreadable and will not be reseeded automatically. Repair or delete ${this.stateFileName}.`,
    );
  }

  private poll(): Promise<void> {
    if (this.inflightPoll) {
      return this.inflightPoll;
    }
    const run = (async () => {
      try {
        do {
          this.rerunRequested = false;
          await this.pollOnce();
        } while (this.rerunRequested);
      } finally {
        this.inflightPoll = null;
      }
    })();
    this.inflightPoll = run;
    return run;
  }

  private async pollOnce(): Promise<void> {
    if (this.stateUnreadable) {
      this.warnStateUnreadable();
      return;
    }
    if (!this.state.initialized) {
      await this.adoptCheckpointBaseline();
      return;
    }
    // Each step is isolated: one throwing step must not skip the ones behind it.
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        console.error(`[Poller] Step ${name} failed for guild ${this.guildId}:`, error);
      }
    };
    let revisions: Map<string, EventRevision> | null = null;
    await step("applications", () => this.checkApplicationStatus());
    // Event announcements must complete before checking reminders so a newly
    // created event already has its discussion thread recorded.
    await step("new-events", () => this.checkNewEvents());
    await step("vod-forum", () => this.checkVodForumPosts());
    await step("revisions", async () => {
      revisions = await this.loadEventRevisions();
    });
    await step("closed-events", () => this.checkClosedEvents(revisions));
    await step("restored-events", () => this.checkRestoredEvents());
    await step("roster-sync", () => this.checkEventRosterSync(revisions));
    await step("calendars", () => this.updateEventCalendars());
    await step("new-giveaways", () => this.checkNewGiveaways());
    await step("giveaway-results", () => this.checkGiveawayResults());
    await step("lifecycle", () => this.checkEventLifecycle());
    await step("voice-sweep", () => this.sweepOrphanEventVoiceChannels());
    await Promise.allSettled([
      this.checkNewBattles(),
      this.checkUpcomingEvents(),
      this.checkSplitSync(),
    ]);
  }

  /**
   * Delivers only events whose create-time preference is pending. The database
   * claim is committed before Discord's non-idempotent create call; a process
   * crash or lost response therefore leaves `attempted`, never an auto-retry.
   */
  private async checkVodForumPosts(): Promise<void> {
    await this.deleteArchivedVodForumPosts();
    try {
      const settings = this.settings as SettingsService & {
        vodForumChannelId?: () => Promise<string | null>;
      };
      if (!settings.vodForumChannelId) return;
      const forumId = await settings.vodForumChannelId();
      if (!forumId) return;
      const channel = await this.client.channels.fetch(forumId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        console.warn(`[Poller] VOD forum ${forumId} is missing or not a forum channel`);
        return;
      }
      const forum = channel as ForumChannel;
      const bot = this.client.user;
      const permissions = bot ? forum.permissionsFor(bot) : null;
      if (
        !permissions ||
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ReadMessageHistory,
        ].some((permission) => !permissions.has(permission))
      ) {
        console.warn(`[Poller] Bot lacks permissions required to post in VOD forum ${forumId}`);
        return;
      }
      let appliedTags: string[] | undefined;
      if (forum.flags.has("RequireTag")) {
        const tag = forum.availableTags.find(
          (candidate) =>
            !candidate.moderated || permissions.has(PermissionFlagsBits.ManageThreads),
        );
        if (!tag) {
          console.warn(`[Poller] VOD forum ${forumId} requires a tag, but none is available`);
          return;
        }
        appliedTags = [tag.id];
      }
      const pending = await this.api.get<EventView[]>("api/events/vod-forum-posts/pending");
      for (const event of pending) {
        const claimed = await this.api.post<boolean>(
          `api/events/${event.id}/vod-forum-post/claim`,
          {},
        );
        if (!claimed) continue;
        try {
          const thread = await forum.threads.create({
            name: `VOD: ${event.title}`.slice(0, 100),
            message: {
              content: `Share video links from **${event.title}** in the replies below.`,
              allowedMentions: { parse: [] },
            },
            ...(appliedTags ? { appliedTags } : {}),
            reason: `VOD forum post for event ${event.id}`,
          });
          const recorded = await this.api.post<boolean>(
            `api/events/${event.id}/vod-forum-post/created`,
            { thread_id: thread.id },
          );
          if (!recorded) {
            throw new Error(`VOD forum thread ${thread.id} was not recorded by the backend`);
          }
          console.info(
            `[Poller] vod_forum_result=created guild=${this.guildId} event=${event.id} thread=${thread.id}`,
          );
        } catch (error) {
          // Discord may have created the thread before the local request failed.
          // Keep `attempted` durable and suppress automatic duplicate retries.
          console.error(
            `[Poller] vod_forum_result=ambiguous guild=${this.guildId} event=${event.id}; automatic retry suppressed: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      console.warn(`[Poller] Failed to process VOD forum posts: ${String(error)}`);
    }
  }

  /** Retry deletion of recorded VOD threads without acknowledging uncertain failures. */
  private async deleteArchivedVodForumPosts(): Promise<void> {
    try {
      const archived = await this.api.get<EventView[]>("api/events/vod-forum-posts/archived");
      for (const event of archived) {
        const threadId = event.vod_forum_thread_id;
        if (!threadId) continue;
        try {
          try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
              throw new Error(`VOD thread ${threadId} could not be verified`);
            }
            await thread.delete(`Archived event #${event.id}`);
          } catch (error) {
            if (!isUnknownDiscordChannel(error)) throw error;
          }
          const acknowledged = await this.api.post<boolean>(
            `api/events/${event.id}/vod-forum-post/deleted`,
            { thread_id: threadId },
          );
          if (!acknowledged) {
            console.warn(`[Poller] VOD deletion for event #${event.id} was not acknowledged`);
          }
        } catch (error) {
          console.warn(`[Poller] Could not delete archived VOD post for event #${event.id}; will retry:`, error);
        }
      }
    } catch (error) {
      console.warn(`[Poller] Could not list archived VOD posts: ${String(error)}`);
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
      // A failed list must fail the whole seed. Treating it as an empty page
      // would store a zero cursor and, once `initialized` is set, announce the
      // backlog on the next successful poll.
      //
      // Events are the one list the announcer cannot do without. Battles and
      // giveaways are optional modules: a tenant whose rank lacks them (an
      // alliance on the default rank, for one) gets a 403, which must not hold
      // back its event announcements. Only that definite refusal is tolerated;
      // any other failure still fails the whole seed.
      const [events, battles, giveaways] = await Promise.all([
        this.listSinceCheckpoint<EventView>(
          "api/events",
          0,
          (event) => event.id,
          50,
          { sort: "created_at", order: "desc" },
        ),
        this.listOptionalModule(
          "battles",
          this.listSinceCheckpoint<BattleSummary>(
            "api/battles",
            0,
            (battle) => battle.battle_id,
            10,
          ),
        ),
        this.listOptionalModule(
          "giveaways",
          this.listSinceCheckpoint<GiveawayView>(
            "api/giveaways",
            0,
            (giveaway) => giveaway.id,
            50,
            { sort: "created_at", order: "desc" },
          ),
        ),
      ]);
      if (!events.complete || battles?.complete === false || giveaways?.complete === false) {
        throw new Error("checkpoint seed did not see every list page");
      }

      this.state.lastEventId = Math.max(this.state.lastEventId, events.newestId);
      this.state.unseededModules = [];
      if (battles) {
        this.state.lastBattleId = Math.max(this.state.lastBattleId, battles.newestId);
      } else {
        this.state.unseededModules.push("battles");
      }
      if (giveaways) {
        this.state.lastGiveawayId = Math.max(this.state.lastGiveawayId, giveaways.newestId);
      } else {
        this.state.unseededModules.push("giveaways");
      }
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

  /**
   * Resolves an optional module's list, or `null` when the backend refuses it
   * with 403 because the tenant is not entitled to that module.
   */
  private async listOptionalModule<T>(
    module: OptionalModule,
    listing: Promise<T>,
  ): Promise<T | null> {
    try {
      return await listing;
    } catch (error) {
      if (!isModuleRefusal(error)) throw error;
      this.noteModuleRefused(module, error);
      return null;
    }
  }

  private readonly refusedModulesLogged = new Set<OptionalModule>();

  /** Says once per process why a module is skipped, so a tenant without it does not log every tick. */
  private noteModuleRefused(module: OptionalModule, error: unknown): void {
    if (this.refusedModulesLogged.has(module)) return;
    this.refusedModulesLogged.add(module);
    console.info(
      `[Poller] Guild ${this.guildId} is not entitled to ${module} (${String(error)}); skipping ${module} announcements`,
    );
  }

  /**
   * A module that was refused at seed time is adopted from its first answered
   * list: everything it holds is history, so the cursor jumps past it without
   * announcing. Returns true while the caller must still not announce this
   * cycle (the adoption cycle, or a partial scan that cannot set a cursor).
   */
  private adoptLateModule(
    module: OptionalModule,
    listing: { complete: boolean; newestId: number },
  ): boolean {
    if (!this.state.unseededModules.includes(module)) return false;
    if (!listing.complete) return true;
    if (module === "battles") {
      this.state.lastBattleId = Math.max(this.state.lastBattleId, listing.newestId);
    } else {
      this.state.lastGiveawayId = Math.max(this.state.lastGiveawayId, listing.newestId);
    }
    this.state.unseededModules = this.state.unseededModules.filter((item) => item !== module);
    this.save();
    console.log(
      `[Poller] ${module} became available for guild ${this.guildId}; adopted its existing items without announcing`,
    );
    return true;
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

  /**
   * Collects every row above the checkpoint by reading each reported page.
   *
   * List order is not an id order. Battles default to `start_time`, events to
   * `created_at` or event date, so the highest id is not guaranteed to sit on
   * page 1 and a later page can hold an id the cursor has not passed.
   * `complete` is false when the scan stops before `total_pages`; callers must
   * not move a high-water mark from a partial scan.
   */
  private async listSinceCheckpoint<T>(
    path: string,
    checkpoint: number,
    idOf: (item: T) => number,
    limit: number,
    query: Record<string, string | number> = {},
  ): Promise<{ items: T[]; newestId: number; complete: boolean }> {
    const loadPage = (page: number) =>
      this.api.get<PaginatedData<T>>(path, undefined, { ...query, page, limit });

    const first = await loadPage(1).catch((error: unknown) => {
      // Name the endpoint: a bare "forbidden" from a seed or a poll step does
      // not say which of the lists the backend refused.
      if (error instanceof ApiError) {
        throw new ApiError(error.status, `GET ${path}: ${error.message}`);
      }
      throw error;
    });
    const knownTotal = Math.max(1, first.total_pages ?? 1);
    const maxPages = Math.min(knownTotal, 50);
    const selected: T[] = [];
    const seen = new Set<number>();
    let newestId = 0;

    for (let page = 1; page <= maxPages; page++) {
      const items = page === 1 ? (first.items ?? []) : ((await loadPage(page)).items ?? []);
      for (const item of items) {
        const id = idOf(item);
        if (id > newestId) newestId = id;
        if (id <= checkpoint || seen.has(id)) continue;
        seen.add(id);
        selected.push(item);
      }
    }

    selected.sort((a, b) => idOf(a) - idOf(b));
    return { items: selected, newestId, complete: maxPages >= knownTotal };
  }

  /** Fetches recently-created events and announces any not covered by the checkpoint. */
  private async checkNewEvents(): Promise<void> {
    try {
      // The API defaults to event-date ordering. That is unsuitable for a creation
      // checkpoint: an event scheduled far in the future can fall outside page 1.
      const listed = await this.listSinceCheckpoint<EventView>(
        "api/events",
        this.state.lastEventId,
        (event) => event.id,
        50,
        { sort: "created_at", order: "desc" },
      );
      const items = listed.items;

      const newestEventId = listed.complete ? listed.newestId : 0;
      if (listed.complete && newestEventId > 0 && newestEventId < this.state.lastEventId) {
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

      const newEvents = items
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
        if (this.state.pendingAnnounces[eventId]?.status === "ambiguous") continue;
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
        const eventKey = String(eventView.id);
        const announced =
          Boolean(this.state.eventThreadIds[eventKey]) &&
          Boolean(this.state.eventSignupMessageIds[eventKey]);
        if (
          eventView.status !== "scheduled" ||
          eventView.archived_at ||
          announced
        ) {
          delete this.state.pendingAnnounces[eventId];
          this.save();
          continue;
        }
        await this.announceEvent(eventView, routes);
      }

      for (const event of announceable) {
        const eventKey = String(event.id);
        // Idempotence claim: a recorded thread AND signup card means the
        // announcement finished. A thread without a card is retried below.
        if (
          this.state.eventThreadIds[eventKey] &&
          this.state.eventSignupMessageIds[eventKey]
        ) {
          continue;
        }
        await this.announceEvent(event, routes);
      }

      // A partial scan must not advance the cursor: an unscanned page can
      // still hold an id between the checkpoint and the max already seen.
      if (listed.complete && listed.newestId > this.state.lastEventId) {
        this.state.lastEventId = listed.newestId;
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
    if (this.state.pendingAnnounces[eventKey]?.status === "ambiguous") return;
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
      const delivery = await this.eventDelivery();
      if (delivery === "forum") {
        const posted = await this.postEventForum(eventDetail);
        if (!posted) {
          if ((this.state.pendingAnnounces[eventKey] as { status?: string } | undefined)?.status === "ambiguous") return;
          fail("forum", "event forum post was not created");
          return;
        }
        delete this.state.pendingAnnounces[eventKey];
        this.save();
        return;
      }
      // Calendar delivery keeps organized events off the public channel: the
      // persistent calendar panel links to a private discussion thread that
      // only invited members can read, and no alliance ping is sent. Flash
      // masses stay on the public message flow even in calendar mode — a flash
      // call is time-critical and must reach everyone.
      const privateThreadDelivery =
        delivery === "calendar" && event.event_kind !== "flash";
      if (!privateThreadDelivery) {
        await this.postAllianceAnnouncement(eventDetail);
      }

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

      // Message delivery posts a public parent message, then a public thread.
      // Reuse the saved parent on retry so a failed thread or signup card never
      // repeats the role-wide ping. Calendar delivery instead opens a private
      // thread straight from the channel (no parent message to recover).
      const existingThreadId = this.state.eventThreadIds[eventKey];
      let thread: ThreadChannel | null = null;
      if (existingThreadId) {
        try {
          const existing = await this.client.channels.fetch(existingThreadId);
          if (existing?.isThread()) {
            thread = existing;
          } else if (!existing) {
            fail("thread_fetch", `thread ${existingThreadId} was not available`);
            return;
          } else {
            delete this.state.eventThreadIds[eventKey];
          }
        } catch (error) {
          // A blip must not forget the thread. The next startThread would hit
          // "thread already exists" and the announcement would stay failed.
          if (!isUnknownDiscordChannel(error)) {
            fail("thread_fetch", `could not fetch thread ${existingThreadId}`);
            return;
          }
          delete this.state.eventThreadIds[eventKey];
        }
      }
      if (!thread) {
        if (privateThreadDelivery) {
          thread = await createPrivateEventThread(
            channel,
            eventDetail,
            eventOrganizerDiscordId(eventDetail),
            "Poller",
          );
        } else {
          let parent: Message | null = null;
          const savedParentId = this.state.eventParentMessageIds[eventKey];
          if (savedParentId) {
            try {
              parent = await channel.messages.fetch(savedParentId);
            } catch (error) {
              if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) {
                fail("parent_fetch", `could not fetch saved announcement ${savedParentId}`);
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
          if (!thread) {
            // Threads opened from a message use that message id. Recover it
            // instead of calling startThread again on every poll.
            const recovered = await this.client.channels.fetch(parent.id).catch(() => null);
            if (recovered?.isThread()) thread = recovered;
          }
        }
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
        fail("signup", "signup card was not posted");
        return;
      }
      this.state.eventSignupRevisions[eventKey] =
        `${eventDetail.roster_version ?? 0}:${eventDetail.status}:${eventDetail.updated_at ?? ""}`;

      delete this.state.pendingAnnounces[eventKey];
      this.save();
      console.log(
        `[Poller] announce_result=success guild=${this.guildId} event=${event.id} kind=${event.event_kind} thread=${thread.id} — ${event.title}`,
      );
    } catch (error) {
      fail("unexpected", error instanceof Error ? error.message : String(error));
    }
  }

  private async eventDelivery(): Promise<"calendar" | "message" | "forum"> {
    // Real SettingsService instances always implement this. The fallback keeps
    // older state/test doubles on the historical public-message behavior.
    const delivery = this.settings.eventDelivery;
    return typeof delivery === "function" ? delivery.call(this.settings) : "message";
  }

  /** Opens one forum post for an event that chose forum delivery. */
  private async postEventForum(event: EventDetailView): Promise<boolean> {
    const forumId = await this.settings.eventsForumChannelId();
    if (!forumId) {
      console.warn(`[Poller] Event #${event.id} asked for a forum post, but no events forum is configured`);
      return false;
    }
    const channel = await this.client.channels.fetch(forumId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      console.warn(`[Poller] Events forum ${forumId} is missing or is not a forum channel`);
      return false;
    }
    const forum = channel as ForumChannel;
    const settings = await this.settings.get();
    const tags = [
      event.event_kind === "flash" ? settings.discord_event_flash_tag_id : null,
      event.call_to_arms ? settings.discord_event_cta_tag_id : null,
      event.status === "live" ? settings.discord_event_live_tag_id : settings.discord_event_scheduled_tag_id,
    ].filter((tag): tag is string => Boolean(tag));
    if (forum.flags.has("RequireTag") && tags.length === 0) {
      console.warn(`[Poller] Events forum ${forum.id} requires a tag, and none is configured`);
      return false;
    }
    const announcement = buildEventAnnouncementMessage(event);
    const eventKey = String(event.id);
    let thread: ThreadChannel;
    const existingId = this.state.eventThreadIds[eventKey];
    if (existingId) {
      const existing = await this.client.channels.fetch(existingId).catch(() => null);
      if (!existing?.isThread()) return false;
      thread = existing;
      try {
        await thread.setName(event.title.slice(0, 100));
        await thread.setAppliedTags(tags.slice(0, 5));
      } catch (error) {
        console.warn(`[Poller] Could not refresh event forum post #${event.id}:`, error);
      }
    } else {
      try {
        thread = await forum.threads.create({
          name: event.title.slice(0, 100),
          message: { content: announcement.content, allowedMentions: announcement.allowedMentions },
          appliedTags: tags.length > 0 ? tags.slice(0, 5) : undefined,
        });
      } catch (error) {
        this.state.pendingAnnounces[eventKey] = {
          attempts: 1,
          lastError: `ambiguous forum create: ${String(error)}`,
          since: new Date().toISOString(),
          status: "ambiguous",
        };
        this.save();
        console.warn(`[Poller] Forum create for event #${event.id} may have succeeded; automatic retry suppressed`);
        return false;
      }
    }
    this.state.eventThreadIds[String(event.id)] = thread.id;
    this.save();
    let starter: Message | null;
    try {
      starter = await thread.fetchStarterMessage();
      if (!starter) return false;
      await starter.edit({
        content: announcement.content,
        embeds: [buildEventEmbed(event, thread.guild?.preferredLocale)],
        components: buildEventThreadActionRows(event, thread.guild?.preferredLocale),
        allowedMentions: announcement.allowedMentions,
      });
    } catch (error) {
      console.warn(`[Poller] Could not add signup controls to event forum post #${event.id}:`, error);
      return false;
    }
    this.state.eventSignupMessageIds[String(event.id)] = starter.id;
    this.state.eventSignupRevisions[String(event.id)] =
      `${event.roster_version ?? 0}:${event.status}:${event.updated_at ?? ""}`;
    this.save();
    return true;
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
    const calendarMode = (await this.eventDelivery()) === "calendar";
    // Message and forum guilds have no calendar panel. Scheduled ticks must not
    // touch Discord for them at all; only an explicit refresh command proceeds.
    if ((configuredChannelIds.length === 0 || !calendarMode) && !discordUserId) {
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
      if (!calendarMode) {
        continue;
      }
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

  /**
   * Resolves a discussion thread id back to its event, so slash commands
   * typed inside an event thread can act on that event. Distinct events never
   * share a thread, but the first match wins defensively anyway.
   */
  findEventIdForThread(threadId: string): number | null {
    for (const [eventKey, knownThreadId] of Object.entries(this.state.eventThreadIds)) {
      if (knownThreadId === threadId) {
        const eventId = Number(eventKey);
        return Number.isSafeInteger(eventId) ? eventId : null;
      }
    }
    return null;
  }

  /** The signup-card message id remembered for an event thread, if any. */
  eventSignupMessageIdFor(eventId: number): string | null {
    return this.state.eventSignupMessageIds[String(eventId)] ?? null;
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
      // The backend silently truncates the id list at 200 (keeping the lowest
      // ids), so ask in chunks: anything missing from an answer must really be
      // missing, not just cut off.
      const revisions = new Map<string, EventRevision>();
      for (let offset = 0; offset < ids.length; offset += EVENT_REVISION_CHUNK) {
        const chunk = ids.slice(offset, offset + EVENT_REVISION_CHUNK);
        const items = await this.api.get<EventRevision[]>("api/events/revisions", undefined, {
          ids: chunk.join(","),
        });
        for (const item of items ?? []) revisions.set(String(item.id), item);
      }
      return revisions;
    } catch (error) {
      console.warn("[Poller] Could not load event revisions:", error);
      return null;
    }
  }

  /**
   * Confirms an event is really gone before its Discord thread is torn down.
   * A revision list that merely omits an id is not proof of deletion.
   */
  private async eventIsDeleted(eventId: string): Promise<boolean> {
    try {
      await this.api.get<EventView>(`api/events/${eventId}`);
      return false;
    } catch (error) {
      return error instanceof ApiError && error.status === 404;
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
          // Absent from the revision list is only a hint. Confirm the event is
          // really deleted before closing a thread that may belong to a live event.
          if (!(await this.eventIsDeleted(eventId))) continue;
          // The backend record is gone (deleted event). Close leftover Discord
          // state once, then drop the mapping so the next poll does not 404 forever.
          console.warn(
            `[Poller] Event #${eventId} no longer exists; closing leftover Discord thread`,
          );
          await this.closeEventThread(Number(eventId));
          this.forgetEventThread(eventId);
          continue;
        }
        // A cancelled event keeps its locked card. A copy of a cancelled origin is also archived
        // by the backend, so test the cancellation first or the guild would lose the card.
        if (event.status === "cancelled") {
          await this.closeCancelledEvent(event, threadId);
          continue;
        }
        if (event.archived_at) {
          if (!this.state.archivedEventIds.includes(event.id)) {
            this.state.archivedEventIds.push(event.id);
            this.save();
          }
          if (threadId) await this.deleteEventThread(event.id);
          continue;
        }
        if (!terminalStatuses.has(event.status)) continue;

        if (threadId) await this.finalizeStoppedEventThread(event.id);
      } catch (error) {
        // Keep the mapping so a temporary Discord/API failure is retried on the next poll.
        console.warn(`[Poller] Could not close event thread for #${eventId}:`, error);
      }
    }
  }

  /**
   * Restores only events whose Discord announcement was deliberately removed
   * during archive, avoiding replay of unrelated old events from the feed.
   */
  private async checkRestoredEvents(): Promise<void> {
    if (this.state.archivedEventIds.length === 0) return;
    try {
      for (const eventId of [...this.state.archivedEventIds]) {
        let event: EventView;
        try {
          event = await this.api.get<EventView>(`api/events/${eventId}`);
        } catch {
          continue;
        }
        const key = String(event.id);
        if (
          event.archived_at ||
          !["scheduled", "live"].includes(event.status) ||
          this.state.eventThreadIds[key]
        ) continue;
        await this.announceEvent(event, await this.loadEventChannelRoutes());
        if (
          this.state.eventThreadIds[key] &&
          this.state.eventSignupMessageIds[key] &&
          this.state.pendingAnnounces[key]?.status !== "ambiguous"
        ) {
          this.state.archivedEventIds = this.state.archivedEventIds.filter((id) => id !== event.id);
          this.save();
        }
      }
    } catch (error) {
      console.warn(`[Poller] Could not reconcile restored archived events: ${String(error)}`);
    }
  }

  /**
   * Renders the final signup card (stopped status, frozen roster, no live
   * buttons) and only then locks the thread: once archived, Discord rejects
   * the edit and the card would stay "LIVE" forever.
   */
  async finalizeStoppedEventThread(eventId: number): Promise<boolean> {
    const key = String(eventId);
    if (this.state.eventThreadIds[key]) {
      try {
        const thread = await this.getEventThread(eventId);
        if (thread) {
          const detail = await this.eventApi().get<EventDetailView>(`api/events/${eventId}`);
          const messageId = await refreshEventSignupCard(
            thread,
            detail,
            "Poller",
            this.state.eventSignupMessageIds[key],
          );
          if (messageId) this.state.eventSignupMessageIds[key] = messageId;
        }
      } catch (error) {
        console.warn(`[Poller] Could not render the final card for event #${eventId}:`, error);
      }
    }
    return this.closeEventThread(eventId);
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
        `${event.roster_version}:${event.status}:${event.updated_at ?? ""}`;
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
          `${detail.roster_version ?? 0}:${detail.status}:${detail.updated_at ?? ""}`;
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
      const updatedAt = (fingerprint as EventRevision & { updated_at?: string }).updated_at;
      const revision = `${fingerprint.roster_version}:${fingerprint.status}:${updatedAt ?? ""}`;
      if (this.state.eventSignupRevisions[eventId] === revision) continue;
      try {
        const detail = await this.api.get<EventDetailView>(`api/events/${eventId}`);

        const thread = await this.getEventThread(Number(eventId));
        if (!thread) continue;

        const announcement = buildEventAnnouncementMessage(detail);
        try {
          const starter = await thread.fetchStarterMessage?.();
          if (starter) {
            await starter.edit({
              content: announcement.content,
              allowedMentions: announcement.allowedMentions,
            });
          }
          if (thread.name !== detail.title.slice(0, 100) && typeof thread.setName === "function") {
            await thread.setName(detail.title.slice(0, 100));
          }
        } catch (error) {
          console.warn(
            `[Poller] Could not refresh announcement for event #${eventId}:`,
            error,
          );
        }

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

  /**
   * Lists every event with one status, soonest first.
   *
   * `api/events` defaults to newest-date-first, so a plain page 1 is filled by
   * far-future events and hides the ones that are due now. Filtering by status
   * and sorting ascending, then walking every page, keeps due events visible
   * however many future ones exist.
   */
  private async listEventsByStatus(status: "scheduled" | "live"): Promise<EventView[]> {
    const listed = await this.listSinceCheckpoint<EventView>(
      "api/events",
      0,
      (event) => event.id,
      EVENT_SCAN_PAGE_SIZE,
      { status, sort: "start_time_utc", order: "asc" },
    );
    return listed.items;
  }

  /** Executes Mass and Start automatically, then auto-stops live events after occupied voice goes empty. */
  private async checkEventLifecycle(): Promise<void> {
    try {
      const [scheduled, live] = await Promise.all([
        this.listEventsByStatus("scheduled"),
        this.listEventsByStatus("live"),
      ]);
      const now = Date.now();
      const seenEventIds = new Set<number>();
      for (const event of [...scheduled, ...live]) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        if (event.status === "scheduled") {
          // A synchronized copy is read-only here: mass, start and the voice channel belong to
          // the origin server (the backend answers 403 copy_read_only), and the copy converges
          // to the origin's status on its own. Trying would create and delete a voice channel
          // on every poll.
          if (event.is_synchronized_copy) continue;
          const startAt = new Date(event.start_time_utc ?? event.event_date_utc).getTime();
          if (Number.isFinite(startAt) && now - startAt > LIFECYCLE_MAX_OVERDUE_MS) continue;
          const massAt = new Date(event.mass_time_utc ?? event.event_date_utc).getTime();
          if (Number.isFinite(massAt) && now >= massAt && !this.state.massedEvents.includes(event.id)) {
            try {
              const thread = await this.getEventThread(event.id);
              const massed = await massDiscordEvent(this.client, this.api, "", event.id, thread ?? undefined);
              await this.postAllianceLifecycle(massed.event, "mass");
              this.state.massedEvents.push(event.id);
              // Only ids of still-scheduled events matter; keep the list bounded.
              if (this.state.massedEvents.length > 500) {
                this.state.massedEvents = this.state.massedEvents.slice(-500);
              }
              this.save();
            } catch (error) {
              console.warn(`[Poller] Could not mass event #${event.id}:`, error);
            }
          }
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
            await this.finalizeStoppedEventThread(event.id);
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

  /**
   * Adds a joining member to the event's stored private discussion thread.
   *
   * Only calendar-delivery organized events have one; public threads (message
   * delivery, flash masses) and forum posts are already visible, so the helper
   * below is a no-op there. Leaving an event deliberately keeps the membership:
   * the thread history stays readable for everyone who took part.
   */
  async addMemberToEventThread(eventId: number, userId: string): Promise<void> {
    const thread = await this.getEventThread(eventId);
    if (!thread) return;
    await addEventThreadMember(thread, userId, eventId, "Poller");
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
   *
   * The `(updated_at, id)` cursor moves past every split it has attempted, so a
   * split that cannot be synced (missing tag, locked thread, no permission)
   * never blocks the ones behind it. Failed splits go to `splitRetries` and are
   * retried with exponential backoff, then given up on loudly.
   */
  private async checkSplitSync(): Promise<void> {
    try {
      const forumChannelId = await this.settings.splitsForumChannelId();
      if (!forumChannelId) return;

      const adapter = new SplitForumAdapter(this.client, this.api, forumChannelId);
      await this.retryFailedSplits(adapter);

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
          const synced = await this.syncSplit(adapter, split.id);
          if (synced === "failed") this.recordSplitFailure(split.id);
          else delete this.state.splitRetries[String(split.id)];

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

  /** Syncs one split; `gone` means the backend no longer has it. */
  private async syncSplit(
    adapter: SplitForumAdapter,
    splitId: number,
  ): Promise<"synced" | "failed" | "gone"> {
    try {
      const item = await this.api.get<SplitDiscordSync>(`api/splits/${splitId}/discord-sync`);
      return (await adapter.sync(item)) ? "synced" : "failed";
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return "gone";
      console.warn(`[Poller] Could not sync split #${splitId}:`, error);
      return "failed";
    }
  }

  private recordSplitFailure(splitId: number): void {
    const key = String(splitId);
    const attempts = (this.state.splitRetries[key]?.attempts ?? 0) + 1;
    if (attempts >= SPLIT_RETRY_MAX_ATTEMPTS) {
      console.error(
        `[Poller] Giving up on split #${splitId} after ${attempts} failed Forum syncs; it will sync again when it next changes`,
      );
      delete this.state.splitRetries[key];
      return;
    }
    const delay = Math.min(SPLIT_RETRY_BASE_MS * 2 ** (attempts - 1), SPLIT_RETRY_MAX_MS);
    this.state.splitRetries[key] = { attempts, nextAt: Date.now() + delay };
  }

  private async retryFailedSplits(adapter: SplitForumAdapter): Promise<void> {
    const now = Date.now();
    for (const [key, retry] of Object.entries(this.state.splitRetries)) {
      if (retry.nextAt > now) continue;
      const splitId = Number(key);
      const result = await this.syncSplit(adapter, splitId);
      if (result === "failed") this.recordSplitFailure(splitId);
      else delete this.state.splitRetries[key];
      this.save();
    }
  }

  /** Checks for scheduled events starting in <= 1 hour and notifies their discussion thread. */
  private async checkUpcomingEvents(): Promise<void> {
    try {
      const scheduled = await this.listEventsByStatus("scheduled");

      const now = new Date().getTime();
      const oneHourMs = 60 * 60 * 1000;

      const upcomingEvents = scheduled.filter((e) => {
        if (e.status !== "scheduled") return false;
        if (this.state.pinged1hEvents.includes(e.id)) return false;

        const eventTime = new Date(e.event_date_utc).getTime();
        const diff = eventTime - now;
        return diff > 0 && diff <= oneHourMs;
      });

      if (upcomingEvents.length === 0) return;

      for (const event of upcomingEvents) {
        try {
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
        } catch (error) {
          console.warn(`[Poller] Could not send 1h warning for event #${event.id}:`, error);
        }
      }

      // Cleanup old pinged events (keep last 50). This list is only a "already
      // warned" memo: thread bindings are NOT derived from it and must never be
      // pruned here, or every announced event outside the last 50 pings loses its thread.
      if (this.state.pinged1hEvents.length > 50) {
        this.state.pinged1hEvents = this.state.pinged1hEvents.slice(-50);
        this.save();
      }
    } catch (err) {
      console.error("[Poller] Failed to check upcoming events:", err);
    }
  }

  /** Fetches the latest battles and announces any with ID > lastBattleId. */
  private async checkNewBattles(): Promise<void> {
    try {
      const listedBattles = await this.listSinceCheckpoint<BattleSummary>(
        "api/battles",
        this.state.lastBattleId,
        (battle) => battle.battle_id,
        10,
      );
      if (this.adoptLateModule("battles", listedBattles)) return;
      const newBattles = listedBattles.items.filter(
        (battle) => battle.battle_id > this.state.lastBattleId,
      );

      if (newBattles.length === 0) {
        if (
          listedBattles.complete &&
          listedBattles.newestId > 0 &&
          listedBattles.newestId < this.state.lastBattleId
        ) {
          this.state.lastBattleId = listedBattles.newestId;
          this.save();
        }
        return;
      }

      const battlesChannelId = await this.settings.battlesChannelId();
      if (!battlesChannelId) {
        // Nothing is configured to deliver to. Skip these battles instead of
        // leaving them as a backlog that floods the channel once one is set.
        if (listedBattles.complete && listedBattles.newestId > this.state.lastBattleId) {
          console.warn(
            `[Poller] No battles channel configured for guild ${this.guildId}; skipping ${newBattles.length} battle(s)`,
          );
          this.state.lastBattleId = listedBattles.newestId;
          this.save();
        }
        return;
      }
      const channel = await this.getTextChannel(battlesChannelId);
      if (!channel) return;

      for (const battle of newBattles) {
        const embed = buildBattleEmbed(battle);
        await channel.send({ embeds: [embed] });
        console.log(`[Poller] Announced battle #${battle.battle_id}`);
        // Advance per item (the list is sorted ascending) so a later failure
        // cannot make the next tick re-send battles that already reached Discord.
        if (listedBattles.complete) {
          this.state.lastBattleId = battle.battle_id;
          this.save();
        }
      }
      if (listedBattles.complete && listedBattles.newestId > this.state.lastBattleId) {
        this.state.lastBattleId = listedBattles.newestId;
        this.save();
      }
    } catch (err) {
      if (isModuleRefusal(err)) {
        this.noteModuleRefused("battles", err);
        return;
      }
      console.error("[Poller] Failed to check battles:", err);
    }
  }

  /** Announces newly created giveaways into the configured channel. */
  private async checkNewGiveaways(): Promise<void> {
    try {
      await this.ackUnackedGiveawayMessages();
      const listedGiveaways = await this.listSinceCheckpoint<GiveawayView>(
        "api/giveaways",
        this.state.lastGiveawayId,
        (giveaway) => giveaway.id,
        50,
        { sort: "created_at", order: "desc" },
      );
      if (this.adoptLateModule("giveaways", listedGiveaways)) return;
      const giveaways = listedGiveaways.items;
      const newestId = listedGiveaways.complete ? listedGiveaways.newestId : 0;
      if (listedGiveaways.complete && newestId > 0 && newestId < this.state.lastGiveawayId) {
        console.warn(
          `[Poller] Giveaway checkpoint ${this.state.lastGiveawayId} is ahead of the newest known giveaway (${newestId}); clamping`,
        );
        this.state.lastGiveawayId = newestId;
        this.save();
      }
      const newGiveaways = giveaways
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

      // Each giveaway is delivered independently. The cursor only moves past a
      // contiguous run of delivered ones, and `postedGiveawayIds` (written right
      // after the Discord send) keeps a retried item from being announced twice.
      let cursorBlocked = false;
      for (const summary of newGiveaways) {
        try {
          if (!this.state.postedGiveawayIds.includes(summary.id)) {
            const detail = await this.api.get<GiveawayDetailView>(`api/giveaways/${summary.id}`);
            const message = await channel.send(buildGiveawayAnnouncementMessage(detail, roleId));
            this.state.postedGiveawayIds.push(detail.id);
            this.state.unackedGiveawayMessages[String(detail.id)] = {
              message_id: message.id,
              channel_id: channel.id,
            };
            this.save();
            console.log(`[Poller] Announced giveaway #${detail.id}: ${detail.title}`);
            await this.ackUnackedGiveawayMessages();
          }
          if (!cursorBlocked && listedGiveaways.complete) {
            this.state.lastGiveawayId = Math.max(this.state.lastGiveawayId, summary.id);
            this.save();
          }
        } catch (error) {
          cursorBlocked = true;
          console.warn(`[Poller] Could not announce giveaway #${summary.id}:`, error);
        }
      }
      if (!cursorBlocked && listedGiveaways.complete && listedGiveaways.newestId > this.state.lastGiveawayId) {
        this.state.lastGiveawayId = listedGiveaways.newestId;
        this.save();
      }
    } catch (error) {
      if (isModuleRefusal(error)) {
        this.noteModuleRefused("giveaways", error);
        return;
      }
      console.error("[Poller] Failed to check giveaways:", error);
    }
  }

  /** Records sent giveaway messages with the backend; failures stay queued for the next tick. */
  private async ackUnackedGiveawayMessages(): Promise<void> {
    for (const [giveawayId, binding] of Object.entries(this.state.unackedGiveawayMessages)) {
      try {
        await this.api.put(`api/giveaways/${giveawayId}/discord-message`, binding);
        delete this.state.unackedGiveawayMessages[giveawayId];
        this.save();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          delete this.state.unackedGiveawayMessages[giveawayId];
          this.save();
          continue;
        }
        console.warn(`[Poller] Could not record Discord message for giveaway #${giveawayId}; will retry:`, error);
      }
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
          // Only a message that is really gone counts as "nothing to edit". Any
          // other failure is transient and must retry, not mark the draw announced.
          const message = channel
            ? await channel.messages.fetch(detail.discord_message_id).catch((error: unknown) => {
                if (discordErrorCode(error) === DISCORD_UNKNOWN_MESSAGE) return null;
                throw error;
              })
            : null;
          if (message) {
            await message.edit({
              embeds: [buildGiveawayEmbed(detail)],
              components: [buildGiveawayActionRow(detail)],
            });
            if (detail.status === "drawn") {
              await channel?.send(buildGiveawayWinnerMessage(detail)).catch((error: unknown) => {
                console.warn(`[Poller] Could not post winner message for giveaway #${giveawayId}:`, error);
              });
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
  const previous = pollers.get(poller.guildId);
  // A replaced poller keeps its interval alive and becomes unreachable, so it
  // would announce everything a second time. Stop it before it is dropped.
  if (previous && previous !== poller) previous.stop();
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
