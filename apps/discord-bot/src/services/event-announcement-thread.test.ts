import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadChannel } from "discord.js";
import { resolveEventReminderThread } from "./event-announcement-thread.js";

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
