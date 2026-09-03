import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client, ThreadChannel } from "discord.js";
import { ApiError, type ApiClient } from "../api/client.js";
import type { SettingsService } from "./settings.js";
import { Poller } from "./poller.js";

function emptyPage() {
  return { items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 };
}

function mockThread(initial: { archived?: boolean } = {}): ThreadChannel {
  const state = {
    archived: initial.archived ?? false,
    locked: false,
  };
  const thread = {
    id: "thread",
    isThread: () => true,
    get archived() {
      return state.archived;
    },
    get locked() {
      return state.locked;
    },
    setArchived: async (value: boolean) => {
      state.archived = value;
      return thread;
    },
    setLocked: async (value: boolean) => {
      if (state.archived) {
        throw Object.assign(new Error("Thread is archived"), { code: 50083 });
      }
      state.locked = value;
      return thread;
    },
  };
  return thread as unknown as ThreadChannel;
}

test("poller drops deleted-event thread mappings and closes auto-archived threads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state.json"),
      JSON.stringify({
        lastEventId: 40,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: {
          "28": "thread-28",
          "32": "thread-32",
        },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const apiGets: string[] = [];
    const api = {
      get: async (path: string) => {
        apiGets.push(path);
        if (path === "api/events" || path === "api/battles") return emptyPage();
        if (path === "api/events/32") return { id: 32, status: "stopped" };
        if (path.startsWith("api/events/")) {
          throw new ApiError(404, `Event ${path.split("/")[2]} not found`);
        }
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;

    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventsChannelId: async () => null,
      callToArmsChannelId: async () => null,
      battlesChannelId: async () => null,
    } as unknown as SettingsService;

    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === "thread-28") return mockThread({ archived: false });
          if (id === "thread-32") return mockThread({ archived: true });
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, {});
    assert.equal(apiGets.includes("api/events/28"), true);
    assert.equal(apiGets.includes("api/events/32"), true);

    apiGets.length = 0;
    await poller.pollNow();
    assert.equal(apiGets.some((path) => path.startsWith("api/events/")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
