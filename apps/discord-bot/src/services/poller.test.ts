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
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") return emptyPage();
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
      giveawaysChannelId: async () => null,
      giveawaysRoleId: async () => null,
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

test("new events announce text-only in the parent channel and put signup controls in the thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state.json"),
      JSON.stringify({
        lastEventId: 40,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const event = {
      id: 41,
      title: "Castle Fight",
      description: "Bring sets",
      call_to_arms: false,
      discord_role_ids: ["111111111111111111"],
      regear: false,
      comp_id: 7,
      comp_name: "Main ZvZ",
      created_by: 1,
      created_by_username: "Officer",
      event_date_utc: "2027-01-01T20:00:00Z",
      created_at: "2026-09-01T10:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
      status: "scheduled",
      started_at: null,
      stopped_at: null,
      auto_stop_deadline: null,
      link_status: "pending",
      discord_voice_channel_id: null,
    };
    const eventDetail = {
      ...event,
      active_comp_id: 7,
      active_comp_name: "Main ZvZ",
      active_comp_capacity: 20,
      comp_builds: [],
      participants: [],
    };

    const parentSends: Array<Record<string, unknown>> = [];
    const threadSends: Array<Record<string, unknown>> = [];
    const thread = {
      id: "thread-41",
      isThread: () => true,
      send: async (payload: Record<string, unknown>) => {
        threadSends.push(payload);
        return { id: "thread-msg" };
      },
    };
    const eventsChannel = {
      id: "events-channel",
      isTextBased: () => true,
      send: async (payload: Record<string, unknown>) => {
        parentSends.push(payload);
        return {
          id: "announce-msg",
          startThread: async () => thread,
        };
      },
    };

    const api = {
      get: async (path: string) => {
        if (path === "api/events") {
          return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        }
        if (path === "api/events/41") return eventDetail;
        if (path === "api/battles" || path === "api/giveaways") return emptyPage();
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;

    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventsChannelId: async () => "events-channel",
      callToArmsChannelId: async () => null,
      battlesChannelId: async () => null,
      giveawaysChannelId: async () => null,
      giveawaysRoleId: async () => null,
    } as unknown as SettingsService;

    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === "events-channel") return eventsChannel;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(parentSends.length, 1);
    assert.match(String(parentSends[0]?.content), /Castle Fight/);
    assert.equal("embeds" in parentSends[0]!, false);
    assert.equal("components" in parentSends[0]!, false);

    assert.equal(threadSends.length, 1);
    assert.ok(Array.isArray(threadSends[0]?.embeds));
    assert.ok(Array.isArray(threadSends[0]?.components));

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string>; lastEventId: number };
    assert.equal(saved.lastEventId, 41);
    assert.equal(saved.eventThreadIds["41"], "thread-41");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
