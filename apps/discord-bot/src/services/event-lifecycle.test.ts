import assert from "node:assert/strict";
import test from "node:test";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import {
  nextEmptyLiveVoiceCheck,
  stopDiscordEvent,
  voiceChannelOccupantCount,
} from "./event-lifecycle.js";

function mockVoiceChannel(
  channelId: string,
  occupantChannelIds: string[],
  membersSize = 0,
): VoiceBasedChannel & { deletedReason: string | null } {
  const channel = {
    id: channelId,
    deletedReason: null as string | null,
    isVoiceBased: () => true,
    members: { size: membersSize },
    guild: {
      voiceStates: {
        cache: {
          filter: (predicate: (state: { channelId: string | null }) => boolean) => ({
            size: occupantChannelIds.map((id) => ({ channelId: id })).filter(predicate).length,
          }),
        },
      },
    },
    delete: async (reason?: string) => {
      channel.deletedReason = reason ?? "";
    },
  };
  return channel as unknown as VoiceBasedChannel & { deletedReason: string | null };
}

function liveEvent(): EventDetailView {
  return {
    id: 41,
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
    mass_time_utc: "2026-09-01T19:30:00Z",
    start_time_utc: "2026-09-01T20:00:00Z",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T20:00:00Z",
    status: "live",
    started_at: "2026-09-01T20:00:00Z",
    stopped_at: null,
    auto_stop_deadline: null,
    link_status: "in_progress",
    discord_voice_channel_id: "voice-41",
    active_comp_id: 7,
    active_comp_name: "Main ZvZ",
    active_comp_capacity: 20,
    participants: [],
  };
}

test("empty live voice is not auto-stopped until it has been occupied", () => {
  assert.deepEqual(nextEmptyLiveVoiceCheck(0, 0, false), {
    emptyTicks: 0,
    seenOccupied: false,
    shouldStop: false,
  });
  assert.deepEqual(nextEmptyLiveVoiceCheck(1, 0, false), {
    emptyTicks: 0,
    seenOccupied: false,
    shouldStop: false,
  });
});

test("occupied live voice resets empty ticks and two later empty ticks auto-stop", () => {
  assert.deepEqual(nextEmptyLiveVoiceCheck(2, 3, false), {
    emptyTicks: 0,
    seenOccupied: true,
    shouldStop: false,
  });
  assert.deepEqual(nextEmptyLiveVoiceCheck(0, 0, true), {
    emptyTicks: 1,
    seenOccupied: true,
    shouldStop: false,
  });
  assert.deepEqual(nextEmptyLiveVoiceCheck(1, 0, true), {
    emptyTicks: 2,
    seenOccupied: true,
    shouldStop: true,
  });
});

test("voice occupancy uses guild voice states, not channel.members", () => {
  const occupied = mockVoiceChannel("voice-41", ["voice-41"], 0);
  const empty = mockVoiceChannel("voice-41", [], 4);
  assert.equal(voiceChannelOccupantCount(occupied), 1);
  assert.equal(voiceChannelOccupantCount(empty), 0);
});

test("stopDiscordEvent keeps a channel whose voice states are occupied even if members is empty", async () => {
  const channel = mockVoiceChannel("voice-41", ["voice-41"], 0);
  const event = liveEvent();
  const api = {
    post: async () => event,
    delete: async () => {
      throw new Error("must not clear a still-occupied voice channel");
    },
  } as unknown as ApiClient;
  const client = {
    channels: {
      fetch: async () => channel,
    },
  } as unknown as Client;

  const result = await stopDiscordEvent(client, api, "1", 41);
  assert.equal(result.voiceChannelOccupied, true);
  assert.equal(result.voiceChannelDeleted, false);
  assert.equal(channel.deletedReason, null);
});

test("stopDiscordEvent deletes an empty voice channel after stop", async () => {
  const channel = mockVoiceChannel("voice-41", [], 0);
  const event = liveEvent();
  const stopped = { ...event, status: "stopped" as const };
  const cleared = { ...stopped, discord_voice_channel_id: null };
  const api = {
    post: async () => stopped,
    delete: async () => cleared,
  } as unknown as ApiClient;
  const client = {
    channels: {
      fetch: async () => channel,
    },
  } as unknown as Client;

  const result = await stopDiscordEvent(client, api, "1", 41);
  assert.equal(result.voiceChannelOccupied, false);
  assert.equal(result.voiceChannelDeleted, true);
  assert.match(String(channel.deletedReason), /empty/);
  assert.equal(result.event.discord_voice_channel_id, null);
});
