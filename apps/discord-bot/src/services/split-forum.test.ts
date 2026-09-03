import assert from "node:assert/strict";
import test from "node:test";
import type { Client, ThreadChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  SplitDiscordSync,
  UpdateSplitDiscordSyncState,
} from "../api/types.js";
import { SplitForumAdapter } from "./split-forum.js";

const detail = {
  id: 42,
  created_by_username: "leader",
  status: "pending" as const,
  estimated_market_value: 100,
  fee: 0,
  repair_value: 0,
  bags_value: 0,
  net_value: 100,
  note: null,
  event_id: null,
  event_title: null,
  island_id: 1,
  island_name: "Island",
  island_city: "City",
  island_tab_id: 1,
  island_tab_name: "Tab",
  participant_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  finalized_at: null,
  participants: [],
};

function syncItem(): SplitDiscordSync {
  return {
    split_id: detail.id,
    detail,
    audit: [{
      id: 7,
      action: "TRANSACTION_CREATED",
      entity_type: "transaction",
      entity_id: 9,
      split_id: detail.id,
      user_id: 1,
      details: { amount: 100 },
      created_at: "2026-01-01T00:00:01Z",
    }],
    transactions: [{
      id: 9,
      to_user_id: 1,
      to_username: "player",
      to_label: "player",
      to_guild_bank: false,
      amount: 100,
      status: "pending",
      type: "credit",
      split_id: detail.id,
      from_user_id: null,
      from_label: "Guild Bank",
      created_at: "2026-01-01T00:00:01Z",
      requested_at: null,
      withdrawn_at: null,
    }],
    next_audit_cursor: 7,
    next_transaction_cursor: 9,
    thread_id: "123456789012345678",
    summary_message_id: "223456789012345678",
  };
}

test("split sync updates only the summary and acknowledges both incremental cursors", async () => {
  const sent: unknown[] = [];
  const edits: unknown[] = [];
  const states: UpdateSplitDiscordSyncState[] = [];
  const thread = {
    id: "123456789012345678",
    parentId: "forum-channel",
    name: "Split #42 — No event",
    isThread: () => true,
    messages: {
      fetch: async () => ({
        edit: async (payload: unknown) => edits.push(payload),
      }),
    },
    setName: async () => undefined,
    send: async (payload: unknown) => sent.push(payload),
  } as unknown as ThreadChannel;
  const client = {
    channels: { fetch: async () => thread },
  } as unknown as Client;
  const api = {
    put: async (_path: string, state: UpdateSplitDiscordSyncState) => {
      states.push(state);
      return undefined;
    },
  } as unknown as ApiClient;

  const result = await new SplitForumAdapter(client, api, "forum-channel").sync(syncItem());

  assert.equal(result, true);
  assert.equal(edits.length, 1);
  assert.deepEqual(sent, []);
  assert.deepEqual(states, [{
    thread_id: "123456789012345678",
    summary_message_id: "223456789012345678",
    last_audit_id: 7,
    last_transaction_id: 9,
  }]);
});

test("split sync unarchives an auto-archived Forum post before updating and closing it", async () => {
  const edits: unknown[] = [];
  const archiveCalls: boolean[] = [];
  const thread = {
    id: "123456789012345678",
    parentId: "forum-channel",
    name: "Split #42 — No event",
    archived: true,
    locked: false,
    isThread: () => true,
    messages: {
      fetch: async () => ({
        edit: async (payload: unknown) => edits.push(payload),
      }),
    },
    setName: async () => undefined,
    setArchived: async (value: boolean) => {
      archiveCalls.push(value);
      thread.archived = value;
      return thread;
    },
    setLocked: async (value: boolean) => {
      if (thread.archived) {
        throw Object.assign(new Error("Thread is archived"), { code: 50083 });
      }
      thread.locked = value;
      return thread;
    },
  };
  const client = {
    channels: { fetch: async () => thread },
  } as unknown as Client;
  const states: UpdateSplitDiscordSyncState[] = [];
  const api = {
    put: async (_path: string, state: UpdateSplitDiscordSyncState) => {
      states.push(state);
      return undefined;
    },
  } as unknown as ApiClient;

  const result = await new SplitForumAdapter(client, api, "forum-channel").sync({
    ...syncItem(),
    detail: { ...detail, status: "completed" },
  });

  assert.equal(result, true);
  assert.equal(edits.length, 1);
  assert.deepEqual(archiveCalls, [false, true]);
  assert.equal(thread.locked, true);
  assert.equal(thread.archived, true);
  assert.equal(states.length, 1);
});
