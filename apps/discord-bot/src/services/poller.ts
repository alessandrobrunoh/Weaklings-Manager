import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Client, TextChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { PaginatedData, EventView, BattleSummary } from "../api/types.js";
import { buildEventAnnouncementContent } from "../embeds/event.embed.js";
import { buildBattleEmbed } from "../embeds/battle.embed.js";
import { GUILD_NAME } from "../embeds/theme.js";
import { config, getEventRoleId } from "../config.js";

const STATE_DIR = "data";
const STATE_FILE = join(STATE_DIR, "poller-state.json");

interface PollerState {
  lastEventId: number;
  lastBattleId: number;
  pinged1hEvents: number[];
}

function loadState(): PollerState {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  const defaultState: PollerState = {
    lastEventId: 0,
    lastBattleId: 0,
    pinged1hEvents: [],
  };
  if (!existsSync(STATE_FILE)) {
    return defaultState;
  }
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return {
      lastEventId: parsed.lastEventId ?? 0,
      lastBattleId: parsed.lastBattleId ?? 0,
      pinged1hEvents: parsed.pinged1hEvents ?? [],
    };
  } catch {
    return defaultState;
  }
}

function saveState(state: PollerState): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Polling service that checks for new events and battles and posts them
 * to the configured Discord channels.
 */
export class Poller {
  private readonly state: PollerState;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly eventsChannelId: string,
    private readonly battlesChannelId: string,
    private readonly intervalMs: number,
  ) {
    this.state = loadState();
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
        await channel.send({
          content: buildEventAnnouncementContent(event, eventRoleId),
          allowedMentions: eventRoleId
            ? { roles: [eventRoleId] }
            : { parse: [] },
        });

        this.state.lastEventId = event.id;
        saveState(this.state);
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
          content: `🚨 <@&${eventRoleId}> L'evento **${event.title}** inizia tra meno di 1 ora! Preparatevi!`,
          allowedMentions: { roles: [eventRoleId] },
        });

        this.state.pinged1hEvents.push(event.id);
        saveState(this.state);
        console.log(`[Poller] Pinged 1h warning for event #${event.id}`);
      }

      // Cleanup old pinged events (keep last 50)
      if (this.state.pinged1hEvents.length > 50) {
        this.state.pinged1hEvents = this.state.pinged1hEvents.slice(-50);
        saveState(this.state);
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
        saveState(this.state);
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
