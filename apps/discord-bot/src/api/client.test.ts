import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_BLOCKED_MESSAGE, ApiClient, ApiError } from "./client.js";

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

test("ApiClient sends the actor username percent-encoded, only with the matching actor", async () => {
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
      .withDiscordActor("222222222222222222", [], "Zoë ✨");

    await actorApi.get("api/events", "222222222222222222");
    await actorApi.get("api/events", "555555555555555555");

    assert.equal(calls[0]?.get("X-Discord-Username"), encodeURIComponent("Zoë ✨"));
    assert.equal(calls[0]?.get("X-Discord-Role-Ids"), "");
    assert.equal(calls[1]?.has("X-Discord-Username"), false);
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

test("ApiClient turns a 403 account_blocked into one clear message and keeps the code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ code: "account_blocked", detail: "Your access to the manager has been blocked by an officer." }),
      { status: 403, headers: { "Content-Type": "application/problem+json" } },
    );

  try {
    const api = new ApiClient("https://guild-manager.example", "secret");
    await assert.rejects(
      () => api.post("api/albion/link", {}, "42"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "account_blocked" &&
        error.message === ACCOUNT_BLOCKED_MESSAGE,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ApiClient leaves an ordinary 403 untouched", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "Forbidden: missing permission" }), { status: 403 });

  try {
    const api = new ApiClient("https://guild-manager.example", "secret");
    await assert.rejects(
      () => api.get("api/events", "42"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === undefined &&
        error.message === "Forbidden: missing permission",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
