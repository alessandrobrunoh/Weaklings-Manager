import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type {
  AlbionLinkStatus,
  AlbionSearchResult,
  ApplicationView,
  GuildSettingsView,
} from '../api/types.js';

/** What the automatic Albion link managed to do for the applicant. */
export type LinkOutcome = 'linked' | 'already-linked' | 'not-found' | 'failed';

/** Whether the applicant landed in a brand new ticket or their old one. */
export interface TicketResult {
  readonly application: ApplicationView;
  readonly channelId: string;
  readonly reopened: boolean;
}

/** Turns a Discord username into a safe, bounded thread name. */
export function threadName(prefix: 'apply' | 'ticket', username: string, fallback: string): string {
  const safe = username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80 - prefix.length - 1);
  return `${prefix}-${safe || fallback}`.slice(0, 100);
}

export function ticketThreadName(username: string, fallback: string): string {
  return threadName('ticket', username, fallback);
}

/** @deprecated Kept for compatibility with callers written before threads. */
export function ticketChannelName(username: string, fallback: string): string {
  return ticketThreadName(username, fallback);
}

export function applicationThreadName(username: string, fallback: string): string {
  return threadName('apply', username, fallback);
}

/** Legacy channel overwrites retained for applications created before threads. */
export function ticketOverwrites(
  guild: Guild,
  applicantId: string,
  manageRoleId: string | null,
  botId: string | undefined,
) {
  const canTalk = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: applicantId, allow: canTalk },
    ...(manageRoleId ? [{ id: manageRoleId, allow: canTalk }] : []),
    ...(botId
      ? [{ id: botId, allow: [...canTalk, PermissionFlagsBits.ManageChannels] }]
      : []),
  ];
}

export type TicketChannel = TextChannel | ThreadChannel;

/** Adds the applicant and every cached member of the configured manager role. */
export async function grantThreadAccess(
  thread: ThreadChannel,
  applicantId: string,
  manageRoleId: string | null,
  guild: Guild,
): Promise<void> {
  await thread.members.add(applicantId);
  if (!manageRoleId) return;
  const role = await guild.roles.fetch(manageRoleId).catch(() => null);
  for (const memberId of role?.members.keys() ?? []) {
    await thread.members.add(memberId).catch(() => undefined);
  }
}

/** Creates a private thread and limits membership to the applicant and managers. */
export async function createPrivateTicketThread(
  parent: TextChannel,
  name: string,
  guild: Guild,
  applicantId: string,
  manageRoleId: string | null,
  reason: string,
): Promise<ThreadChannel> {
  const thread = await parent.threads.create({
    name,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 1440,
    reason,
  });
  try {
    await grantThreadAccess(thread, applicantId, manageRoleId, guild);
  } catch (error) {
    await thread.delete('Could not grant ticket access').catch(() => undefined);
    throw error;
  }
  return thread;
}

/**
 * The applicant's archived ticket thread/channel, when it is still there to reuse.
 *
 * Returns `null` for a ticket that was never resolved, or whose thread/channel has
 * since been deleted — in both cases the caller opens a fresh one.
 */
export async function findReusableTicket(
  guild: Guild,
  api: ApiClient,
  discordId: string,
): Promise<{ application: ApplicationView; channel: TicketChannel } | null> {
  const latest = await api
    .get<ApplicationView | null>('api/applications/latest', discordId)
    .catch(() => null);
  if (!latest || latest.status === 'open' || !latest.channel_id) {
    return null;
  }
  const channel = await fetchGuildChannel(guild, latest.channel_id);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
    return null;
  }
  return { application: latest, channel: channel as TicketChannel };
}

/**
 * Brings an archived ticket back: same thread/channel, same history, working buttons.
 */
export async function reopenTicket(
  guild: Guild,
  api: ApiClient,
  settings: GuildSettingsView,
  applicantId: string,
  channel: TicketChannel,
  applicationId: number,
  ingameName: string | null,
  categoryId: string,
  botId: string | undefined,
): Promise<ApplicationView> {
  const application = await api.post<ApplicationView>(
    `api/applications/${applicationId}/reopen`,
    { ingame_name: ingameName },
    applicantId,
  );

  if ('setLocked' in channel) {
    await channel.setLocked(false, 'Application reopened').catch(() => undefined);
    await channel.setArchived(false, 'Application reopened').catch(() => undefined);
    await grantThreadAccess(
      channel,
      applicantId,
      settings.discord_applications_manage_role_id ?? null,
      guild,
    ).catch(() => undefined);
  } else if ('setParent' in channel && 'permissionOverwrites' in channel) {
    // Keep legacy channel applications reopenable while guilds migrate to
    // private threads.
    await channel
      .setParent(categoryId, { lockPermissions: false })
      .catch(() => undefined);
    await channel.permissionOverwrites
      .set(
        ticketOverwrites(
          guild,
          applicantId,
          settings.discord_applications_manage_role_id ?? null,
          botId,
        ),
        'Application reopened',
      )
      .catch(() => undefined);
  }

  return application;
}

/**
 * Links the applicant's Albion character, which also renames them in Discord
 * and grants the guild role — all of that already happens backend-side on
 * `POST /albion/link`, so this only has to find the player id for the name.
 */
export async function linkIngameName(
  api: ApiClient,
  discordId: string,
  ingameName: string,
): Promise<LinkOutcome> {
  let player: { id: string; name: string } | undefined;
  try {
    const results = await api.get<AlbionSearchResult>('api/albion/search', discordId, {
      q: ingameName,
    });
    const wanted = ingameName.trim().toLowerCase();
    player =
      results.players.find((candidate) => candidate.name.toLowerCase() === wanted) ??
      undefined;
  } catch {
    return 'failed';
  }
  if (!player) {
    return 'not-found';
  }
  try {
    await api.post<AlbionLinkStatus>(
      'api/albion/link',
      { albion_player_id: player.id, albion_player_name: player.name },
      discordId,
    );
    return 'linked';
  } catch (error) {
    // The backend answers 409 when this Discord account already has a
    // character, which is a perfectly normal thing for a returning member.
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return message.includes('already linked') ? 'already-linked' : 'failed';
  }
}

/** Cache-first channel lookup that tolerates a deleted channel. */
export async function fetchGuildChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildBasedChannel | null> {
  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}
