import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "../api/client.js";
import {
  COOLDOWN_SWEEP_THRESHOLD,
  MAX_TRACKED_AUTHORS,
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

test("MessageXpGate forgets authors whose cooldown has elapsed so the map does not grow forever", async () => {
  const api = { get: async () => settings } as unknown as ApiClient;
  let now = 1_000_000;
  const gate = new MessageXpGate(api, SETTINGS_TTL_MS, () => now);
  await gate.shouldAward("warmup", "general", 50); // fetch + cache the settings

  // A burst of distinct authors, all of whom then fall silent.
  for (let i = 0; i <= COOLDOWN_SWEEP_THRESHOLD; i += 1) {
    gate.recordAward(`user-${i}`);
  }
  assert.equal(gate.trackedAuthors, COOLDOWN_SWEEP_THRESHOLD + 1);

  // Once the 60s cooldown has passed for all of them, the next award sweeps them out.
  now += 61_000;
  gate.recordAward("latecomer");
  assert.equal(gate.trackedAuthors, 1, "only the author still inside a cooldown is kept");
});

test("MessageXpGate keeps an author who is still inside the cooldown while sweeping others", async () => {
  const api = { get: async () => settings } as unknown as ApiClient;
  let now = 1_000_000;
  const gate = new MessageXpGate(api, SETTINGS_TTL_MS, () => now);
  await gate.shouldAward("warmup", "general", 50);

  for (let i = 0; i < COOLDOWN_SWEEP_THRESHOLD; i += 1) {
    gate.recordAward(`old-${i}`);
  }
  now += 61_000;
  gate.recordAward("fresh"); // size is past the threshold, so this award sweeps the old batch
  gate.recordAward("second");

  assert.equal(gate.trackedAuthors, 2);
  // "fresh" is within its cooldown, so the gate still skips the backend call for them.
  now += 10_000;
  assert.equal(await gate.shouldAward("fresh", "general", 50), false);
  assert.equal(await gate.shouldAward("old-0", "general", 50), true);
});

test("MessageXpGate never tracks more than MAX_TRACKED_AUTHORS even if nobody's cooldown expires", async () => {
  // Cooldown far longer than the test, so the expiry sweep alone cannot shrink the map.
  const longCooldown = { ...settings, message_cooldown_secs: 365 * 24 * 3600 };
  const api = { get: async () => longCooldown } as unknown as ApiClient;
  const gate = new MessageXpGate(api, SETTINGS_TTL_MS, () => 1_000_000);
  await gate.shouldAward("warmup", "general", 50);

  for (let i = 0; i < MAX_TRACKED_AUTHORS + 50; i += 1) {
    gate.recordAward(`user-${i}`);
  }
  assert.ok(gate.trackedAuthors <= MAX_TRACKED_AUTHORS, `tracked ${gate.trackedAuthors}`);
});
