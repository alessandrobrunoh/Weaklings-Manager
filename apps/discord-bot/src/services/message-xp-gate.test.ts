import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "../api/client.js";
import {
  MessageXpGate,
  SETTINGS_TTL_MS,
  forgetMessageXpGate,
  getMessageXpGate,
  initMessageXpGate,
  shouldSkipMessageAwardLocally,
} from "./message-xp-gate.js";

const settings = {
  message_cooldown_secs: 60,
  message_min_chars: 10,
  message_channel_deny_list: ["denied-channel"],
};

test("shouldSkipMessageAwardLocally never skips without cached settings", () => {
  // No settings fetched yet, or the guild's progression module is off — with
  // nothing to trust, the only safe answer is "let the backend decide".
  assert.equal(
    shouldSkipMessageAwardLocally(null, 1, "any-channel", Date.now(), undefined),
    false,
  );
});

test("shouldSkipMessageAwardLocally rejects a message shorter than the configured minimum", () => {
  assert.equal(
    shouldSkipMessageAwardLocally(settings, 5, "general", Date.now(), undefined),
    true,
  );
  assert.equal(
    shouldSkipMessageAwardLocally(settings, 10, "general", Date.now(), undefined),
    false,
  );
});

test("shouldSkipMessageAwardLocally rejects a denied channel regardless of length or cooldown", () => {
  assert.equal(
    shouldSkipMessageAwardLocally(settings, 50, "denied-channel", Date.now(), undefined),
    true,
  );
});

test("shouldSkipMessageAwardLocally rejects a message still inside its author's cooldown", () => {
  const now = Date.now();
  const lastAwardedAt = now - 30_000; // 30s ago, cooldown is 60s
  assert.equal(
    shouldSkipMessageAwardLocally(settings, 50, "general", now, lastAwardedAt),
    true,
  );
});

test("shouldSkipMessageAwardLocally allows a message once the cooldown has elapsed", () => {
  const now = Date.now();
  const lastAwardedAt = now - 61_000; // just past the 60s cooldown
  assert.equal(
    shouldSkipMessageAwardLocally(settings, 50, "general", now, lastAwardedAt),
    false,
  );
});

test("shouldSkipMessageAwardLocally ignores cooldown entirely when it is disabled (0)", () => {
  const disabled = { ...settings, message_cooldown_secs: 0 };
  const now = Date.now();
  assert.equal(shouldSkipMessageAwardLocally(disabled, 50, "general", now, now), false);
});

test("MessageXpGate skips locally after recording an award inside the cooldown window", async () => {
  const api = { get: async () => settings } as unknown as ApiClient;
  const gate = new MessageXpGate(api);

  assert.equal(await gate.shouldAward("user-1", "general", 50), true);
  gate.recordAward("user-1");
  // Immediately after: still inside the cooldown, no round trip needed.
  assert.equal(await gate.shouldAward("user-1", "general", 50), false);
  // A different user has no recorded award, so they are unaffected.
  assert.equal(await gate.shouldAward("user-2", "general", 50), true);
});

test("MessageXpGate reuses settings within the TTL instead of refetching every call", async () => {
  let calls = 0;
  const api = {
    get: async () => {
      calls += 1;
      return settings;
    },
  } as unknown as ApiClient;
  const gate = new MessageXpGate(api, SETTINGS_TTL_MS);

  await gate.shouldAward("user-1", "general", 50);
  await gate.shouldAward("user-1", "general", 50);
  await gate.shouldAward("user-2", "general", 50);

  assert.equal(calls, 1, "settings should be fetched once and reused");
});

test("MessageXpGate fails open (never filters) when the settings fetch fails", async () => {
  // A network error, or a 403 because this guild's progression module isn't
  // enabled — either way, every message still reaches the backend, exactly
  // like before this gate existed.
  const api = {
    get: async () => {
      throw new Error("403 Forbidden");
    },
  } as unknown as ApiClient;
  const gate = new MessageXpGate(api, 0);

  assert.equal(await gate.shouldAward("user-1", "general", 1), true);
});

test("the gate registry keeps one gate per guild, and forgetting drops it", () => {
  const api = {
    withGuild(guildId: string) {
      return { guildId, get: async () => settings } as unknown as ApiClient;
    },
  } as unknown as ApiClient;

  initMessageXpGate(api);

  const first = getMessageXpGate("111");
  assert.equal(getMessageXpGate("111"), first, "the same guild reuses its gate");
  assert.notEqual(getMessageXpGate("222"), first, "a different guild gets its own");

  forgetMessageXpGate("111");
  assert.notEqual(getMessageXpGate("111"), first, "forgetting drops the cache");
});
