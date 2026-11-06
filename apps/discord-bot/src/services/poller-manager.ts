import type { Client } from "discord.js";
import type { ApiClient } from "../api/client.js";
import { config } from "../config.js";
import { getSettingsService, forgetSettingsService } from "./settings.js";
import { forgetMessageXpGate } from "./message-xp-gate.js";
import {
  Poller,
  registerPoller,
  registeredPollers,
  unregisterPoller,
  getPoller,
} from "./poller.js";
import { fetchTenantStatus, forgetTenantStatus, isRegisteredTenant } from "./tenant-gate.js";

/** How often the manager re-checks which guilds have become registered tenants. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * Runs one {@link Poller} per registered tenant guild.
 *
 * Announcements are tenant-local: the channels, the events, and the checkpoints
 * all belong to one guild's schema, and every backend call has to carry that
 * guild's `X-Guild-Id`. So rather than a single process-wide poller, this keeps
 * one poller per guild the bot shares with a registered tenant, and reconciles
 * that set as guilds are added, removed, or finish onboarding.
 *
 * Reconciliation is periodic as well as event-driven because registration
 * happens on the website, not in Discord — there is no gateway event for "this
 * server just completed onboarding".
 *
 * @example
 * ```ts
 * const pollers = new PollerManager(client, api, config.POLL_INTERVAL_MS);
 * await pollers.reconcile();
 * pollers.start();
 * ```
 */
export class PollerManager {
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;
  /** Starts in flight, so two callers racing for one guild share a single start. */
  private readonly starting = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    /** Unscoped client; each poller gets its own `withGuild` copy. */
    private readonly api: ApiClient,
    private readonly intervalMs: number,
    private readonly reconcileIntervalMs: number = RECONCILE_INTERVAL_MS,
    /** Where per-guild checkpoints live; defaults to the configured directory. */
    private readonly stateDirectory: string = config.POLLER_STATE_DIR,
  ) {}

  /** Begins periodic reconciliation. Pollers themselves are started as they appear. */
  start(): void {
    this.timer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
  }

  /** Stops reconciliation and every running poller. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const poller of registeredPollers()) {
      unregisterPoller(poller.guildId);
    }
  }

  /**
   * Starts pollers for guilds that are registered tenants and drops the rest.
   *
   * Runs in both directions: a guild that finished onboarding gains a poller,
   * and one the bot has left — or whose tenant was suspended — loses the one it
   * had, rather than looping on backend errors for a tenant that is gone.
   *
   * Overlapping runs are skipped: the periodic tick and a `GuildCreate` can
   * otherwise both decide the same guild needs a poller and start two of them.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const guildIds = [...this.client.guilds.cache.keys()];
      for (const guildId of guildIds) {
        await this.ensure(guildId);
      }
      const present = new Set(guildIds);
      for (const poller of registeredPollers()) {
        const guildId = poller.guildId;
        if (!present.has(guildId)) {
          this.forget(guildId);
          continue;
        }
        // Only a definite "not registered" tears a running poller down. A
        // backend blip must not, or every hiccup would stop announcements for
        // every guild until the next tick.
        forgetTenantStatus(guildId);
        try {
          if (!(await fetchTenantStatus(this.api, guildId)).registered) {
            this.forget(guildId);
          }
        } catch (error) {
          console.warn(`[Poller] Keeping guild ${guildId} despite a status check failure:`, error);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** Starts this guild's poller if it is a registered tenant and has none yet. */
  async ensure(guildId: string): Promise<void> {
    if (getPoller(guildId)) return;
    // `GuildCreate` and `reconcile()` can both land here while the tenant status
    // call is in flight; join the start already underway instead of beginning a second.
    const inflight = this.starting.get(guildId);
    if (inflight) return inflight;
    const start = this.startPoller(guildId).finally(() => {
      this.starting.delete(guildId);
    });
    this.starting.set(guildId, start);
    return start;
  }

  private async startPoller(guildId: string): Promise<void> {
    if (!(await isRegisteredTenant(this.api, guildId))) return;
    // The guild may have been registered by another path while we awaited.
    if (getPoller(guildId)) return;

    const poller = new Poller(
      this.client,
      this.api.withGuild(guildId),
      getSettingsService(guildId),
      this.intervalMs,
      this.stateDirectory,
    );
    registerPoller(poller);
    poller.start();
    console.log(`[Poller] Started for guild ${guildId}`);
  }

  /** Stops a guild's poller and drops its caches — the bot left, or it was unregistered. */
  forget(guildId: string): void {
    unregisterPoller(guildId);
    forgetSettingsService(guildId);
    forgetTenantStatus(guildId);
    forgetMessageXpGate(guildId);
    console.log(`[Poller] Stopped for guild ${guildId}`);
  }
}
