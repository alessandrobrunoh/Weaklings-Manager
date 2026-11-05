import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeErrorReply } from "./interaction-reply.js";

function discordError(code: number): Error {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

function fake(options: {
  replied?: boolean;
  deferred?: boolean;
  replyError?: Error;
  followUpError?: Error;
}) {
  const calls: string[] = [];
  return {
    calls,
    interaction: {
      replied: options.replied ?? false,
      deferred: options.deferred ?? false,
      async reply() {
        calls.push("reply");
        if (options.replyError) throw options.replyError;
      },
      async followUp() {
        calls.push("followUp");
        if (options.followUpError) throw options.followUpError;
      },
    },
  };
}

describe("safeErrorReply", () => {
  it("replies to a fresh interaction and follows up on a deferred one", async () => {
    const fresh = fake({});
    assert.equal(await safeErrorReply(fresh.interaction, {}), true);
    assert.deepEqual(fresh.calls, ["reply"]);

    const deferred = fake({ deferred: true });
    assert.equal(await safeErrorReply(deferred.interaction, {}), true);
    assert.deepEqual(deferred.calls, ["followUp"]);
  });

  it("swallows an expired interaction instead of throwing a second error", async () => {
    const expired = fake({ replyError: discordError(10062) });
    assert.equal(await safeErrorReply(expired.interaction, {}), false);
  });

  it("falls back to a follow-up when the interaction was acknowledged meanwhile", async () => {
    const acked = fake({ replyError: discordError(40060) });
    assert.equal(await safeErrorReply(acked.interaction, {}), true);
    assert.deepEqual(acked.calls, ["reply", "followUp"]);
  });

  it("never throws for unexpected failures", async () => {
    const broken = fake({ replyError: new Error("socket hang up") });
    assert.equal(await safeErrorReply(broken.interaction, {}), false);
  });
});
