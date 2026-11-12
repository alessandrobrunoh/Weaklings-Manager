import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

/**
 * The guild name shown in embed headers and footers.
 *
 * The bot serves many tenants from one process, so the name cannot come from a global setting.
 * Each entry point (an interaction, a bang command, a poll tick) runs inside
 * {@link withBrandName} with the tenant's registered name; code outside such a scope falls back to
 * the `GUILD_NAME` setting.
 */
const brandStore = new AsyncLocalStorage<string>();

/** Runs `run` with `name` as the embed brand; a blank or missing name keeps the fallback. */
export function withBrandName<T>(name: string | null | undefined, run: () => T): T {
  const trimmed = name?.trim();
  return trimmed ? brandStore.run(trimmed, run) : run();
}

/** The brand of the current scope, else the `GUILD_NAME` setting. */
export function brandName(): string {
  return brandStore.getStore() ?? config.GUILD_NAME;
}
