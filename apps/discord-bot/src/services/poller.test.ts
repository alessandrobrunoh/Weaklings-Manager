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
  extras: { roster_version?: number; archived_at?: string | null } = {},
) {
  return {
    id,
    status,
    roster_version: extras.roster_version ?? 0,
    archived_at: extras.archived_at ?? null,
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
    assert.equal(apiGets.some((path) => /^api\/events\/\d+$/.test(path)), false);

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
    assert.equal(saved.eventSignupRevisions["28"], "0:cancelled");
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
        eventSignupRevisions: { "28": "0:cancelled" },
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

test("ping_alliance dual-posts to alliance Discord without a signup thread", async () => {
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
      origin_guild_id: "origin-guild",
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
    assert.equal(allySends.length, 1);
    assert.match(String(allySends[0]?.content), /<@&999999999999999999>/);
    assert.doesNotMatch(String(allySends[0]?.content), /<@&111111111111111111>/);
    assert.equal("components" in allySends[0]!, false);
    assert.deepEqual(patches, [
      {
        guildId: "origin-guild",
        path: "api/events/41",
        body: { alliance_discord_message_id: "ally-msg" },
      },
    ]);
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
        eventSignupRevisions: { "41": "1:scheduled" },
        splitUpdatedAt: null,
        splitAfterId: null,
        massedEvents: [],
        emptyLiveChecks: {},
      }),
      "utf-8",
    );

    const edits: unknown[] = [];
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
          return [eventRevision(41, "scheduled", { roster_version: 4 })];
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
    assert.equal(splitGets.length, 1);
    const saved = JSON.parse(readFileSync(join(directory, "poller-state-100000000000000001.json"), "utf-8")) as {
      eventSignupRevisions: Record<string, string>;
    };
    assert.equal(saved.eventSignupRevisions["41"], "4:scheduled");
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
        eventSignupRevisions: { "41": "4:scheduled" },
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
          return [eventRevision(41, "scheduled", { roster_version: 4 })];
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
