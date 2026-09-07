import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "discord.js";
import { ApiClient } from "../api/client.js";
import { PollerManager } from "./poller-manager.js";
import { getPoller } from "./poller.js";
import { initSettingsService } from "./settings.js";
import { forgetTenantStatus } from "./tenant-gate.js";

const REGISTERED = "111111111111111111";
const UNREGISTERED = "222222222222222222";

function mockClient(guildIds: string[]): Client {
  return {
    guilds: { cache: new Map(guildIds.map((id) => [id, { id }])) },
    channels: { fetch: async () => null },
  } as unknown as Client;
}

/**
 * An `ApiClient` whose tenant-status answers are scripted and whose other reads
 * are empty pages. `withGuild` keeps the stubs, so the pollers the manager
 * creates never reach the network.
 */
function mockApi(registered: Set<string>, calls: string[], guildId?: string): ApiClient {
  const api = new ApiClient("http://backend.test", "secret", guildId);
  Object.defineProperties(api, {
    get: {
      value: async (path: string) => {
        calls.push(path);
        const match = path.match(/^api\/tenants\/([0-9]+)\/status$/);
        if (match) {
          return { id: match[1], registered: registered.has(match[1]) };
        }
        return { items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 };
      },
    },
    withGuild: { value: (id: string) => mockApi(registered, calls, id) },
  });
  return api;
}

test("the manager starts a poller only for registered tenant guilds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-manager-"));
  forgetTenantStatus(REGISTERED);
  forgetTenantStatus(UNREGISTERED);
  try {
    const calls: string[] = [];
    const api = mockApi(new Set([REGISTERED]), calls);
    initSettingsService(api);

    const manager = new PollerManager(
      mockClient([REGISTERED, UNREGISTERED]),
      api,
      60_000,
      60_000,
      directory,
    );
    await manager.reconcile();

    assert.equal(getPoller(REGISTERED)?.guildId, REGISTERED);
    assert.equal(getPoller(UNREGISTERED), null);
    assert.equal(
      calls.includes(`api/tenants/${UNREGISTERED}/status`),
      true,
      "the unregistered guild was still checked",
    );

    // Leaving the server tears the poller down.
    manager.forget(REGISTERED);
    assert.equal(getPoller(REGISTERED), null);
    manager.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the manager stops a poller once its guild is no longer a tenant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-manager-"));
  forgetTenantStatus(REGISTERED);
  try {
    const registered = new Set([REGISTERED]);
    const manager = new PollerManager(
      mockClient([REGISTERED]),
      mockApi(registered, []),
      60_000,
      60_000,
      directory,
    );
    initSettingsService(mockApi(registered, []));

    await manager.reconcile();
    assert.equal(getPoller(REGISTERED)?.guildId, REGISTERED);

    registered.delete(REGISTERED);
    await manager.reconcile();
    assert.equal(getPoller(REGISTERED), null);
    manager.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
