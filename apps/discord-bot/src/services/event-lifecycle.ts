import { ChannelType, type Client, type ThreadChannel } from "discord.js";

import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import { buildEventStartMessage } from "../embeds/event.embed.js";
import { config } from "../config.js";
import { getSettingsService } from "./settings.js";

export interface StartedDiscordEvent {
  event: EventDetailView;
  voiceChannelId: string;
  createdVoiceChannel: boolean;
}

export interface StoppedDiscordEvent {
  event: EventDetailView;
  voiceChannelDeleted: boolean;
  voiceChannelOccupied: boolean;
}

// In-process lock keyed by event id: serializes concurrent "Start Event"
// calls for the same event so two overlapping requests can't both pass the
// `discord_voice_channel_id` check and each create their own voice channel.
// A second caller for the same event id just awaits the first call's result
// instead of racing it.
const startLocks = new Map<number, Promise<StartedDiscordEvent>>();

/** Starts or recovers a live event's Discord voice channel and optionally notifies its thread. */
export async function startDiscordEvent(
  client: Client,
  api: ApiClient,
  discordUserId: string,
  eventId: number,
  thread?: ThreadChannel,
): Promise<StartedDiscordEvent> {
  const inFlight = startLocks.get(eventId);
  if (inFlight) {
    return inFlight;
  }

  const run = startDiscordEventLocked(client, api, discordUserId, eventId, thread).finally(() => {
    startLocks.delete(eventId);
  });
  startLocks.set(eventId, run);
  return run;
}

async function startDiscordEventLocked(
  client: Client,
  api: ApiClient,
  discordUserId: string,
  eventId: number,
  thread?: ThreadChannel,
): Promise<StartedDiscordEvent> {
  const categoryId = await getSettingsService().eventVoiceCategoryId();
  if (!categoryId) {
    throw new Error("No event voice category is configured. Ask an admin to configure it first.");
  }

  const category = await client.channels.fetch(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("The configured event voice category is missing or is not a Discord category.");
  }

  let event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (event.status === "scheduled") {
    await api.post(`api/events/${eventId}/start`, {}, discordUserId);
    event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  } else if (event.status !== "live") {
    throw new Error(`Event #${eventId} cannot be started because it is ${event.status}.`);
  }

  if (event.discord_voice_channel_id) {
    return {
      event,
      voiceChannelId: event.discord_voice_channel_id,
      createdVoiceChannel: false,
    };
  }

  const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
  const voiceChannel = await guild.channels.create({
    name: buildEventVoiceChannelName(event.id, event.title),
    type: ChannelType.GuildVoice,
    parent: category.id,
    reason: `Live event #${event.id}`,
  });

  try {
    await api.put(
      `api/events/${eventId}/discord-voice-channel`,
      { channel_id: voiceChannel.id },
      discordUserId,
    );
  } catch (error) {
    await voiceChannel.delete("Event voice channel binding failed").catch(() => undefined);
    throw error;
  }

  event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (thread) {
    await thread.send(buildEventStartMessage(event, event.participants, voiceChannel.id));
  }

  return { event, voiceChannelId: voiceChannel.id, createdVoiceChannel: true };
}

/** Stops an event and removes its persisted voice channel only when it is empty. */
export async function stopDiscordEvent(
  client: Client,
  api: ApiClient,
  discordUserId: string,
  eventId: number,
): Promise<StoppedDiscordEvent> {
  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/stop`,
    {},
    discordUserId,
  );
  const voiceChannelId = event.discord_voice_channel_id;
  if (!voiceChannelId) {
    return { event, voiceChannelDeleted: false, voiceChannelOccupied: false };
  }

  let channel;
  try {
    channel = await client.channels.fetch(voiceChannelId);
  } catch (error) {
    // The channel is already gone on Discord's side (e.g. manually deleted) —
    // treat that the same as the "not found" case below instead of letting
    // the error surface to the caller.
    console.warn(`[EventLifecycle] Voice channel ${voiceChannelId} for event #${eventId} could not be fetched, treating as already stopped:`, error);
    channel = null;
  }
  if (!channel) {
    const cleared = await api.delete<EventDetailView>(
      `api/events/${eventId}/discord-voice-channel`,
      discordUserId,
    );
    return {
      event: cleared ?? event,
      voiceChannelDeleted: true,
      voiceChannelOccupied: false,
    };
  }
  if (!channel.isVoiceBased()) {
    throw new Error("The event's stored Discord channel is not a voice channel.");
  }
  if (channel.members.size > 0) {
    return { event, voiceChannelDeleted: false, voiceChannelOccupied: true };
  }

  await channel.delete(`Event #${eventId} stopped and voice channel was empty`);
  const cleared = await api.delete<EventDetailView>(
    `api/events/${eventId}/discord-voice-channel`,
    discordUserId,
  );
  return {
    event: cleared ?? event,
    voiceChannelDeleted: true,
    voiceChannelOccupied: false,
  };
}

/** Limits a Discord channel name without splitting Unicode code points. */
export function buildEventVoiceChannelName(eventId: number, title: string): string {
  const prefix = `Event ${eventId} — `;
  const normalizedTitle = title.trim() || "Live event";
  return Array.from(`${prefix}${normalizedTitle}`).slice(0, 100).join("");
}
