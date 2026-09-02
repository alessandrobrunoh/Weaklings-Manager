import { ChannelType, type Client, type ThreadChannel } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import { buildEventMassMessage, buildEventStartMessage } from "../embeds/event.embed.js";
import { config } from "../config.js";
import { getSettingsService } from "./settings.js";

export interface MassedDiscordEvent {
  event: EventDetailView;
  voiceChannelId: string;
  createdVoiceChannel: boolean;
}
export interface StartedDiscordEvent extends MassedDiscordEvent {}
export interface StoppedDiscordEvent {
  event: EventDetailView;
  voiceChannelDeleted: boolean;
  voiceChannelOccupied: boolean;
}

const massLocks = new Map<number, Promise<MassedDiscordEvent>>();
const startLocks = new Map<number, Promise<StartedDiscordEvent>>();

/** Performs the pre-event Mass: notify participants and provision/bind voice, leaving scheduled. */
export function massDiscordEvent(client: Client, api: ApiClient, discordUserId: string, eventId: number, thread?: ThreadChannel): Promise<MassedDiscordEvent> {
  const inFlight = massLocks.get(eventId);
  if (inFlight) return inFlight;
  const run = massDiscordEventLocked(client, api, discordUserId, eventId, thread).finally(() => massLocks.delete(eventId));
  massLocks.set(eventId, run);
  return run;
}

async function massDiscordEventLocked(client: Client, api: ApiClient, discordUserId: string, eventId: number, thread?: ThreadChannel): Promise<MassedDiscordEvent> {
  let event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (event.status !== "scheduled") throw new Error(`Event #${eventId} cannot be massed because it is ${event.status}.`);
  const hadVoiceChannel = Boolean(event.discord_voice_channel_id);
  const voiceChannelId = event.discord_voice_channel_id ?? await createAndBindVoice(client, api, discordUserId, event);
  event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (thread) await thread.send(buildEventMassMessage(event, event.participants, voiceChannelId));
  return { event, voiceChannelId, createdVoiceChannel: !hadVoiceChannel };
}

/** Starts an event, reusing the Mass voice channel when one exists. */
export async function startDiscordEvent(client: Client, api: ApiClient, discordUserId: string, eventId: number, thread?: ThreadChannel): Promise<StartedDiscordEvent> {
  const inFlight = startLocks.get(eventId);
  if (inFlight) return inFlight;
  const run = startDiscordEventLocked(client, api, discordUserId, eventId, thread).finally(() => startLocks.delete(eventId));
  startLocks.set(eventId, run);
  return run;
}

async function startDiscordEventLocked(client: Client, api: ApiClient, discordUserId: string, eventId: number, thread?: ThreadChannel): Promise<StartedDiscordEvent> {
  let event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (event.status === "scheduled") {
    await api.post(`api/events/${eventId}/start`, {}, discordUserId);
    event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  } else if (event.status !== "live") {
    throw new Error(`Event #${eventId} cannot be started because it is ${event.status}.`);
  }
  const hadVoiceChannel = Boolean(event.discord_voice_channel_id);
  const voiceChannelId = event.discord_voice_channel_id ?? await createAndBindVoice(client, api, discordUserId, event);
  event = await api.get<EventDetailView>(`api/events/${eventId}`, discordUserId);
  if (thread) await thread.send(buildEventStartMessage(event, event.participants, voiceChannelId));
  return { event, voiceChannelId, createdVoiceChannel: !hadVoiceChannel };
}

async function createAndBindVoice(client: Client, api: ApiClient, discordUserId: string, event: EventDetailView): Promise<string> {
  const categoryId = await getSettingsService().eventVoiceCategoryId();
  if (!categoryId) throw new Error("No event voice category is configured. Ask an admin to configure it first.");
  const category = await client.channels.fetch(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error("The configured event voice category is missing or is not a Discord category.");
  const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
  const voiceChannel = await guild.channels.create({ name: buildEventVoiceChannelName(event.id, event.title), type: ChannelType.GuildVoice, parent: category.id, reason: `Event #${event.id} mass voice` });
  try {
    await api.put(`api/events/${event.id}/discord-voice-channel`, { channel_id: voiceChannel.id }, discordUserId);
    return voiceChannel.id;
  } catch (error) {
    await voiceChannel.delete("Event voice channel binding failed").catch(() => undefined);
    throw error;
  }
}

/** Stops an event and deletes its voice channel only when it is empty. */
export async function stopDiscordEvent(client: Client, api: ApiClient, discordUserId: string, eventId: number): Promise<StoppedDiscordEvent> {
  const event = await api.post<EventDetailView>(`api/events/${eventId}/stop`, {}, discordUserId);
  const voiceChannelId = event.discord_voice_channel_id;
  if (!voiceChannelId) return { event, voiceChannelDeleted: false, voiceChannelOccupied: false };
  let channel;
  try { channel = await client.channels.fetch(voiceChannelId); } catch { channel = null; }
  if (!channel) {
    const cleared = await api.delete<EventDetailView>(`api/events/${eventId}/discord-voice-channel`, discordUserId);
    return { event: cleared ?? event, voiceChannelDeleted: true, voiceChannelOccupied: false };
  }
  if (!channel.isVoiceBased()) throw new Error("The event's stored Discord channel is not a voice channel.");
  if (channel.members.size > 0) return { event, voiceChannelDeleted: false, voiceChannelOccupied: true };
  await channel.delete(`Event #${eventId} stopped and voice channel was empty`);
  const cleared = await api.delete<EventDetailView>(`api/events/${eventId}/discord-voice-channel`, discordUserId);
  return { event: cleared ?? event, voiceChannelDeleted: true, voiceChannelOccupied: false };
}

export function buildEventVoiceChannelName(eventId: number, title: string): string {
  return Array.from(`Event ${eventId} — ${title.trim() || "Live event"}`).slice(0, 100).join("");
}
