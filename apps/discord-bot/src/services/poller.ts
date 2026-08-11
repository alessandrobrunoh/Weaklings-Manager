import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, TextChannel } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData, EventView, BattleSummary } from '../api/types.js';
import { buildEventEmbed, buildEventActionRows } from '../embeds/event.embed.js';
import { buildBattleEmbed } from '../embeds/battle.embed.js';
import { GUILD_NAME } from '../embeds/theme.js';

const STATE_DIR = 'data';
const STATE_FILE = join(STATE_DIR, 'poller-state.json');

interface PollerState {
  lastEventId: number;
  lastBattleId: number;
}

function loadState(): PollerState {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  if (!existsSync(STATE_FILE)) {
    return { lastEventId: 0, lastBattleId: 0 };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PollerState;
  } catch {
    return { lastEventId: 0, lastBattleId: 0 };
  }
}

function saveState(state: PollerState): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
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
    await Promise.allSettled([this.checkNewEvents(), this.checkNewBattles()]);
  }

  /** Fetches the latest events and announces any with ID > lastEventId. */
  private async checkNewEvents(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<EventView>>('api/events', undefined, {
        page: 1,
        limit: 20,
      });

      const newEvents = result.items
        .filter((e) => e.id > this.state.lastEventId)
        .sort((a, b) => a.id - b.id);

      if (newEvents.length === 0) return;

      const channel = await this.getTextChannel(this.eventsChannelId);
      if (!channel) return;

      for (const event of newEvents) {
        const embed = buildEventEmbed(event);
        const [row1, row2] = buildEventActionRows(event.id);

        const eventDate = new Date(event.event_date_utc);
        const h = String(eventDate.getUTCHours()).padStart(2, '0');
        const m = String(eventDate.getUTCMinutes()).padStart(2, '0');
        const d = String(eventDate.getUTCDate()).padStart(2, '0');
        const mo = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
        const y = String(eventDate.getUTCFullYear()).slice(-2);
        const timeStr = `${h}:${m} UTC ${d}/${mo}/${y}`;

        await channel.send({
          content: `📌 **MassUp ${timeStr}**\n*Another day with Ally 🐸*\n\n@${GUILD_NAME}`,
          embeds: [embed],
          components: [row1, row2],
        });

        this.state.lastEventId = event.id;
        saveState(this.state);
        console.log(`[Poller] Announced event #${event.id}: ${event.title}`);
      }
    } catch (err) {
      console.error('[Poller] Failed to check events:', err);
    }
  }

  /** Fetches the latest battles and announces any with ID > lastBattleId. */
  private async checkNewBattles(): Promise<void> {
    try {
      const result = await this.api.get<PaginatedData<BattleSummary>>('api/battles', undefined, {
        page: 1,
        limit: 10,
      });

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
      console.error('[Poller] Failed to check battles:', err);
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
