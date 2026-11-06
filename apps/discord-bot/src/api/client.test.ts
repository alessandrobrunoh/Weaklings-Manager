import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient, ApiError } from "./client.js";

test("ApiClient sends member roles only with the matching Discord actor", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const actorApi = new ApiClient("https://guild-manager.example", "secret")
      .withGuild("123456789012345678")
      .withDiscordActor("222222222222222222", [
        "333333333333333333",
        "444444444444444444",
        "333333333333333333",
        "not-a-role-id",
      ]);

    await actorApi.get("api/events", "222222222222222222");
    await actorApi.get("api/users/555555555555555555", "555555555555555555");

    assert.equal(calls[0]?.get("X-Discord-Id"), "222222222222222222");
    assert.equal(
      calls[0]?.get("X-Discord-Role-Ids"),
      "333333333333333333,444444444444444444",
    );
    assert.equal(calls[0]?.get("X-Guild-Id"), "123456789012345678");
    assert.equal(calls[1]?.get("X-Discord-Id"), "555555555555555555");
    assert.equal(calls[1]?.has("X-Discord-Role-Ids"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ApiClient bounds every request and reports a timeout as ApiError 504", async () => {
  const originalFetch = globalThis.fetch;
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    signals.push(init?.signal);
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  try {
    const api = new ApiClient("https://guild-manager.example", "secret");
    await assert.rejects(
      () => api.get("api/events"),
      (error: unknown) => error instanceof ApiError && error.status === 504,
    );
    assert.ok(signals[0] instanceof AbortSignal, "the request carries an AbortSignal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
