import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type {
  AlbionLinkStatus,
  BalanceSummary,
  EventView,
  PaginatedData,
  ProgressionMeView,
} from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('me')
  .setDescription('View your guild profile: role, linked character, and balance');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  // Fetch everything in parallel
  const [linkResult, balanceResult, eventsResult, progressionResult] = await Promise.allSettled([
    api.get<AlbionLinkStatus>('api/albion/link/me', interaction.user.id),
    api.get<BalanceSummary>('api/bank/balance', interaction.user.id),
    api.get<PaginatedData<EventView>>('api/events', interaction.user.id, {
      page: 1,
      limit: 100,
    }),
    api.get<ProgressionMeView>('api/progression/me', interaction.user.id),
  ]);

  const link        = linkResult.status        === 'fulfilled' ? linkResult.value        : null;
  const balance     = balanceResult.status     === 'fulfilled' ? balanceResult.value     : null;
  const events      = eventsResult.status      === 'fulfilled' ? eventsResult.value      : null;
  const progression = progressionResult.status === 'fulfilled' ? progressionResult.value : null;

  // Count upcoming events
  const upcomingCount = events?.items.filter(
    (e) => e.status === 'scheduled' || e.status === 'live',
  ).length ?? 0;

  const embed = createBaseEmbed({
    category: 'MEMBER PROFILE',
    title: `👤 ${interaction.user.displayName}`,
    description: '*Guild Member Overview & Financial Summary*',
    color: BOT_COLORS.BRAND,
  });

  // Albion link
  if (link?.linked) {
    let linkVal = `• **Name:** **${link.albion_player_name}**\n• **Status:** Linked 🟢`;
    if (link.linked_at) {
      const linkedDate = new Date(link.linked_at);
      linkVal += `\n• **Linked Since:** <t:${Math.floor(linkedDate.getTime() / 1000)}:d>`;
    }
    embed.addFields({
      name: '⚔️ Albion Character',
      value: linkVal,
      inline: true,
    });
  } else {
    embed.addFields({
      name: '⚔️ Albion Character',
      value: '• **Status:** Not Linked 🔴\n*Use `/link` to connect your character*',
      inline: true,
    });
  }

  // Balance
  if (balance) {
    embed.addFields({
      name: '💰 Guild Bank',
      value: `• **Pending:** **${balance.pending_total.toLocaleString('en-US')}** silver (${balance.pending_count} tx)\n• **Requested:** **${balance.requested_total.toLocaleString('en-US')}** silver (${balance.requested_count} tx)`,
      inline: true,
    });
  }

  // Upcoming events
  embed.addFields({
    name: '📅 Guild Activity',
    value: `• **Active Events:** **${upcomingCount}** scheduled`,
    inline: true,
  });

  if (progression) {
    const season = progression.season?.name ? ` (${progression.season.name})` : '';
    embed.addFields({
      name: '🏅 Season Rank',
      value: `• **Level:** **${progression.level}**${season}\n• **XP:** **${progression.xp.toLocaleString('en-US')}**`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
