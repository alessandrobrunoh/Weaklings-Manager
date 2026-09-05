import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadChannel } from "discord.js";
import type { EventDetailView } from "../api/types.js";
import {
  deleteEventAnnouncement,
  refreshEventSignupCard,
  resolveEventReminderThread,
} from "./event-announcement-thread.js";

function thread(id: string): ThreadChannel {
  return { id, isThread: () => true } as unknown as ThreadChannel;
}

test("Ping from the event thread stays in that thread", () => {
  const discussion = thread("thread-event");
  const resolved = resolveEventReminderThread({
    channel: discussion,
    message: { thread: null },
  });
  assert.equal(resolved, discussion);
});

test("Ping on the parent starter message is redirected into the linked thread", () => {
  const discussion = thread("thread-event");
  const resolved = resolveEventReminderThread({
    channel: { isThread: () => false },
    message: { thread: discussion },
  });
  assert.equal(resolved, discussion);
});

test("Ping without a discussion thread is rejected instead of posting in the parent channel", () => {
  assert.throws(
    () =>
      resolveEventReminderThread({
        channel: { isThread: () => false },
        message: { thread: null },
      }),
    { message: "Event reminders can only be sent from the event thread." },
  );
});

test("refreshEventSignupCard edits the join-button message in the thread", async () => {
  const edits: unknown[] = [];
  const signup = {
    id: "signup-42",
    components: [{ components: [{ customId: "event:join:42" }] }],
    edit: async (payload: unknown) => {
      edits.push(payload);
      return signup;
    },
  };
  const thread = {
    id: "thread-42",
    isThread: () => true,
    archived: false,
    messages: {
      fetch: async (arg: unknown) => {
        if (arg === "signup-42") return signup;
        return new Map([[signup.id, signup]]);
      },
    },
  } as unknown as ThreadChannel;

  const event = {
    id: 42,
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
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    roster_version: 4,
    status: "scheduled",
    started_at: null,
    stopped_at: null,
    auto_stop_deadline: null,
    link_status: "pending",
    discord_voice_channel_id: null,
    active_comp_id: 7,
    active_comp_name: "Main ZvZ",
    active_comp_capacity: 1,
    comp_builds: [{ build_id: 10, name: "Main Tank", quantity: 1 }],
    participants: [
      {
        user_id: 1,
        username: "Tank",
        discord_id: "333",
        primary_build_id: 10,
        primary_build_name: "Main Tank",
        secondary_build_id: null,
        secondary_build_name: null,
        assigned_build_id: 10,
        assigned_build_name: "Main Tank",
      },
    ],
  } as EventDetailView;

  const messageId = await refreshEventSignupCard(thread, event, "Test", "signup-42");
  assert.equal(messageId, "signup-42");
  assert.equal(edits.length, 1);
  const payload = edits[0] as { embeds: unknown[]; components: unknown[] };
  assert.equal(payload.embeds.length, 1);
  assert.ok(Array.isArray(payload.components));
});

test("deleteEventAnnouncement removes the parent starter message", async () => {
  const deleted: string[] = [];
  const starter = {
    id: "starter-42",
    delete: async () => {
      deleted.push("starter-42");
    },
  };
  const thread = {
    id: "thread-42",
    isThread: () => true,
    fetchStarterMessage: async () => starter,
    delete: async () => {
      deleted.push("thread");
    },
  } as unknown as ThreadChannel;

  const result = await deleteEventAnnouncement(thread, 42, "Test");
  assert.equal(result, true);
  assert.deepEqual(deleted, ["starter-42"]);
});

test("deleteEventAnnouncement closes the thread when Discord rejects the delete", async () => {
  const archiveCalls: boolean[] = [];
  const thread = {
    id: "thread-42",
    isThread: () => true,
    archived: false,
    locked: false,
    fetchStarterMessage: async () => ({
      delete: async () => {
        throw new Error("Missing Permissions");
      },
    }),
    setArchived: async (value: boolean) => {
      archiveCalls.push(value);
      thread.archived = value;
      return thread;
    },
    setLocked: async (value: boolean) => {
      thread.locked = value;
      return thread;
    },
  } as unknown as ThreadChannel & { archived: boolean; locked: boolean };

  const result = await deleteEventAnnouncement(thread, 42, "Test");
  assert.equal(result, true);
  assert.equal(thread.locked, true);
  assert.equal(thread.archived, true);
  assert.deepEqual(archiveCalls, [true]);
});
