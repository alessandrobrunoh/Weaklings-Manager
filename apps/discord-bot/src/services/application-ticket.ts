import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
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

/**
 * Turns a Discord username into something Discord accepts as a channel name.
 */
export function ticketChannelName(username: string, fallback: string): string {
  const safe = username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `ticket-${safe || fallback}`.slice(0, 100);
}

/**
 * The permission overwrites an open ticket needs.
 *
 * Shared by the create and reopen paths precisely because a reopened ticket has
 * to end up in the same state a fresh one would: closing it revoked the
 * applicant's `ViewChannel`, so without re-applying this they would be handed a
 * ticket they cannot see.
 */
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

/**
 * The applicant's archived ticket channel, when it is still there to reuse.
 *
 * Returns `null` for a ticket that was never resolved, or whose channel has
 * since been deleted — in both cases the caller opens a fresh one.
 */
export async function findReusableTicket(
  guild: Guild,
  api: ApiClient,
  discordId: string,
): Promise<{ application: ApplicationView; channel: TextChannel } | null> {
  const latest = await api
    .get<ApplicationView | null>('api/applications/latest', discordId)
    .catch(() => null);
  if (!latest || latest.status === 'open' || !latest.channel_id) {
    return null;
  }
  const channel = await fetchGuildChannel(guild, latest.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return null;
  }
  return { application: latest, channel: channel as TextChannel };
}

/**
 * Brings an archived ticket back: same channel, same history, working buttons.
 */
export async function reopenTicket(
  guild: Guild,
  api: ApiClient,
  settings: GuildSettingsView,
  applicantId: string,
  channel: TextChannel,
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

  // Discord side only after the backend agreed, so a refused reopen never
  // leaves a ticket sitting visibly in the active category.
  await channel
    .setParent(categoryId, { lockPermissions: false })
    .catch(() => undefined);
  // Replaced wholesale rather than patched: closing the ticket revoked the
  // applicant's access, and the manage role may have changed since.
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
