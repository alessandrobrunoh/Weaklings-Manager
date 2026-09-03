import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadChannel } from "discord.js";
import {
  discordErrorCode,
  isInvalidActionOnArchivedThread,
  isUnknownDiscordChannel,
  lockAndArchiveThread,
  withUnarchivedThread,
} from "./discord-thread.js";

function archivedError(): Error & { code: number } {
  return Object.assign(new Error("Thread is archived"), { code: 50083 });
}

function mockThread(initial: { archived?: boolean; locked?: boolean } = {}) {
  const state = {
    archived: initial.archived ?? false,
    locked: initial.locked ?? false,
    archiveCalls: [] as boolean[],
    lockCalls: 0,
  };
  const thread = {
    get archived() {
      return state.archived;
    },
    get locked() {
      return state.locked;
    },
    setArchived: async (value: boolean) => {
      state.archiveCalls.push(value);
      state.archived = value;
      return thread;
    },
    setLocked: async (value: boolean) => {
      state.lockCalls += 1;
      if (state.archived) throw archivedError();
      state.locked = value;
      return thread;
    },
  };
  return { thread: thread as unknown as ThreadChannel, state };
}

test("discord error helpers read numeric REST codes", () => {
  assert.equal(discordErrorCode({ code: 50083 }), 50083);
  assert.equal(discordErrorCode({ code: "10003" }), 10003);
  assert.equal(isInvalidActionOnArchivedThread(archivedError()), true);
  assert.equal(isUnknownDiscordChannel({ code: 10003 }), true);
  assert.equal(isUnknownDiscordChannel(new Error("nope")), false);
});

test("lockAndArchiveThread unarchives before locking an auto-archived thread", async () => {
  const { thread, state } = mockThread({ archived: true, locked: false });

  await lockAndArchiveThread(thread, "Event #32 closed");

  assert.deepEqual(state.archiveCalls, [false, true]);
  assert.equal(state.lockCalls, 1);
  assert.equal(state.locked, true);
  assert.equal(state.archived, true);
});

test("lockAndArchiveThread retries lock after Discord reports a stale archived thread", async () => {
  const { thread, state } = mockThread({ archived: false, locked: false });
  let firstLock = true;
  thread.setLocked = async (value: boolean) => {
    state.lockCalls += 1;
    if (firstLock) {
      firstLock = false;
      state.archived = true;
      throw archivedError();
    }
    if (state.archived) throw archivedError();
    state.locked = value;
    return thread;
  };

  await lockAndArchiveThread(thread, "Event #32 closed");

  assert.equal(state.lockCalls, 2);
  assert.equal(state.locked, true);
  assert.equal(state.archived, true);
});

test("withUnarchivedThread unarchives then runs the action", async () => {
  const { thread, state } = mockThread({ archived: true });
  const names: string[] = [];

  await withUnarchivedThread(thread, "update", async (active) => {
    names.push(String(active.archived));
  });

  assert.deepEqual(state.archiveCalls, [false]);
  assert.deepEqual(names, ["false"]);
});
