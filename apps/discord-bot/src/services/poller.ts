import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Client, TextChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { PaginatedData, EventView, BattleSummary } from "../api/types.js";
import { buildEventAnnouncementContent } from "../embeds/event.embed.js";
import { buildBattleEmbed } from "../embeds/battle.embed.js";
import { GUILD_NAME } from "../embeds/theme.js";
import { config, getEventRoleId } from "../config.js";
import { createEventAnnouncementThread } from "./event-announcement-thread.js";

const STATE_FILE_NAME = "poller-state.json";

interface PollerState {
  lastEventId: number;
  lastBattleId: number;
  pinged1hEvents: number[];
}

function createDefaultState(): PollerState {
  return {
    lastEventId: 0,
    lastBattleId: 0,
    pinged1hEvents: [],
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

  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly eventsChannelId: string,
    private readonly battlesChannelId: string,
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

  private async poll(): Promise<void> {
    await Promise.allSettled([
      this.checkNewEvents(),
      this.checkNewBattles(),
      this.checkUpcomingEvents(),
    ]);
  }

  /** Fetches the latest events and announces any with ID > lastEventId. */
  private async checkNewEvents(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<EventView>>(
        "api/events",
        undefined,
        {
          page: 1,
          limit: 20,
        },
      );

      const newEvents = result.items
        .filter((e) => e.id > this.state.lastEventId)
        .sort((a, b) => a.id - b.id);

      if (newEvents.length === 0) return;

      const channel = await this.getTextChannel(this.eventsChannelId);
      if (!channel) return;

      const eventRoleId = getEventRoleId(config);
      for (const event of newEvents) {
        const announcementMessage = await channel.send({
          content: buildEventAnnouncementContent(event, eventRoleId),
          allowedMentions: eventRoleId
            ? { roles: [eventRoleId] }
            : { parse: [] },
        });
        await createEventAnnouncementThread(
          announcementMessage,
          event,
          "Poller",
        );

        this.state.lastEventId = event.id;
        saveState(this.stateDirectory, this.state);
        console.log(`[Poller] Announced event #${event.id}: ${event.title}`);
      }
    } catch (err) {
      console.error("[Poller] Failed to check events:", err);
    }
  }

  /** Checks for scheduled events starting in <= 1 hour and pings the role. */
  private async checkUpcomingEvents(): Promise<void> {
    const eventRoleId = getEventRoleId(config);
    if (!eventRoleId) return;

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

      const channel = await this.getTextChannel(this.eventsChannelId);
      if (!channel) return;

      for (const event of upcomingEvents) {
        await channel.send({
          content: `🚨 <@&${eventRoleId}> The event **${event.title}** starts in less than 1 hour! Get ready!`,
          allowedMentions: { roles: [eventRoleId] },
        });

        this.state.pinged1hEvents.push(event.id);
        saveState(this.stateDirectory, this.state);
        console.log(`[Poller] Pinged 1h warning for event #${event.id}`);
      }

      // Cleanup old pinged events (keep last 50)
      if (this.state.pinged1hEvents.length > 50) {
        this.state.pinged1hEvents = this.state.pinged1hEvents.slice(-50);
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

      const channel = await this.getTextChannel(this.battlesChannelId);
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

  private async getTextChannel(channelId: string): Promise<TextChannel | null> {
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
