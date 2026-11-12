import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType } from "discord.js";
import type { Client, Message, ThreadChannel } from "discord.js";
import { ApiError, type ApiClient } from "../api/client.js";
import type { EventDetailView, EventView } from "../api/types.js";
import type { SettingsService } from "./settings.js";
import { FLASH_UNDO_WINDOW_MS, Poller } from "./poller.js";

function emptyPage() {
  return { items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 };
}

function eventRevision(
  id: number,
  status: string,
  extras: { roster_version?: number; archived_at?: string | null; updated_at?: string } = {},
) {
  return {
    id,
    status,
    roster_version: extras.roster_version ?? 0,
    archived_at: extras.archived_at ?? null,
    updated_at: extras.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

function calendarEvent(id: number, title: string): EventView {
  return {
    id,
    title,
    description: null,
    call_to_arms: false,
    discord_role_ids: [],
    regear: false,
    comp_id: 1,
    comp_name: "Main",
    created_by: 1,
    created_by_username: "Officer",
    event_date_utc: `2030-01-${String((id % 28) + 1).padStart(2, "0")}T20:00:00Z`,
    created_at: "2029-12-01T10:00:00Z",
    updated_at: "2029-12-01T10:00:00Z",
    status: "scheduled",
    started_at: null,
    stopped_at: null,
    auto_stop_deadline: null,
    discord_voice_channel_id: null,
    link_status: "pending",
  };
}

function mockThread(initial: { archived?: boolean; locked?: boolean } = {}): ThreadChannel {
  const state = {
    archived: initial.archived ?? false,
    locked: initial.locked ?? false,
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
      join(directory, "poller-state-100000000000000001.json"),
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
      guildId: "100000000000000001",
      get: async (path: string) => {
        apiGets.push(path);
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/events/revisions") return [eventRevision(32, "stopped")];
        // Event 28 is absent from the revisions; the poller must confirm the delete.
        if (path === "api/events/28") throw new ApiError(404, "Event 28 not found");
        if (path === "api/events/32") return { ...calendarEvent(32, "Stopped"), status: "stopped", participants: [], roster_version: 1 };
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
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, {});
    assert.equal(apiGets.includes("api/events/revisions"), true);
    // Event 28 is confirmed deleted before its thread is touched; event 32 gets
    // its final card rendered before its thread is closed.
    assert.deepEqual(
      apiGets.filter((path) => /^api\/events\/\d+$/.test(path)).sort(),
      ["api/events/28", "api/events/32"],
    );

    apiGets.length = 0;
    await poller.pollNow();
    assert.equal(apiGets.some((path) => /^api\/events\/\d+$/.test(path)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller deletes the Discord announcement when an event is archived", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 40,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "28": "thread-28" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const deleted: string[] = [];
    const starter = {
      delete: async () => {
        deleted.push("starter");
      },
    };
    const thread = {
      id: "thread-28",
      isThread: () => true,
      archived: false,
      locked: false,
      fetchStarterMessage: async () => starter,
      setArchived: async () => thread,
      setLocked: async () => thread,
    };

    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/events/revisions") {
          return [eventRevision(28, "scheduled", { archived_at: "2026-09-05T12:00:00Z" })];
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
          if (id === "thread-28") return thread;
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, {});
    assert.deepEqual(deleted, ["starter"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller keeps a cancelled event thread mapping so it can be reopened", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 40,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "28": "thread-28" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const apiGets: string[] = [];
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        apiGets.push(path);
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/events/revisions") return [eventRevision(28, "cancelled")];
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
          if (id === "thread-28") return mockThread({ archived: true, locked: true });
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string>; eventSignupRevisions: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, { "28": "thread-28" });
    assert.equal(saved.eventSignupRevisions["28"], "0:cancelled:2026-01-01T00:00:00Z");
    assert.equal(apiGets.includes("api/events/28"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller reopens a cancelled event thread when status returns to scheduled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 40,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "28": "thread-28" },
        eventSignupMessageIds: { "28": "signup-28" },
        eventSignupRevisions: { "28": "0:cancelled:2026-01-01T00:00:00Z" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const thread = mockThread({ archived: true, locked: true });
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/events/revisions") return [eventRevision(28, "scheduled")];
        if (path === "api/events/28") {
          return {
            id: 28,
            title: "Reopened mass",
            status: "scheduled",
            roster_version: 0,
            participants: [],
            event_date_utc: "2026-09-01T20:00:00Z",
            created_by_username: "Officer",
            comp_name: "Main",
          };
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
          if (id === "thread-28") return thread;
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(thread.archived, false);
    assert.equal(thread.locked, false);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, { "28": "thread-28" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new events announce text-only in the parent channel and put signup controls in the thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
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
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events/calendar") return [event];
        if (path === "api/events") {
          return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        }
        if (path === "api/events/revisions") {
          return [eventRevision(41, event.status, { roster_version: 0 })];
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
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string>; lastEventId: number };
    assert.equal(saved.lastEventId, 41);
    assert.equal(saved.eventThreadIds["41"], "thread-41");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("flash announce retries thread creation without repeating the public role ping", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 0,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        eventParentMessageIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        initialized: true,
      }),
      "utf-8",
    );

    const event = {
      ...calendarEvent(1, "Castle dive"),
      event_kind: "flash" as const,
      comp_id: null,
      comp_name: null,
      discord_role_ids: ["111111111111111111"],
      mass_time_utc: "2030-01-01T19:30:00Z",
      start_time_utc: "2030-01-01T20:00:00Z",
      created_at: new Date().toISOString(),
    };
    const detail = {
      ...event,
      active_comp_id: null,
      active_comp_name: null,
      active_comp_capacity: null,
      comp_builds: [],
      participants: [],
    };

    let parentSends = 0;
    let threadAttempts = 0;
    const threadSends: Array<Record<string, unknown>> = [];
    const thread = {
      id: "flash-thread",
      isThread: () => true,
      send: async (payload: Record<string, unknown>) => {
        threadSends.push(payload);
        return { id: "flash-signup" };
      },
    };
    const parent = {
      id: "flash-parent",
      startThread: async () => {
        threadAttempts++;
        if (threadAttempts === 1) {
          throw Object.assign(new Error("temporary thread error"), { code: 50013 });
        }
        return thread;
      },
    };
    const calendarMessages = new Map<string, { edit: (payload: unknown) => Promise<void> }>();
    const channel = {
      id: "flash-channel",
      isTextBased: () => true,
      isDMBased: () => false,
      threads: { create: async () => thread },
      messages: {
        fetch: async (id: string) => {
          if (id === "flash-parent") return parent;
          const message = calendarMessages.get(id);
          if (message) return message;
          throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        },
      },
      send: async (payload: Record<string, unknown>) => {
        if ("content" in payload) {
          parentSends++;
          return parent;
        }
        const id = `calendar-${calendarMessages.size + 1}`;
        calendarMessages.set(id, { edit: async () => undefined });
        return { id, edit: async () => undefined };
      },
    };
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events") return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        if (path === "api/events/calendar") return [event];
        if (path === "api/events/revisions") return [eventRevision(1, "scheduled", { roster_version: 0 })];
        if (path === "api/events/1") return detail;
        if (path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/splits/discord-sync") return { items: [], has_more: false };
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;
    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventsChannelId: async () => "events-channel",
      callToArmsChannelId: async () => "cta-channel",
      flashMassChannelId: async () => "flash-channel",
      eventChannelRoutes: async () => ({
        events: "events-channel",
        callToArms: "cta-channel",
        flashMass: "flash-channel",
      }),
      battlesChannelId: async () => null,
      giveawaysChannelId: async () => null,
      giveawaysRoleId: async () => null,
    } as unknown as SettingsService;
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === "flash-channel") return channel;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    assert.equal(parentSends, 0, "the public role ping waits through the undo window");
    assert.equal(threadAttempts, 0);

    let saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as {
      lastEventId: number;
      eventParentMessageIds: Record<string, string>;
      pendingAnnounces: Record<string, { attempts: number; status?: string }>;
    };
    assert.equal(saved.lastEventId, 1);
    assert.equal(saved.pendingAnnounces["1"]?.status, "undo_window");

    // Simulate the durable grace period passing; the pending-announcement queue
    // now owns delivery even though lastEventId has moved on.
    event.created_at = new Date(Date.now() - FLASH_UNDO_WINDOW_MS - 1_000).toISOString();
    detail.created_at = event.created_at;
    await poller.pollNow();
    assert.equal(parentSends, 1);
    assert.equal(threadAttempts, 1);
    saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as typeof saved;
    assert.equal(saved.lastEventId, 1);
    assert.equal(saved.eventParentMessageIds["1"], "flash-parent");
    assert.equal(saved.pendingAnnounces["1"]?.attempts, 1);
    assert.equal(saved.pendingAnnounces["1"]?.status, "failed");

    await poller.pollNow();
    assert.equal(parentSends, 1, "the retry must reuse the saved parent ping");
    assert.equal(threadAttempts, 2);
    assert.equal(threadSends.length, 1);
    saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as typeof saved;
    assert.equal(saved.pendingAnnounces["1"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a shared event is announced once by its own server; the alliance announces its own link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
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
      ping_alliance: true,
      alliance_discord_channel_id: "ally-events",
      alliance_discord_role_ids: ["999999999999999999"],
    };
    const eventDetail = {
      ...event,
      active_comp_id: 7,
      active_comp_name: "Main ZvZ",
      active_comp_capacity: 20,
      comp_builds: [],
      participants: [],
    };

    const guildSends: Array<Record<string, unknown>> = [];
    const allySends: Array<Record<string, unknown>> = [];
    const patches: Array<{ guildId?: string; path: string; body: unknown }> = [];
    const thread = {
      id: "thread-41",
      isThread: () => true,
      send: async () => ({ id: "thread-msg" }),
    };
    const eventsChannel = {
      id: "events-channel",
      isTextBased: () => true,
      send: async (payload: Record<string, unknown>) => {
        guildSends.push(payload);
        return { id: "announce-msg", startThread: async () => thread };
      },
    };
    const allyChannel = {
      id: "ally-events",
      isTextBased: () => true,
      send: async (payload: Record<string, unknown>) => {
        allySends.push(payload);
        return { id: "ally-msg" };
      },
    };

    const makeApi = (guildId: string): ApiClient =>
      ({
        guildId,
        withGuild: (id: string) => makeApi(id),
        get: async (path: string) => {
          if (path === "api/events/calendar") return [event];
          if (path === "api/events") {
            return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
          }
          if (path === "api/events/revisions") {
            return [eventRevision(41, event.status, { roster_version: 0 })];
          }
          if (path === "api/events/41") return eventDetail;
          if (path === "api/battles" || path === "api/giveaways") return emptyPage();
          throw new Error(`unexpected GET ${path}`);
        },
        patch: async (path: string, body: unknown) => {
          patches.push({ guildId, path, body });
        },
      }) as unknown as ApiClient;

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
          if (id === "ally-events") return allyChannel;
          if (id === "thread-41") return thread;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, makeApi("100000000000000001"), settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(guildSends.length, 1);
    assert.match(String(guildSends[0]?.content), /<@&111111111111111111>/);
    assert.equal(allySends.length, 0, "the alliance channel is announced by the alliance bot, not this one");
    assert.deepEqual(patches, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a link is announced publicly with this server's own event role", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
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
      discord_role_ids: [],
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
      ping_alliance: false,
      is_link: true,
      source_tenant_id: "900000000000000001",
      source_event_id: 7,
      source_tenant_name: "Guild A",
    };
    const eventDetail = {
      ...event,
      active_comp_id: 7,
      active_comp_name: "Main ZvZ",
      active_comp_capacity: 20,
      comp_builds: [],
      participants: [],
    };

    const guildSends: Array<Record<string, unknown>> = [];
    const allySends: Array<Record<string, unknown>> = [];
    const patches: Array<{ guildId?: string; path: string; body: unknown }> = [];
    const thread = {
      id: "thread-41",
      isThread: () => true,
      send: async () => ({ id: "thread-msg" }),
    };
    const eventsChannel = {
      id: "events-channel",
      isTextBased: () => true,
      send: async (payload: Record<string, unknown>) => {
        guildSends.push(payload);
        return { id: "announce-msg", startThread: async () => thread };
      },
    };
    const allyChannel = {
      id: "ally-events",
      isTextBased: () => true,
      send: async (payload: Record<string, unknown>) => {
        allySends.push(payload);
        return { id: "ally-msg" };
      },
    };

    const makeApi = (guildId: string): ApiClient =>
      ({
        guildId,
        withGuild: (id: string) => makeApi(id),
        get: async (path: string) => {
          if (path === "api/events/calendar") return [event];
          if (path === "api/events") {
            return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
          }
          if (path === "api/events/revisions") {
            return [eventRevision(41, event.status, { roster_version: 0 })];
          }
          if (path === "api/events/41") return eventDetail;
          if (path === "api/battles" || path === "api/giveaways") return emptyPage();
          throw new Error(`unexpected GET ${path}`);
        },
        patch: async (path: string, body: unknown) => {
          patches.push({ guildId, path, body });
        },
      }) as unknown as ApiClient;

    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventDelivery: async () => "calendar" as const,
      eventRoleId: async () => "333333333333333333",
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
          if (id === "ally-events") return allyChannel;
          if (id === "thread-41") return thread;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, makeApi("100000000000000001"), settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(guildSends.length, 1, "calendar mode still announces a link publicly");
    assert.match(String(guildSends[0]?.content), /<@&333333333333333333>/);
    assert.equal(allySends.length, 0);
    assert.deepEqual(patches, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller rewrites the event signup card when the website roster changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 41,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "41": "thread-41" },
        eventSignupMessageIds: { "41": "signup-41" },
        eventSignupRevisions: { "41": "4:scheduled:2026-09-01T10:00:00Z" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const edits: unknown[] = [];
    const announcementEdits: unknown[] = [];
    const signup = {
      id: "signup-41",
      components: [{ components: [{ customId: "event:join:41" }] }],
      edit: async (payload: unknown) => {
        edits.push(payload);
        return signup;
      },
    };
    const thread = {
      id: "thread-41",
      isThread: () => true,
      archived: false,
      name: "Castle Fight",
      fetchStarterMessage: async () => ({
        edit: async (payload: unknown) => announcementEdits.push(payload),
      }),
      setName: async (name: string) => { thread.name = name; },
      messages: {
        fetch: async (arg: unknown) => {
          if (arg === "signup-41") return signup;
          return new Map([[signup.id, signup]]);
        },
      },
    };

    const eventDetail = {
      id: 41,
      title: "Castle Fight",
      description: null,
      call_to_arms: false,
      discord_role_ids: [],
      regear: false,
      comp_id: 7,
      comp_name: "Main ZvZ",
      created_by: 1,
      created_by_username: "Officer",
      event_date_utc: "2027-01-01T20:00:00Z",
      created_at: "2026-09-01T10:00:00Z",
      updated_at: "2026-09-01T11:00:00Z",
      roster_version: 4,
      status: "scheduled",
      started_at: null,
      stopped_at: null,
      auto_stop_deadline: null,
      link_status: "pending",
      discord_voice_channel_id: null,
      active_comp_id: 7,
      active_comp_name: "Main ZvZ",
      active_comp_capacity: 2,
      comp_builds: [
        { build_id: 10, name: "Main Tank", quantity: 1 },
        { build_id: 11, name: "Holy Healer", quantity: 1 },
      ],
      participants: [
        {
          user_id: 1,
          username: "Moved",
          discord_id: "333",
          primary_build_id: 10,
          primary_build_name: "Main Tank",
          secondary_build_id: null,
          secondary_build_name: null,
          assigned_build_id: 11,
          assigned_build_name: "Holy Healer",
        },
      ],
      splits: [{ id: 9 }],
    };

    const splitGets: string[] = [];
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") {
          return emptyPage();
        }
        if (path === "api/events/revisions") {
          return [eventRevision(41, "scheduled", {
            roster_version: 4,
            updated_at: "2026-09-01T11:00:00Z",
          })];
        }
        if (path === "api/events/41") return eventDetail;
        if (path === "api/splits/9/discord-sync") {
          splitGets.push(path);
          throw new Error("split sync is asserted by the GET, not the Forum edit");
        }
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;

    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => "forum-channel",
      eventsChannelId: async () => null,
      callToArmsChannelId: async () => null,
      battlesChannelId: async () => null,
      giveawaysChannelId: async () => null,
      giveawaysRoleId: async () => null,
    } as unknown as SettingsService;

    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === "thread-41") return thread;
          if (id === "forum-channel") return { type: 15, isThread: () => false };
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(edits.length, 1);
    assert.equal(announcementEdits.length, 1, "content-only updated_at changes refresh the forum/channel announcement");
    assert.equal(splitGets.length, 1);
    const saved = JSON.parse(readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8")) as {
      eventSignupRevisions: Record<string, string>;
    };
    assert.equal(saved.eventSignupRevisions["41"], "4:scheduled:2026-09-01T11:00:00Z");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller skips full event detail when the roster fingerprint is unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 41,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "41": "thread-41" },
        eventSignupMessageIds: { "41": "signup-41" },
        eventSignupRevisions: { "41": "4:scheduled:2026-01-01T00:00:00Z" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const apiGets: string[] = [];
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        apiGets.push(path);
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") {
          return emptyPage();
        }
        if (path === "api/events/revisions") {
          return [eventRevision(41, "scheduled", { roster_version: 4, updated_at: "2026-01-01T00:00:00Z" })];
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

    const poller = new Poller({ channels: { fetch: async () => null } } as unknown as Client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.equal(apiGets.includes("api/events/revisions"), true);
    assert.equal(apiGets.includes("api/events/41"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("each guild keeps its own checkpoint file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-111222333444555666.json"),
      JSON.stringify({ lastEventId: 40, eventThreadIds: { "28": "thread-28" } }),
      "utf-8",
    );

    const api = {
      guildId: "111222333444555666",
      get: async (path: string) => {
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") {
          return emptyPage();
        }
        if (path === "api/events/revisions") return [];
        if (path === "api/events/28") throw new ApiError(404, "Event 28 not found");
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
        fetch: async () => {
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    assert.equal(poller.guildId, "111222333444555666");
    await poller.pollNow();

    // The checkpoint was read from, and written back to, this guild's own file.
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-111222333444555666.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string> };
    assert.deepEqual(saved.eventThreadIds, {});
    assert.equal(existsSync(join(directory, "poller-state-100000000000000001.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a guild never reads another guild's checkpoint file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({ lastEventId: 40, eventThreadIds: { "28": "thread-28" } }),
      "utf-8",
    );

    const apiGets: string[] = [];
    const api = {
      guildId: "999888777666555444",
      get: async (path: string) => {
        apiGets.push(path);
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") {
          return emptyPage();
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
    const client = { channels: { fetch: async () => null } } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    // Reading the neighbouring file would inherit that tenant's event thread
    // (and its `lastEventId`, silencing this guild's real announcements).
    assert.equal(
      apiGets.some((path) => path.startsWith("api/events/")),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a poller refuses an unscoped API client", () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    // Without a guild there is no tenant header, so every backend call would
    // come back 400 and the checkpoint would have no name to be filed under.
    assert.throws(
      () =>
        new Poller(
          {} as unknown as Client,
          {} as unknown as ApiClient,
          {} as unknown as SettingsService,
          60_000,
          directory,
        ),
      /needs a guild-scoped ApiClient/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Builds a guild whose backlog would be replayed into Discord if the poller
 * ever treated an absent or unreadable checkpoint file as "everything is new".
 */
function backlogFixtures() {
  const events = [
    { id: 11, title: "Old mass", status: "stopped", call_to_arms: false, archived_at: null },
    { id: 12, title: "Cancelled mass", status: "cancelled", call_to_arms: false, archived_at: null },
    { id: 13, title: "Open mass", status: "scheduled", call_to_arms: false, archived_at: null },
  ];
  const battles = [{ battle_id: 900 }, { battle_id: 901 }];
  const giveaways = [{ id: 5 }, { id: 6 }];
  return { events, battles, giveaways };
}

function backlogHarness(sent: string[]) {
  const { events, battles, giveaways } = backlogFixtures();
  const page = (items: unknown[]) => ({
    items,
    total_items: items.length,
    total_pages: 1,
    current_page: 1,
    limit: 50,
  });

  const api = {
    guildId: "100000000000000002",
    get: async (path: string) => {
      if (path === "api/events/calendar") return events;
      if (path === "api/events") return page(events);
      if (path === "api/battles") return page(battles);
      if (path === "api/giveaways") return page(giveaways);
      if (path === "api/events/revisions") return [];
      if (path === "api/splits/discord-sync") return { items: [], has_more: false };
      const eventMatch = /^api\/events\/(\d+)$/.exec(path);
      if (eventMatch) {
        const found = events.find((event) => event.id === Number(eventMatch[1]));
        if (!found) throw new ApiError(404, `Event ${eventMatch[1]} not found`);
        return { ...found, roster_version: 1, participants: [], comp: null };
      }
      const giveawayMatch = /^api\/giveaways\/(\d+)$/.exec(path);
      if (giveawayMatch) return { id: Number(giveawayMatch[1]), status: "open", entries: [] };
      throw new Error(`unexpected GET ${path}`);
    },
  } as unknown as ApiClient;

  const settings = {
    applicationsSettings: async () => ({ discord_applications_open: true }),
    splitsForumChannelId: async () => null,
    eventsChannelId: async () => "events-channel",
    callToArmsChannelId: async () => "cta-channel",
    battlesChannelId: async () => "battles-channel",
    giveawaysChannelId: async () => "giveaways-channel",
    giveawaysRoleId: async () => null,
  } as unknown as SettingsService;

  const channel = {
    id: "events-channel",
    isTextBased: () => true,
    isDMBased: () => false,
    send: async () => {
      sent.push("message");
      return {
        id: "message",
        startThread: async () => ({
          id: "thread",
          isThread: () => true,
          send: async () => ({ id: "signup" }),
        }),
        edit: async () => undefined,
      };
    },
  };

  const client = {
    channels: { fetch: async () => channel },
  } as unknown as Client;

  return { api, settings, client, events };
}

test("poller announces nothing on a first run with no checkpoint file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const sent: string[] = [];
    const { api, settings, client } = backlogHarness(sent);

    // No state file: this is a restart onto an empty state directory, a fresh
    // container, or a newly added tenant.
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.deepEqual(sent, [], "a first poll must not replay the existing backlog");

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000002.json"), "utf-8"),
    ) as { lastEventId: number; lastBattleId: number; lastGiveawayId: number; initialized: boolean };
    assert.equal(saved.initialized, true);
    assert.equal(saved.lastEventId, 13);
    assert.equal(saved.lastBattleId, 901);
    assert.equal(saved.lastGiveawayId, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller announces nothing when the checkpoint file is corrupt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000002.json"),
      "{ not json",
      "utf-8",
    );

    const sent: string[] = [];
    const { api, settings, client } = backlogHarness(sent);
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.deepEqual(sent, [], "an unreadable checkpoint must not replay the backlog");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller never announces an event that is no longer awaiting its start", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    // A real checkpoint that sits behind the whole backlog: these events are
    // "new" to the poller, but two of them are already over.
    writeFileSync(
      join(directory, "poller-state-100000000000000002.json"),
      JSON.stringify({
        lastEventId: 10,
        lastBattleId: 901,
        lastGiveawayId: 6,
        pinged1hEvents: [],
        eventThreadIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        applicationsOpen: true,
        initialized: true,
      }),
      "utf-8",
    );

    const sent: string[] = [];
    const { api, settings, client } = backlogHarness(sent);
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    // Only the scheduled event is announced; the stopped and cancelled ones are
    // skipped, and the checkpoint moves past all three.
    assert.equal(sent.length, 1, "only the still-scheduled event may be announced");

    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000002.json"), "utf-8"),
    ) as { lastEventId: number };
    assert.equal(saved.lastEventId, 13);

    sent.length = 0;
    await poller.pollNow();
    assert.deepEqual(sent, [], "a second poll must not re-announce anything");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function liveVoiceEvent() {
  return {
    id: 41,
    title: "Castle Fight",
    description: null,
    call_to_arms: false,
    discord_role_ids: [],
    regear: false,
    comp_id: 7,
    comp_name: "Main ZvZ",
    created_by: 1,
    created_by_username: "Officer",
    event_date_utc: "2026-09-01T20:00:00Z",
    mass_time_utc: "2026-09-01T19:30:00Z",
    start_time_utc: "2026-09-01T20:00:00Z",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T20:00:00Z",
    status: "live",
    started_at: "2026-09-01T20:00:00Z",
    stopped_at: null,
    auto_stop_deadline: null,
    link_status: "in_progress",
    discord_voice_channel_id: "voice-41",
  };
}

function liveVoicePollerHarness(directory: string, occupantChannelIds: string[]) {
  const event = liveVoiceEvent();
  const posts: string[] = [];
  const voiceChannel = {
    id: "voice-41",
    isVoiceBased: () => true,
    members: { size: 0 },
    guild: {
      voiceStates: {
        cache: {
          filter: (predicate: (state: { channelId: string | null }) => boolean) => ({
            size: occupantChannelIds.map((id) => ({ channelId: id })).filter(predicate).length,
          }),
        },
      },
    },
    delete: async () => undefined,
  };
  const api = {
    guildId: "100000000000000001",
    get: async (path: string) => {
      if (path === "api/events") {
        return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
      }
      if (path === "api/events/revisions") return [eventRevision(41, event.status)];
      if (path === "api/battles" || path === "api/giveaways") return emptyPage();
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string) => {
      posts.push(path);
      if (path === "api/events/41/stop") return { ...event, status: "stopped" };
      throw new Error(`unexpected POST ${path}`);
    },
    delete: async (path: string) => {
      if (path === "api/events/41/discord-voice-channel") {
        return { ...event, status: "stopped", discord_voice_channel_id: null };
      }
      throw new Error(`unexpected DELETE ${path}`);
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
        if (id === "voice-41") return voiceChannel;
        throw new Error(`unexpected channel ${id}`);
      },
    },
  } as unknown as Client;
  writeFileSync(
    join(directory, "poller-state-100000000000000001.json"),
    JSON.stringify({
      lastEventId: 41,
      lastBattleId: 0,
      pinged1hEvents: [],
      eventThreadIds: {},
      splitUpdatedAt: null,
      splitAfterId: null,
      massedEvents: [41],
      emptyLiveChecks: {},
      occupiedLiveEvents: [],
      initialized: true,
    }),
    "utf-8",
  );
  return { posts, poller: new Poller(client, api, settings, 60_000, directory) };
}

test("poller does not auto-stop a live Mass voice that has never been occupied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const occupants: string[] = [];
    const { posts, poller } = liveVoicePollerHarness(directory, occupants);
    await poller.pollNow();
    await poller.pollNow();
    assert.deepEqual(posts, [], "Start must not delete an unused Mass voice");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller auto-stops a live voice only after occupancy then two empty ticks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const occupants = ["voice-41"];
    const { posts, poller } = liveVoicePollerHarness(directory, occupants);
    await poller.pollNow();
    assert.deepEqual(posts, []);
    occupants.length = 0;
    await poller.pollNow();
    assert.deepEqual(posts, []);
    await poller.pollNow();
    assert.deepEqual(posts, ["api/events/41/stop"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poller sweeps old empty orphan event voice channels but preserves active, occupied, and recent ones", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const deletedChannels: string[] = [];
    const clearedBindings: string[] = [];
    const now = Date.now();
    const makeVoice = (
      id: string,
      eventId: number,
      ageMs: number,
      occupants: string[] = [],
    ) => ({
      id,
      name: `Event ${eventId} — Test`,
      type: ChannelType.GuildVoice,
      createdTimestamp: now - ageMs,
      isVoiceBased: () => true,
      guild: {
        voiceStates: {
          cache: {
            filter: (predicate: (state: { channelId: string | null }) => boolean) => ({
              size: occupants.map((channelId) => ({ channelId })).filter(predicate).length,
            }),
          },
        },
      },
      delete: async () => {
        deletedChannels.push(id);
      },
    });
    const channels = [
      makeVoice("voice-orphan", 10, 60 * 60 * 1000),
      makeVoice("voice-active", 11, 60 * 60 * 1000),
      makeVoice("voice-stopped", 12, 60 * 60 * 1000),
      makeVoice("voice-occupied", 13, 60 * 60 * 1000, ["voice-occupied"]),
      makeVoice("voice-recent", 14, 5 * 60 * 1000),
    ];
    const category = {
      type: ChannelType.GuildCategory,
      children: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    };
    const details: Record<number, Partial<EventDetailView>> = {
      11: {
        id: 11,
        status: "scheduled",
        archived_at: null,
        discord_voice_channel_id: "voice-active",
      },
      12: {
        id: 12,
        status: "stopped",
        archived_at: null,
        discord_voice_channel_id: "voice-stopped",
      },
    };
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events" || path === "api/battles" || path === "api/giveaways") {
          return emptyPage();
        }
        const eventMatch = /^api\/events\/(\d+)$/.exec(path);
        if (eventMatch) {
          const eventId = Number(eventMatch[1]);
          const detail = details[eventId];
          if (!detail) throw new ApiError(404, "Event not found");
          return detail;
        }
        throw new Error(`unexpected GET ${path}`);
      },
      delete: async (path: string) => {
        clearedBindings.push(path);
        return null;
      },
    } as unknown as ApiClient;
    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventChannelRoutes: async () => ({
        events: null,
        callToArms: null,
        flashMass: null,
      }),
      eventVoiceCategoryId: async () => "event-voice-category",
    } as unknown as SettingsService;
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === "event-voice-category") return category;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 20,
        lastBattleId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        occupiedLiveEvents: [],
        lastVoiceSweepAt: now - 16 * 60 * 1000,
        initialized: true,
      }),
      "utf-8",
    );

    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    assert.deepEqual(deletedChannels.sort(), ["voice-orphan", "voice-stopped"]);
    assert.deepEqual(clearedBindings, ["api/events/12/discord-voice-channel"]);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { lastVoiceSweepAt: number };
    assert.ok(saved.lastVoiceSweepAt >= now);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual event calendar refresh routes all events and uses the caller's permission context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const event = (
      id: number,
      title: string,
      callToArms: boolean,
    ): EventView => ({
      id,
      title,
      description: null,
      call_to_arms: callToArms,
      event_kind: "organized",
      discord_role_ids: [],
      regear: false,
      comp_id: 1,
      comp_name: "Main",
      created_by: 1,
      created_by_username: "Officer",
      event_date_utc: "2030-01-01T20:00:00Z",
      created_at: "2029-12-01T10:00:00Z",
      updated_at: "2029-12-01T10:00:00Z",
      status: "scheduled",
      started_at: null,
      stopped_at: null,
      auto_stop_deadline: null,
      discord_voice_channel_id: null,
      link_status: "pending",
    });
    const events = [
      event(1, "Standard event", false),
      event(2, "Urgent CTA event", true),
    ];
    const payloads = new Map<string, Record<string, unknown>>();
    const sentChannels: string[] = [];
    const editedChannels: string[] = [];
    const channels = new Map(
      ["events-channel"].map((id) => [
        id,
        {
          id,
          isTextBased: () => true,
          threads: { create: async () => undefined },
          messages: {
            fetch: async () => ({
              id: `${id}-calendar`,
              edit: async (payload: Record<string, unknown>) => {
                editedChannels.push(id);
                payloads.set(id, payload);
              },
            }),
          },
          send: async (payload: Record<string, unknown>) => {
            sentChannels.push(id);
            payloads.set(id, payload);
            return { id: `${id}-calendar` };
          },
        },
      ]),
    );
    const api = {
      guildId: "100000000000000099",
      get: async (path: string, discordId?: string) => {
        assert.equal(path, "api/events/calendar");
        assert.equal(discordId, "calendar-manager");
        return events;
      },
    } as unknown as ApiClient;
    const settings = {
      eventDelivery: async () => "calendar" as const,
      eventsChannelId: async () => "events-channel",
      callToArmsChannelId: async () => "cta-channel",
      eventChannelRoutes: async () => ({
        events: "events-channel",
        callToArms: "cta-channel",
        flashMass: null,
      }),
    } as unknown as SettingsService;
    const client = {
      channels: {
        fetch: async (id: string) => channels.get(id) ?? null,
      },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);

    const result = await poller.refreshEventCalendars("calendar-manager");

    assert.equal(result.eventCount, 2);
    assert.equal(result.configuredChannels, 1);
    assert.deepEqual(result.updatedChannels, ["events-channel"]);
    assert.deepEqual(result.failedChannels, []);
    assert.deepEqual(sentChannels, ["events-channel"]);
    assert.match(JSON.stringify(payloads.get("events-channel")), /Standard event/);
    assert.match(JSON.stringify(payloads.get("events-channel")), /Urgent CTA event/);

    await poller.refreshEventCalendars("calendar-manager");
    assert.deepEqual(editedChannels, []);
    assert.deepEqual(sentChannels, ["events-channel"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("calendar page messages are stored, edited, and removed as pages disappear", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000099.json"),
      JSON.stringify({
        eventCalendarMessageIds: { "events-channel": "legacy-calendar-message" },
        initialized: true,
      }),
      "utf-8",
    );
    let events = Array.from(
      { length: 40 },
      (_, index) => calendarEvent(index + 1, `Scheduled event ${index + 1} — upcoming mass`),
    );
    const messages = new Map<string, Message>();
    let sends = 0;
    let edits = 0;
    let deletes = 0;
    const makeMessage = (id: string): Message => {
      const message = {
        id,
        edit: async () => {
          edits++;
          return message;
        },
        delete: async () => {
          deletes++;
          messages.delete(id);
        },
      } as unknown as Message;
      messages.set(id, message);
      return message;
    };
    makeMessage("legacy-calendar-message");
    const channel = {
      id: "events-channel",
      isTextBased: () => true,
      threads: { create: async () => undefined },
      messages: {
        fetch: async (id: string) => {
          const message = messages.get(id);
          if (!message) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return message;
        },
      },
      send: async () => makeMessage(`calendar-page-${++sends}`),
    };
    const api = {
      guildId: "100000000000000099",
      get: async (path: string, discordId?: string) => {
        assert.equal(path, "api/events/calendar");
        assert.equal(discordId, "calendar-manager");
        return events;
      },
    } as unknown as ApiClient;
    const settings = {
      eventDelivery: async () => "calendar" as const,
      eventsChannelId: async () => "events-channel",
      callToArmsChannelId: async () => null,
    } as unknown as SettingsService;
    const client = {
      channels: { fetch: async () => channel },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);

    await poller.refreshEventCalendars("calendar-manager");
    const initialPageCount = messages.size;
    assert.ok(initialPageCount > 1);
    assert.equal(edits, 1);

    events = [calendarEvent(1, "Only remaining event")];
    await poller.refreshEventCalendars("calendar-manager");

    assert.equal(messages.size, 1);
    assert.equal(deletes, initialPageCount - 1);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000099.json"), "utf-8"),
    ) as { eventCalendarMessageIds: Record<string, string[]> };
    assert.equal(saved.eventCalendarMessageIds["events-channel"]?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduled and manual calendar refreshes serialize without duplicating messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const apiActors: Array<string | undefined> = [];
    const api = {
      guildId: "100000000000000100",
      get: async (path: string, discordId?: string) => {
        assert.equal(path, "api/events/calendar");
        apiActors.push(discordId);
        return [];
      },
    } as unknown as ApiClient;
    const settings = {
      eventsChannelId: async () => "events-channel",
      callToArmsChannelId: async () => null,
      eventDelivery: async () => "calendar",
    } as unknown as SettingsService;
    let sendCount = 0;
    let editCount = 0;
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let storedMessage: Message | undefined;
    const channel = {
      id: "events-channel",
      isTextBased: () => true,
      threads: { create: async () => undefined },
      messages: {
        fetch: async () => {
          if (!storedMessage) {
            throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          }
          return storedMessage;
        },
      },
      send: async () => {
        sendCount++;
        if (sendCount === 1) {
          markSendStarted();
          await sendGate;
        }
        const message = {
          id: "calendar-message",
          edit: async () => {
            editCount++;
            return message;
          },
          delete: async () => undefined,
        } as unknown as Message;
        storedMessage = message;
        return message;
      },
    };
    const client = {
      channels: { fetch: async () => channel },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);

    const manualRefresh = poller.refreshEventCalendars("calendar-manager");
    await sendStarted;
    const scheduledRefresh = (
      poller as unknown as { updateEventCalendars(): Promise<void> }
    ).updateEventCalendars();
    releaseSend();
    await Promise.all([manualRefresh, scheduledRefresh]);

    assert.equal(sendCount, 1);
    assert.equal(editCount, 0, "unchanged calendar content should not be rewritten");
    assert.deepEqual(apiActors, ["calendar-manager", undefined]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed checkpoint seed does not persist empty cursors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const sent: string[] = [];
    const { api, settings, client } = backlogHarness(sent);
    const failing = {
      ...api,
      get: async (path: string) => {
        if (path === "api/battles") throw new Error("database unavailable");
        return api.get(path);
      },
    } as unknown as ApiClient;
    const poller = new Poller(client, failing, settings, 60_000, directory);
    await poller.pollNow();
    assert.equal(
      existsSync(join(directory, "poller-state-100000000000000002.json")),
      false,
      "a partial seed must not be written",
    );
    assert.deepEqual(sent, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A tenant whose rank does not include the battles or giveaways module (an
 * alliance on the default rank, typically) gets 403 from those lists. Events
 * are the only list the announcer cannot do without.
 */
function fullBattle(battleId: number) {
  return {
    battle_id: battleId,
    start_time: "2030-01-02T00:00:00Z",
    end_time: "2030-01-02T00:00:00Z",
    total_players: 0,
    total_kills: 0,
    total_fame: 0,
    guilds: [],
  };
}

function modulesRefusedHarness(refused: { battles: boolean; giveaways: boolean }, sent: string[]) {
  const base = backlogHarness([]);
  const battles = [900, 901].map(fullBattle);
  const api = {
    guildId: "100000000000000002",
    get: async (path: string, discordId?: string, params?: Record<string, string | number>) => {
      if (path === "api/battles") {
        if (refused.battles) throw new ApiError(403, "the battles module is not enabled for this guild");
        return { items: battles, total_items: battles.length, total_pages: 1, current_page: 1, limit: 10 };
      }
      if (path === "api/giveaways" && refused.giveaways) {
        throw new ApiError(403, "the giveaways module is not enabled for this guild");
      }
      return (base.api as unknown as { get: (...args: unknown[]) => Promise<unknown> }).get(
        path,
        discordId,
        params,
      );
    },
  } as unknown as ApiClient;
  const channel = {
    id: "events-channel",
    isTextBased: () => true,
    isDMBased: () => false,
    send: async (payload: { content?: string; embeds?: Array<{ data?: { footer?: { text?: string } } }> }) => {
      const battle = /Battle #(\d+)/.exec(payload.embeds?.[0]?.data?.footer?.text ?? "");
      sent.push(battle ? `battle:${battle[1]}` : `event:${payload.content ?? ""}`);
      return {
        id: "message",
        startThread: async () => ({
          id: "thread",
          isThread: () => true,
          send: async () => ({ id: "signup" }),
        }),
      };
    },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  return { api, settings: base.settings, client, events: base.events, battles };
}

test("a tenant without the battles and giveaways modules still seeds and announces events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const sent: string[] = [];
    const { api, settings, client, events } = modulesRefusedHarness(
      { battles: true, giveaways: true },
      sent,
    );
    const poller = new Poller(client, api, settings, 60_000, directory);

    await poller.pollNow();
    const file = join(directory, "poller-state-100000000000000002.json");
    assert.equal(
      existsSync(file),
      true,
      "a 403 from an optional module must not keep the whole poller unseeded",
    );
    assert.deepEqual(sent, [], "the seed never replays the backlog");

    events.push({
      id: 14,
      title: "Alliance mass",
      status: "scheduled",
      call_to_arms: false,
      archived_at: null,
    });
    await poller.pollNow();

    const posts: string[] = sent;
    assert.equal(posts.length, 1);
    assert.match(posts[0] ?? "", /^event:.*Alliance mass/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a module that becomes available later is adopted silently, then announced from there", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const sent: string[] = [];
    const refused = { battles: true, giveaways: false };
    const { api, settings, client, battles } = modulesRefusedHarness(refused, sent);
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();

    // The platform grants the module. Battles 900 and 901 already exist and
    // belong to history, so nothing is replayed into the channel.
    refused.battles = false;
    await poller.pollNow();
    assert.deepEqual(sent, []);

    battles.push(fullBattle(902));
    await poller.pollNow();
    assert.deepEqual(sent, ["battle:902"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an event page that is not the oldest does not skip older unannounced ids", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 0,
        lastBattleId: 0,
        lastGiveawayId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        initialized: true,
        applicationsOpen: true,
      }),
      "utf-8",
    );
    const older = calendarEvent(1, "Older mass");
    const newer = calendarEvent(2, "Newer mass");
    const announced: string[] = [];
    const thread = {
      id: "thread",
      isThread: () => true,
      send: async () => ({ id: "signup" }),
    };
    const channel = {
      id: "events-channel",
      isTextBased: () => true,
      isDMBased: () => false,
      threads: { create: async () => { throw new Error("private thread must not be used"); } },
      send: async (payload: { content?: string }) => {
        announced.push(String(payload.content));
        return { id: `msg-${announced.length}`, startThread: async () => thread, edit: async () => undefined };
      },
    };
    const api = {
      guildId: "100000000000000001",
      get: async (path: string, _discordId?: string, params?: Record<string, string | number>) => {
        if (path === "api/events") {
          const page = Number(params?.page ?? 1);
          const items = page === 1 ? [newer] : page === 2 ? [older] : [];
          return { items, total_items: 2, total_pages: 2, current_page: page, limit: 1 };
        }
        if (path === "api/events/calendar") return [older, newer];
        if (path === "api/events/revisions") return [];
        if (path === "api/events/1") return { ...older, participants: [], comp_builds: [] };
        if (path === "api/events/2") return { ...newer, participants: [], comp_builds: [] };
        if (path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/splits/discord-sync") return { items: [], has_more: false };
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
      channels: { fetch: async () => channel },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    const olderAt = announced.findIndex((content) => content.includes("Older mass"));
    const newerAt = announced.findIndex((content) => content.includes("Newer mass"));
    assert.ok(olderAt >= 0 && newerAt > olderAt, "older ids must be announced, not skipped by page 1");
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { lastEventId: number };
    assert.equal(saved.lastEventId, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed signup card is retried without a second parent announcement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 0,
        lastBattleId: 0,
        lastGiveawayId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        eventParentMessageIds: {},
        eventSignupMessageIds: {},
        pendingAnnounces: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        initialized: true,
        applicationsOpen: true,
      }),
      "utf-8",
    );
    const event = calendarEvent(7, "Retry mass");
    let parentSends = 0;
    let signupAttempts = 0;
    const thread = {
      id: "thread-7",
      isThread: () => true,
      send: async () => {
        signupAttempts++;
        if (signupAttempts === 1) throw new Error("discord unavailable");
        return { id: "signup-7" };
      },
    };
    const parent = {
      id: "parent-7",
      startThread: async () => thread,
    };
    const channel = {
      id: "events-channel",
      isTextBased: () => true,
      isDMBased: () => false,
      messages: { fetch: async (id: string) => (id === "parent-7" ? parent : Promise.reject(new Error(id))) },
      send: async () => {
        parentSends++;
        return parent;
      },
    };
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events") {
          return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        }
        if (path === "api/events/calendar") return [event];
        if (path === "api/events/revisions") return [eventRevision(7, "scheduled")];
        if (path === "api/events/7") return { ...event, participants: [], comp_builds: [] };
        if (path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/splits/discord-sync") return { items: [], has_more: false };
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
          if (id === "thread-7") return thread;
          if (id === "events-channel") return channel;
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    assert.equal(parentSends, 1);
    assert.equal(signupAttempts, 1);
    let saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { pendingAnnounces: Record<string, { status?: string }>; eventThreadIds: Record<string, string> };
    assert.equal(saved.pendingAnnounces["7"]?.status, "failed");
    assert.equal(saved.eventThreadIds["7"], "thread-7");

    await poller.pollNow();
    assert.equal(parentSends, 1, "retry must reuse the parent announcement");
    assert.equal(signupAttempts, 2);
    saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as typeof saved;
    assert.equal(saved.pendingAnnounces["7"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint seed uses the highest id on every page, not page 1", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const sent: string[] = [];
    const { settings, client } = backlogHarness(sent);
    const api = {
      guildId: "100000000000000002",
      get: async (path: string, _discordId?: string, params?: Record<string, string | number>) => {
        const page = Number(params?.page ?? 1);
        if (path === "api/events") {
          const items = page === 1 ? [{ id: 2 }] : page === 2 ? [{ id: 10 }] : [];
          return { items, total_items: 2, total_pages: 2, current_page: page, limit: 50 };
        }
        if (path === "api/battles") {
          const items = page === 1 ? [{ battle_id: 3 }] : [{ battle_id: 8 }];
          return { items, total_items: 2, total_pages: 2, current_page: page, limit: 10 };
        }
        if (path === "api/giveaways") {
          const items = page === 1 ? [{ id: 1 }] : [{ id: 4 }];
          return { items, total_items: 2, total_pages: 2, current_page: page, limit: 50 };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    assert.deepEqual(sent, []);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000002.json"), "utf-8"),
    ) as { lastEventId: number; lastBattleId: number; lastGiveawayId: number; initialized: boolean };
    assert.equal(saved.initialized, true);
    assert.equal(saved.lastEventId, 10);
    assert.equal(saved.lastBattleId, 8);
    assert.equal(saved.lastGiveawayId, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("battle announcements do not skip a higher id that is sorted onto a later page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 0,
        lastBattleId: 0,
        lastGiveawayId: 0,
        pinged1hEvents: [],
        eventThreadIds: {},
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        initialized: true,
        applicationsOpen: true,
      }),
      "utf-8",
    );
    const battle = (battleId: number, start: string) => ({
      battle_id: battleId,
      start_time: start,
      end_time: start,
      total_players: 0,
      total_kills: 0,
      total_fame: 0,
      guilds: [],
    });
    const announced: number[] = [];
    const api = {
      guildId: "100000000000000001",
      get: async (path: string, _discordId?: string, params?: Record<string, string | number>) => {
        const page = Number(params?.page ?? 1);
        if (path === "api/events" || path === "api/giveaways") return emptyPage();
        if (path === "api/events/calendar" || path === "api/events/revisions") return [];
        if (path === "api/battles") {
          const items = page === 1
            ? [battle(2, "2030-01-02T00:00:00Z")]
            : [battle(9, "2020-01-01T00:00:00Z")];
          return { items, total_items: 2, total_pages: 2, current_page: page, limit: 10 };
        }
        if (path === "api/splits/discord-sync") return { items: [], has_more: false };
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;
    const settings = {
      applicationsSettings: async () => ({ discord_applications_open: true }),
      splitsForumChannelId: async () => null,
      eventsChannelId: async () => null,
      callToArmsChannelId: async () => null,
      battlesChannelId: async () => "battles-channel",
      giveawaysChannelId: async () => null,
      giveawaysRoleId: async () => null,
    } as unknown as SettingsService;
    const channel = {
      id: "battles-channel",
      isTextBased: () => true,
      isDMBased: () => false,
      send: async (payload: { embeds?: Array<{ data?: { footer?: { text?: string } } }> }) => {
        const footer = payload.embeds?.[0]?.data?.footer?.text ?? "";
        const match = /Battle #(\d+)/.exec(footer);
        if (match) announced.push(Number(match[1]));
        return { id: "battle-msg" };
      },
    };
    const client = {
      channels: { fetch: async () => channel },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    assert.deepEqual(announced.sort((a, b) => a - b), [2, 9]);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { lastBattleId: number };
    assert.equal(saved.lastBattleId, 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a transient thread fetch keeps the mapping and does not call startThread again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(
      join(directory, "poller-state-100000000000000001.json"),
      JSON.stringify({
        lastEventId: 7,
        lastBattleId: 0,
        lastGiveawayId: 0,
        pinged1hEvents: [],
        eventThreadIds: { "7": "thread-7" },
        eventParentMessageIds: { "7": "parent-7" },
        eventSignupMessageIds: {},
        pendingAnnounces: {
          "7": { attempts: 1, lastError: "signup", since: "2026-01-01T00:00:00Z", status: "failed" },
        },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
        initialized: true,
        applicationsOpen: true,
      }),
      "utf-8",
    );
    const event = calendarEvent(7, "Retry mass");
    let threadFetches = 0;
    let startThreadCalls = 0;
    const thread = {
      id: "thread-7",
      isThread: () => true,
      send: async () => ({ id: "signup-7" }),
    };
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        if (path === "api/events") {
          return { items: [event], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        }
        if (path === "api/events/calendar") return [event];
        if (path === "api/events/revisions") return [eventRevision(7, "scheduled")];
        if (path === "api/events/7") return { ...event, participants: [], comp_builds: [] };
        if (path === "api/battles" || path === "api/giveaways") return emptyPage();
        if (path === "api/splits/discord-sync") return { items: [], has_more: false };
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
          if (id === "thread-7") {
            threadFetches++;
            if (threadFetches === 1) throw new Error("discord timeout");
            return thread;
          }
          if (id === "events-channel") {
            return {
              id,
              isTextBased: () => true,
              isDMBased: () => false,
              messages: { fetch: async () => ({ id: "parent-7", startThread: async () => { startThreadCalls++; return thread; } }) },
              send: async () => {
                throw new Error("parent must not be sent again");
              },
            };
          }
          throw new Error(`unexpected channel ${id}`);
        },
      },
    } as unknown as Client;
    const poller = new Poller(client, api, settings, 60_000, directory);
    await poller.pollNow();
    let saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { eventThreadIds: Record<string, string>; pendingAnnounces: Record<string, unknown> };
    assert.equal(saved.eventThreadIds["7"], "thread-7");
    assert.equal(startThreadCalls, 0);
    assert.ok(saved.pendingAnnounces["7"]);

    await poller.pollNow();
    assert.equal(startThreadCalls, 0);
    saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as typeof saved;
    assert.equal(saved.pendingAnnounces["7"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("forum delivery posts signup controls and retries a failed card without duplicating the forum post", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-forum-"));
  try {
    let creates = 0;
    let cardAttempts = 0;
    const starterEdits: unknown[] = [];
    const cardPayloads: unknown[] = [];
    const thread = {
      id: "forum-thread",
      isThread: () => true,
      fetchStarterMessage: async () => ({
        id: "forum-starter",
        edit: async (payload: unknown) => {
        cardAttempts++;
        cardPayloads.push(payload);
        if (cardAttempts === 1) throw new Error("temporary send failure");
        starterEdits.push(payload);
        return { id: "forum-starter" };
        },
      }),
      setName: async () => undefined,
      setAppliedTags: async () => undefined,
    };
    const forum = {
      type: ChannelType.GuildForum,
      flags: { has: () => false },
      availableTags: [],
      threads: {
        create: async () => {
          creates++;
          return thread;
        },
      },
    };
    const settings = {
      eventsForumChannelId: async () => "forum",
      get: async () => ({}),
    } as unknown as SettingsService;
    const client = {
      channels: {
        fetch: async (id: string) => id === "forum" ? forum : thread,
      },
    } as unknown as Client;
    const api = { guildId: "100000000000000001" } as unknown as ApiClient;
    const poller = new Poller(client, api, settings, 60_000, directory);
    const event = {
      ...calendarEvent(99, "Forum event"),
      event_kind: "organized",
      status: "scheduled",
      roster_version: 3,
      participants: [],
      comp_builds: [],
      splits: [],
    } as unknown as EventDetailView;
    const post = () => (poller as unknown as {
      postEventForum(value: EventDetailView): Promise<boolean>;
    }).postEventForum(event);

    assert.equal(await post(), false);
    assert.equal(await post(), true);
    assert.equal(creates, 1);
    assert.equal(cardAttempts, 2);
    assert.ok(cardPayloads.some((payload) => JSON.stringify(payload).includes("event:join:99")));
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as {
      eventThreadIds: Record<string, string>;
      eventSignupMessageIds: Record<string, string>;
      eventSignupRevisions: Record<string, string>;
    };
    assert.equal(saved.eventThreadIds["99"], "forum-thread");
    assert.equal(saved.eventSignupMessageIds["99"], "forum-starter");
    assert.equal(saved.eventSignupRevisions["99"], "3:scheduled:2029-12-01T10:00:00Z");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archived event restores reconcile once through each tenant delivery mode", async () => {
  for (const delivery of ["calendar", "message", "forum"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `poller-restore-${delivery}-`));
    try {
      const event = { ...calendarEvent(88, "Restored event"), archived_at: null };
      const api = {
        guildId: "100000000000000001",
        get: async (path: string) => {
          assert.equal(path, "api/events/88");
          return event;
        },
      } as unknown as ApiClient;
      const settings = { eventDelivery: async () => delivery } as unknown as SettingsService;
      const poller = new Poller({ channels: { fetch: async () => null } } as unknown as Client, api, settings, 60_000, directory);
      const internals = poller as unknown as {
        state: {
          archivedEventIds: number[];
          eventThreadIds: Record<string, string>;
          eventSignupMessageIds: Record<string, string>;
        };
        announceEvent(value: EventView, routes: unknown): Promise<void>;
        loadEventChannelRoutes(): Promise<unknown>;
        checkRestoredEvents(): Promise<void>;
      };
      internals.loadEventChannelRoutes = async () => ({ events: null, callToArms: null, flashMass: null });
      internals.state.archivedEventIds.push(event.id);
      const deliveries: string[] = [];
      internals.announceEvent = async (restored) => {
        deliveries.push(`${delivery}:${restored.id}`);
        internals.state.eventThreadIds[String(restored.id)] = `thread-${delivery}`;
        internals.state.eventSignupMessageIds[String(restored.id)] = `signup-${delivery}`;
      };

      await internals.checkRestoredEvents();
      await internals.checkRestoredEvents();

      assert.deepEqual(deliveries, [`${delivery}:88`]);
      assert.deepEqual(internals.state.archivedEventIds, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("ambiguous event forum creation remains pending and is not retried automatically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-forum-ambiguous-"));
  try {
    let creates = 0;
    const event = {
      ...calendarEvent(89, "Ambiguous forum event"),
      event_kind: "organized",
      status: "scheduled",
      call_to_arms: false,
      roster_version: 0,
    };
    const forum = {
      type: ChannelType.GuildForum,
      flags: { has: () => false },
      availableTags: [],
      threads: {
        create: async () => {
          creates++;
          throw new Error("connection lost after request");
        },
      },
    };
    const settings = {
      eventDelivery: async () => "forum" as const,
      eventsForumChannelId: async () => "forum",
      get: async () => ({}),
    } as unknown as SettingsService;
    const client = { channels: { fetch: async () => forum } } as unknown as Client;
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        assert.equal(path, "api/events/89");
        return { ...event, participants: [], comp_builds: [], splits: [] };
      },
    } as unknown as ApiClient;
    const poller = new Poller(client, api, settings, 60_000, directory);
    const deliver = () => (poller as unknown as {
      announceEvent(event: EventView, routes: unknown): Promise<void>;
    }).announceEvent(event as EventView, { events: null, callToArms: null, flashMass: null });

    await deliver();
    await deliver();

    assert.equal(creates, 1);
    const saved = JSON.parse(
      readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8"),
    ) as { pendingAnnounces: Record<string, { status?: string }> };
    assert.equal(saved.pendingAnnounces["89"]?.status, "ambiguous");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── Poller hotfixes: state safety, thread retention, scheduling queries ─────

const HOTFIX_GUILD = "100000000000000500";

function hotfixStateFile(directory: string): string {
  return join(directory, `poller-state-${HOTFIX_GUILD}.json`);
}

function writeHotfixState(directory: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    hotfixStateFile(directory),
    JSON.stringify({
      lastEventId: 5000,
      lastBattleId: 0,
      lastGiveawayId: 0,
      pinged1hEvents: [],
      eventThreadIds: {},
      splitUpdatedAt: null,
      splitAfterId: null,
      massedEvents: [],
      emptyLiveChecks: {},
      initialized: true,
      ...extra,
    }),
    "utf-8",
  );
}

const hotfixSettings = {
  applicationsSettings: async () => ({ discord_applications_open: true }),
  splitsForumChannelId: async () => null,
  eventsChannelId: async () => null,
  callToArmsChannelId: async () => null,
  battlesChannelId: async () => null,
  giveawaysChannelId: async () => null,
  giveawaysRoleId: async () => null,
} as unknown as SettingsService;

interface ListCall {
  path: string;
  params?: Record<string, string | number>;
}

/** Fake `api/events` that honours `status`, `sort`/`order` and paging like the backend. */
function scheduledEventsApi(events: EventView[], calls: ListCall[] = []): ApiClient {
  return {
    guildId: HOTFIX_GUILD,
    get: async (path: string, _discordId?: string, params?: Record<string, string | number>) => {
      calls.push({ path, params });
      if (path === "api/events") {
        const limit = Number(params?.limit ?? 20);
        const page = Number(params?.page ?? 1);
        let rows = events.filter((event) => !params?.status || event.status === params.status);
        rows = [...rows].sort((a, b) => a.event_date_utc.localeCompare(b.event_date_utc));
        // The backend default is newest-first; only an explicit `order=asc` flips it.
        if (params?.order !== "asc") rows.reverse();
        return {
          items: rows.slice((page - 1) * limit, page * limit),
          total_items: rows.length,
          total_pages: Math.max(1, Math.ceil(rows.length / limit)),
          current_page: page,
          limit,
        };
      }
      if (path === "api/events/revisions") return [];
      throw new Error(`unexpected GET ${path}`);
    },
  } as unknown as ApiClient;
}

test("a corrupt checkpoint file stays untouched, is not reseeded, and pauses the guild", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeFileSync(hotfixStateFile(directory), "{ not json", "utf-8");
    const gets: string[] = [];
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        gets.push(path);
        return emptyPage();
      },
    } as unknown as ApiClient;

    const poller = new Poller({} as unknown as Client, api, hotfixSettings, 60_000, directory);
    await poller.pollNow();
    await poller.pollNow();

    assert.deepEqual(gets, [], "no seeding, no announcing: the API is never consulted");
    assert.equal(readFileSync(hotfixStateFile(directory), "utf-8"), "{ not json");
    poller.rememberEventThread(1, "thread-1");
    assert.equal(
      readFileSync(hotfixStateFile(directory), "utf-8"),
      "{ not json",
      "even a later state change must not overwrite the unreadable file",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt checkpoint falls back to the last good backup instead of reseeding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory, { lastEventId: 77, eventThreadIds: { "5": "thread-5" } });
    const first = new Poller({} as unknown as Client, scheduledEventsApi([]), hotfixSettings, 60_000, directory);
    first.rememberEventThread(6, "thread-6"); // rotates the good file into .bak
    first.rememberEventThread(7, "thread-7");
    assert.equal(existsSync(`${hotfixStateFile(directory)}.bak`), true);
    assert.equal(existsSync(`${hotfixStateFile(directory)}.tmp`), false, "no temp file is left behind");

    writeFileSync(hotfixStateFile(directory), '{"lastEventId": 7', "utf-8"); // torn write

    const second = new Poller({} as unknown as Client, scheduledEventsApi([]), hotfixSettings, 60_000, directory);
    assert.equal(second.findEventIdForThread("thread-5"), 5, "bindings survive");
    assert.equal(second.findEventIdForThread("thread-6"), 6);
    // The recovered poller keeps working and rewrites a valid main file.
    second.rememberEventThread(8, "thread-8");
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as { lastEventId: number };
    assert.equal(saved.lastEventId, 77);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sendingThread(id: string, sends: Array<{ id: string; content?: string }>): ThreadChannel {
  return {
    id,
    isThread: () => true,
    archived: false,
    locked: false,
    send: async (message: { content?: string }) => {
      sends.push({ id, content: message.content });
      return { id: "ping" };
    },
  } as unknown as ThreadChannel;
}

test("more than 50 pinged events never drops the thread mappings of other events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const pinged = Array.from({ length: 51 }, (_, index) => 100 + index);
    writeHotfixState(directory, {
      pinged1hEvents: pinged,
      eventThreadIds: { "7": "thread-7", "2000": "thread-2000" },
    });
    const due: EventView = {
      ...calendarEvent(2000, "Due soon"),
      event_date_utc: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const sends: Array<{ id: string; content?: string }> = [];
    const client = {
      channels: { fetch: async (id: string) => sendingThread(id, sends) },
    } as unknown as Client;

    const poller = new Poller(client, scheduledEventsApi([due]), hotfixSettings, 60_000, directory);
    await (poller as unknown as { checkUpcomingEvents(): Promise<void> }).checkUpcomingEvents();

    assert.equal(sends.length, 1, "the due event gets its 1h warning");
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as {
      pinged1hEvents: number[];
      eventThreadIds: Record<string, string>;
    };
    assert.equal(saved.pinged1hEvents.length, 50, "the memo list is still bounded");
    assert.deepEqual(
      saved.eventThreadIds,
      { "7": "thread-7", "2000": "thread-2000" },
      "thread bindings must not be derived from the pinged list",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an event missing from the revisions answer is only closed after the backend confirms it is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory, { eventThreadIds: { "7": "thread-7", "8": "thread-8" } });
    const archivedThreads: string[] = [];
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        if (path === "api/events/revisions") return []; // answer omits both ids
        if (path === "api/events/7") return { ...calendarEvent(7, "Still alive"), participants: [] };
        if (path === "api/events/8") throw new ApiError(404, "Event 8 not found");
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;
    const client = {
      channels: {
        fetch: async (id: string) => ({
          id,
          isThread: () => true,
          archived: false,
          locked: false,
          setLocked: async () => undefined,
          setArchived: async (value: boolean) => {
            if (value) archivedThreads.push(id);
          },
        }),
      },
    } as unknown as Client;

    const poller = new Poller(client, api, hotfixSettings, 60_000, directory);
    await (
      poller as unknown as { checkClosedEvents(r: Map<string, unknown>): Promise<void> }
    ).checkClosedEvents(new Map());

    assert.deepEqual(archivedThreads, ["thread-8"], "only the really-deleted event is closed");
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as {
      eventThreadIds: Record<string, string>;
    };
    assert.deepEqual(saved.eventThreadIds, { "7": "thread-7" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revisions are requested in chunks so a long mapping list is never truncated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    const threads = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [String(index + 1), `thread-${index + 1}`]),
    );
    writeHotfixState(directory, { eventThreadIds: threads });
    const requested: number[] = [];
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string, _d?: string, params?: Record<string, string | number>) => {
        assert.equal(path, "api/events/revisions");
        const ids = String(params?.ids).split(",");
        requested.push(ids.length);
        return ids.map((id) => eventRevision(Number(id), "scheduled"));
      },
    } as unknown as ApiClient;
    const poller = new Poller({} as unknown as Client, api, hotfixSettings, 60_000, directory);
    const revisions = await (
      poller as unknown as { loadEventRevisions(): Promise<Map<string, unknown> | null> }
    ).loadEventRevisions();

    assert.equal(revisions?.size, 250);
    assert.ok(requested.every((size) => size <= 100), `chunks were ${requested.join(",")}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the final signup card is rendered before the stopped event's thread is archived", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory, { eventThreadIds: { "9": "thread-9" } });
    const log: string[] = [];
    let archived = false;
    const card = {
      id: "card-1",
      components: [{ components: [{ customId: "event:join:9" }] }],
      edit: async () => {
        // Discord rejects edits inside an archived thread.
        if (archived) throw Object.assign(new Error("Thread is archived"), { code: 50083 });
        log.push("edit-card");
      },
    };
    const thread = {
      id: "thread-9",
      isThread: () => true,
      get archived() {
        return archived;
      },
      locked: false,
      guild: { preferredLocale: "en-US" },
      messages: {
        fetch: async (query: unknown) => (typeof query === "string" ? card : new Map([[card.id, card]])),
      },
      setLocked: async () => {
        log.push("lock");
      },
      setArchived: async (value: boolean) => {
        archived = value;
        log.push(value ? "archive" : "unarchive");
        return thread;
      },
    };
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        if (path === "api/events/9") {
          return { ...calendarEvent(9, "Over"), status: "stopped", participants: [], roster_version: 3 };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    } as unknown as ApiClient;
    const client = { channels: { fetch: async () => thread } } as unknown as Client;

    const poller = new Poller(client, api, hotfixSettings, 60_000, directory);
    assert.equal(await poller.finalizeStoppedEventThread(9), true);

    assert.deepEqual(log, ["edit-card", "lock", "archive"]);
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as {
      eventThreadIds: Record<string, string>;
    };
    assert.deepEqual(saved.eventThreadIds, {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduled events beyond page 1 still get their 1h reminder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    // 120 overdue "scheduled" events sort before the one starting in 30 minutes
    // when ordered soonest-first, and after it in the backend's default newest-first order.
    const overdue: EventView[] = Array.from({ length: 120 }, (_, index) => ({
      ...calendarEvent(1000 + index, `Overdue ${index}`),
      event_date_utc: new Date(Date.now() - (200 - index) * 60_000).toISOString(),
    }));
    const due: EventView = {
      ...calendarEvent(3000, "Due soon"),
      event_date_utc: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    // Far-future events fill what used to be page 1 of the newest-first list.
    const future: EventView[] = Array.from({ length: 60 }, (_, index) => ({
      ...calendarEvent(4000 + index, `Future ${index}`),
      event_date_utc: new Date(Date.now() + (5 + index) * 24 * 3_600_000).toISOString(),
    }));
    writeHotfixState(directory, { eventThreadIds: { "3000": "thread-3000" } });

    const calls: ListCall[] = [];
    const sends: Array<{ id: string; content?: string }> = [];
    const client = {
      channels: { fetch: async (id: string) => sendingThread(id, sends) },
    } as unknown as Client;
    const poller = new Poller(
      client,
      scheduledEventsApi([...overdue, due, ...future], calls),
      hotfixSettings,
      60_000,
      directory,
    );
    await (poller as unknown as { checkUpcomingEvents(): Promise<void> }).checkUpcomingEvents();

    assert.deepEqual(sends.map((send) => send.id), ["thread-3000"]);
    const listCalls = calls.filter((call) => call.path === "api/events");
    assert.ok(listCalls.length > 1, "the scan walks past page 1");
    assert.ok(
      listCalls.every((call) => call.params?.status === "scheduled" && call.params?.order === "asc"),
      "only scheduled events are listed, soonest first",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("message-delivery guilds never touch the Discord calendar panel on scheduled ticks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory);
    const gets: string[] = [];
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        gets.push(path);
        return [];
      },
    } as unknown as ApiClient;
    let discordCalls = 0;
    const client = {
      channels: {
        fetch: async () => {
          discordCalls += 1;
          return null;
        },
      },
    } as unknown as Client;
    const settings = {
      ...hotfixSettings,
      eventsChannelId: async () => "events-channel",
      eventDelivery: async () => "message",
    } as unknown as SettingsService;

    const poller = new Poller(client, api, settings, 60_000, directory);
    await (poller as unknown as { updateEventCalendars(): Promise<void> }).updateEventCalendars();

    assert.equal(discordCalls, 0);
    assert.deepEqual(gets, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lifecycle ignores scheduled events long overdue and still reaches a due event beyond page 1", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const hour = 3_600_000;
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    // Abandoned events days or months overdue sort first ascending and must be left alone.
    const abandoned: EventView[] = Array.from({ length: 3 }, (_, index) => ({
      ...calendarEvent(100 + index, `Abandoned ${index}`),
      event_date_utc: at(-(5 + index * 30) * 24 * hour),
    }));
    // More than one page of recently due events pushes the last one past page 1.
    const recent: EventView[] = Array.from({ length: 120 }, (_, index) => ({
      ...calendarEvent(1000 + index, `Recent ${index}`),
      event_date_utc: at(-(20 * hour) + index * 60_000),
    }));
    const attempted = new Set<number>();
    const events = [...abandoned, ...recent];
    const base = scheduledEventsApi(events);
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string, discordId?: string, params?: Record<string, string | number>) => {
        const match = /^api\/events\/(\d+)$/.exec(path);
        if (match) {
          attempted.add(Number(match[1]));
          throw new Error("stop after recording the attempt");
        }
        return base.get(path, discordId, params);
      },
    } as unknown as ApiClient;
    writeHotfixState(directory);
    const poller = new Poller({} as unknown as Client, api, hotfixSettings, 60_000, directory);
    await (poller as unknown as { checkEventLifecycle(): Promise<void> }).checkEventLifecycle();

    for (const event of abandoned) {
      assert.ok(!attempted.has(event.id), `abandoned event #${event.id} must not be massed or started`);
    }
    assert.ok(attempted.has(1119), "a due event beyond page 1 is still massed and started");
    assert.ok(attempted.has(1000));
  } finally {
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
});
test("a split that fails to sync does not block the splits behind it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory);
    const puts: string[] = [];
    const archivedItem = (splitId: number) => ({
      split_id: splitId,
      detail: { id: splitId, status: "open", archived_at: "2026-01-01T00:00:00Z", event_id: null },
      transactions: [],
      audit: [],
      next_audit_cursor: 0,
      next_transaction_cursor: 0,
      thread_id: null,
      summary_message_id: null,
    });
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        if (path === "api/splits/discord-sync") {
          return {
            items: [
              { id: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z" },
              { id: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:02Z" },
            ],
            has_more: false,
          };
        }
        if (path === "api/splits/1/discord-sync") throw new ApiError(500, "boom");
        if (path === "api/splits/2/discord-sync") return archivedItem(2);
        throw new Error(`unexpected GET ${path}`);
      },
      put: async (path: string) => {
        puts.push(path);
        return {};
      },
    } as unknown as ApiClient;
    const settings = {
      ...hotfixSettings,
      splitsForumChannelId: async () => "forum-1",
    } as unknown as SettingsService;

    const poller = new Poller({} as unknown as Client, api, settings, 60_000, directory);
    await (poller as unknown as { checkSplitSync(): Promise<void> }).checkSplitSync();

    assert.deepEqual(puts, ["api/splits/2/discord-sync"], "split 2 is synced despite split 1 failing");
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as {
      splitAfterId: number;
      splitRetries: Record<string, { attempts: number }>;
    };
    assert.equal(saved.splitAfterId, 2, "the cursor moved past both");
    assert.equal(saved.splitRetries["1"]?.attempts, 1, "the failed split is queued for retry");
    assert.equal(saved.splitRetries["2"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a giveaway whose backend ack failed is not announced a second time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory);
    const giveaway = {
      id: 11,
      title: "Raffle",
      description: null,
      ends_at: "2030-01-01T00:00:00Z",
      status: "open",
      created_by: 1,
      created_by_username: "Officer",
      created_at: "2029-12-01T00:00:00Z",
      entry_count: 0,
      prizes: [],
      entries: [],
    };
    let putFails = true;
    const puts: string[] = [];
    const api = {
      guildId: HOTFIX_GUILD,
      get: async (path: string) => {
        if (path === "api/giveaways") {
          return { items: [giveaway], total_items: 1, total_pages: 1, current_page: 1, limit: 50 };
        }
        if (path === "api/giveaways/11") return giveaway;
        throw new Error(`unexpected GET ${path}`);
      },
      put: async (path: string) => {
        puts.push(path);
        if (putFails) throw new ApiError(502, "bad gateway");
        return {};
      },
    } as unknown as ApiClient;
    let sent = 0;
    const channel = {
      id: "giveaways-channel",
      isTextBased: () => true,
      send: async () => {
        sent += 1;
        return { id: `message-${sent}` };
      },
    };
    const settings = {
      ...hotfixSettings,
      giveawaysChannelId: async () => "giveaways-channel",
    } as unknown as SettingsService;
    const client = { channels: { fetch: async () => channel } } as unknown as Client;

    const poller = new Poller(client, api, settings, 60_000, directory);
    const run = () => (poller as unknown as { checkNewGiveaways(): Promise<void> }).checkNewGiveaways();
    await run();
    await run();
    assert.equal(sent, 1, "a failed ack must not cause a duplicate announcement");

    putFails = false;
    await run();
    assert.equal(sent, 1);
    assert.equal(puts.length >= 2, true, "the ack is retried until the backend accepts it");
    const saved = JSON.parse(readFileSync(hotfixStateFile(directory), "utf-8")) as {
      unackedGiveawayMessages: Record<string, unknown>;
      lastGiveawayId: number;
    };
    assert.deepEqual(saved.unackedGiveawayMessages, {});
    assert.equal(saved.lastGiveawayId, 11);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pollNow during a running cycle queues one follow-up instead of running concurrently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poller-state-"));
  try {
    writeHotfixState(directory);
    let active = 0;
    let maxActive = 0;
    let cycles = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const settings = {
      ...hotfixSettings,
      applicationsSettings: async () => {
        cycles += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (cycles === 1) {
            firstEntered();
            await firstGate;
          }
          return { discord_applications_open: true };
        } finally {
          active -= 1;
        }
      },
    } as unknown as SettingsService;

    const poller = new Poller({} as unknown as Client, scheduledEventsApi([]), settings, 60_000, directory);
    const first = poller.pollNow();
    await entered;
    const second = poller.pollNow();
    const third = poller.pollNow();
    releaseFirst();
    await Promise.all([first, second, third]);

    assert.equal(maxActive, 1, "cycles never overlap");
    assert.equal(cycles, 2, "the callers that arrived mid-cycle share exactly one follow-up cycle");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

