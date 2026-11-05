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

test("concurrent ensure calls for one guild start exactly one poller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-manager-"));
  forgetTenantStatus(REGISTERED);
  try {
    const calls: string[] = [];
    const api = mockApi(new Set([REGISTERED]), calls);
    initSettingsService(api);
    const manager = new PollerManager(mockClient([REGISTERED]), api, 60_000, 60_000, directory);

    // `GuildCreate` and the startup `reconcile()` race while the status call is in flight.
    await Promise.all([manager.ensure(REGISTERED), manager.ensure(REGISTERED), manager.reconcile()]);

    const first = getPoller(REGISTERED);
    assert.equal(first?.guildId, REGISTERED);
    assert.equal(
      calls.filter((path) => path === `api/tenants/${REGISTERED}/status`).length >= 1,
      true,
    );
    const stopped: string[] = [];
    const originalStop = first!.stop.bind(first);
    first!.stop = () => {
      stopped.push("stopped");
      originalStop();
    };
    await manager.ensure(REGISTERED);
    assert.equal(getPoller(REGISTERED), first, "a later ensure keeps the running poller");
    assert.deepEqual(stopped, [], "no poller was replaced, so none was orphaned");
    manager.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registering a replacement poller stops the one it replaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-manager-"));
  try {
    const { Poller, registerPoller, unregisterPoller } = await import("./poller.js");
    const api = mockApi(new Set([REGISTERED]), [], REGISTERED);
    const settings = {} as never;
    const first = new Poller({} as Client, api, settings, 60_000, directory);
    const second = new Poller({} as Client, api, settings, 60_000, directory);
    let firstStopped = false;
    first.stop = () => {
      firstStopped = true;
    };
    registerPoller(first);
    registerPoller(second);
    assert.equal(firstStopped, true);
    assert.equal(getPoller(REGISTERED), second);
    unregisterPoller(REGISTERED);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
