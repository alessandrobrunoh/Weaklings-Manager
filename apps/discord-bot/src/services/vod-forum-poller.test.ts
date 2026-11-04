import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, type Client } from "discord.js";
import type { ApiClient } from "../api/client.js";
import { Poller } from "./poller.js";
import type { SettingsService } from "./settings.js";

test("VOD delivery claims before creating, records success, and does not repost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vod-poller-"));
  try {
    let state = "pending";
    const calls: string[] = [];
    const api = {
      guildId: "100000000000000001",
      get: async (path: string) => {
        assert.equal(path, "api/events/vod-forum-posts/pending");
        return state === "pending" ? [{ id: 7, title: "Castle" }] : [];
      },
      post: async (path: string, body: unknown) => {
        calls.push(path);
        if (path.endsWith("/claim")) {
          if (state !== "pending") return false;
          state = "attempted";
          return true;
        }
        assert.deepEqual(body, { thread_id: "thread-7" });
        state = "created";
        return true;
      },
    } as unknown as ApiClient;
    const forum = {
      type: ChannelType.GuildForum,
      permissionsFor: () => ({ has: () => true }),
      flags: { has: () => false },
      threads: { create: async () => {
        calls.push("discord-create");
        assert.equal(state, "attempted");
        return { id: "thread-7" };
      } },
    };
    const client = { user: { id: "bot" }, channels: { fetch: async () => forum } } as unknown as Client;
    const settings = { vodForumChannelId: async () => "forum" } as unknown as SettingsService;
    const poller = new Poller(client, api, settings, 60_000, directory);
    const deliver = () => (poller as unknown as { checkVodForumPosts(): Promise<void> }).checkVodForumPosts();

    await deliver();
    await deliver();
    assert.equal(state, "created");
    assert.deepEqual(calls, [
      "api/events/7/vod-forum-post/claim",
      "discord-create",
      "api/events/7/vod-forum-post/created",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous Discord failure stays attempted across poller restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vod-poller-"));
  try {
    let state = "pending";
    let creates = 0;
    const api = {
      guildId: "100000000000000001",
      get: async () => state === "pending" ? [{ id: 8, title: "Mass" }] : [],
      post: async () => { state = "attempted"; return true; },
    } as unknown as ApiClient;
    const forum = {
      type: ChannelType.GuildForum,
      permissionsFor: () => ({ has: () => true }),
      flags: { has: () => false },
      threads: { create: async () => { creates++; throw new Error("connection lost"); } },
    };
    const client = { user: { id: "bot" }, channels: { fetch: async () => forum } } as unknown as Client;
    const settings = { vodForumChannelId: async () => "forum" } as unknown as SettingsService;
    const run = async () => {
      const poller = new Poller(client, api, settings, 60_000, directory);
      await (poller as unknown as { checkVodForumPosts(): Promise<void> }).checkVodForumPosts();
    };

    await run();
    await run();
    assert.equal(state, "attempted");
    assert.equal(creates, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
