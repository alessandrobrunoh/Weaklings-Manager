import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { BOT_COLORS, buildAsciiBar, createBaseEmbed } from '../embeds/theme.js';
import { formatSilver } from '../format.js';

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

  const link = linkResult.status === 'fulfilled' ? linkResult.value : null;
  const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
  const events = eventsResult.status === 'fulfilled' ? eventsResult.value : null;
  const progression = progressionResult.status === 'fulfilled' ? progressionResult.value : null;

  // Count upcoming events
  const upcomingCount = events?.items.filter(
    (e) => e.status === 'scheduled' || e.status === 'live',
  ).length ?? 0;

  const characterSubtitle = link?.linked
    ? `Linked to **${link.albion_player_name}**`
    : 'No linked character';

  const embed = createBaseEmbed({
    category: 'MEMBER PROFILE',
    title: `👤 ${interaction.user.displayName}`,
    description: `*Guild Member Overview · ${characterSubtitle}*`,
    color: BOT_COLORS.BRAND,
  });

  // Albion link
  if (link?.linked) {
    let linkVal = `• ⚔️ **Name:** **${link.albion_player_name}**\n• 🟢 **Status:** Linked`;
    if (link.linked_at) {
      const linkedDate = new Date(link.linked_at);
      linkVal += `\n• 🗓️ **Since:** <t:${Math.floor(linkedDate.getTime() / 1000)}:d>`;
    }
    embed.addFields({
      name: '⚔️ Albion Character',
      value: linkVal,
      inline: true,
    });
  } else {
    embed.addFields({
      name: '⚔️ Albion Character',
      value: '• 🔴 **Status:** Not Linked\n*Use `/link` to connect character*',
      inline: true,
    });
  }

  // Balance
  if (balance) {
    embed.addFields({
      name: '💰 Guild Bank',
      value: [
        `• 📥 **Pending:** **${formatSilver(balance.pending_total)}** (${balance.pending_count} tx)`,
        `• 📤 **Requested:** **${formatSilver(balance.requested_total)}** (${balance.requested_count} tx)`,
      ].join('\n'),
      inline: true,
    });
  }

  // Progression & Rank
  if (progression) {
    const season = progression.season?.name ? ` (${progression.season.name})` : '';
    const rankText = progression.rank != null ? `#${progression.rank}` : '—';
    embed.addFields({
      name: '🏅 Season Progression',
      value: [
        `• 🎯 **Level:** **${progression.level}**${season}`,
        `• 🏆 **Rank:** **${rankText}**`,
        `• ⭐ **XP:** **${progression.xp.toLocaleString('en-US')}**`,
      ].join('\n'),
      inline: true,
    });

    if (progression.next_level_at > 0) {
      const pct = Math.min(100, Math.round((progression.xp / progression.next_level_at) * 100));
      const bar = buildAsciiBar(progression.xp, progression.next_level_at, 16);
      const nextRemaining = Math.max(0, progression.next_level_at - progression.xp);
      embed.addFields({
        name: '⚡ LEVEL PROGRESSION',
        value: `\`\`\`\nLevel ${progression.level}  ${bar}  ${progression.xp.toLocaleString('en-US')} / ${progression.next_level_at.toLocaleString('en-US')} XP (${pct}%)\nNext Level: +${nextRemaining.toLocaleString('en-US')} XP needed\n\`\`\``,
        inline: false,
      });
    }
  }

  // Upcoming events
  embed.addFields({
    name: '📅 Guild Activity',
    value: `• 📌 **Active Events:** **${upcomingCount}** scheduled/live`,
    inline: false,
  });

  const payload: { embeds: any[]; components?: any[] } = { embeds: [embed] };

  if (balance && balance.pending_total > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('bank:request_all')
        .setLabel(`Request Balance (${formatSilver(balance.pending_total)})`)
        .setEmoji('💸')
        .setStyle(ButtonStyle.Success),
    );
    payload.components = [row];
  }

  await interaction.editReply(payload);
}
