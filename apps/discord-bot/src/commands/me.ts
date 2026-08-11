import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionLinkStatus, BalanceSummary, EventView, PaginatedData } from '../api/types.js';

export const data = new SlashCommandBuilder()
  .setName('me')
  .setDescription('View your guild profile: role, linked character, and balance');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Fetch everything in parallel
  const [linkResult, balanceResult, eventsResult] = await Promise.allSettled([
    api.get<AlbionLinkStatus>('api/albion/link/me', interaction.user.id),
    api.get<BalanceSummary>('api/bank/balance', interaction.user.id),
    api.get<PaginatedData<EventView>>('api/events', interaction.user.id, {
      page: 1,
      limit: 100,
    }),
  ]);

  const link    = linkResult.status    === 'fulfilled' ? linkResult.value    : null;
  const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
  const events  = eventsResult.status  === 'fulfilled' ? eventsResult.value  : null;

  // Count upcoming events
  const upcomingCount = events?.items.filter(
    (e) => e.status === 'scheduled' || e.status === 'live',
  ).length ?? 0;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: 'Your Profile' })
    .setTitle(interaction.user.displayName);

  // Albion link
  if (link?.linked) {
    embed.addFields({
      name: 'Albion Character',
      value: `**${link.albion_player_name}**`,
      inline: true,
    });
    if (link.linked_at) {
      const linkedDate = new Date(link.linked_at);
      embed.addFields({
        name: 'Linked since',
        value: `<t:${Math.floor(linkedDate.getTime() / 1000)}:d>`,
        inline: true,
      });
    }
  } else {
    embed.addFields({
      name: 'Albion Character',
      value: '*Not linked — use `/link` to connect your character*',
      inline: false,
    });
  }

  // Balance
  if (balance) {
    embed.addFields({
      name: 'Pending Silver',
      value: `**${balance.pending_total.toLocaleString('en-US')}** (${balance.pending_count} tx)`,
      inline: true,
    });
    embed.addFields({
      name: 'Requested',
      value: `**${balance.requested_total.toLocaleString('en-US')}** (${balance.requested_count} tx)`,
      inline: true,
    });
  }

  // Upcoming events
  embed.addFields({
    name: 'Active Events',
    value: upcomingCount > 0 ? String(upcomingCount) : 'None',
    inline: true,
  });

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
