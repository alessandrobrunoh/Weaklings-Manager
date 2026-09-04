import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { asListItems } from '../api/resolve-user.js';
import type { PaginatedData, ProgressionLeaderboardEntry } from '../api/types.js';
import { BOT_COLORS, buildAsciiChart, createBaseEmbed, createResponseEmbed, formatCompactNumber } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Top season XP ranks');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  let result: PaginatedData<ProgressionLeaderboardEntry> | ProgressionLeaderboardEntry[];
  try {
    result = await api.get<PaginatedData<ProgressionLeaderboardEntry> | ProgressionLeaderboardEntry[]>(
      'api/progression/leaderboard',
      interaction.user.id,
      { page: 1, limit: 10 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load the leaderboard.';
    const errEmbed = createResponseEmbed('error', 'Leaderboard Unavailable', message, 'SEASON RANK');
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const entries = asListItems(result);
  const embed = createBaseEmbed({
    category: 'SEASON RANK',
    title: '🏆 Season XP Leaderboard',
    description: '*Top performing guild members in the active season*',
    color: BOT_COLORS.BRAND,
  });

  if (entries.length === 0) {
    embed.setDescription('*No ranks recorded yet for this season.*');
  } else {
    // Top 3 Podium
    const top3 = entries.slice(0, 3);
    const podiumIcons = ['🥇', '🥈', '🥉'];
    const podiumLines = top3.map((e, i) => {
      return `${podiumIcons[i]} **#${e.rank ?? i + 1} ${e.username}** — Level **${e.level}** · **${e.xp.toLocaleString('en-US')}** XP`;
    });

    embed.addFields({
      name: '👑 Podium',
      value: podiumLines.join('\n'),
      inline: false,
    });

    // ASCII Chart for top 5
    const chartData = entries.slice(0, 5).map((e) => ({
      label: e.username.length > 12 ? `${e.username.slice(0, 11)}…` : e.username,
      value: e.xp,
      display: `${formatCompactNumber(e.xp)} (Lv ${e.level})`,
    }));

    embed.addFields({
      name: '📊 XP COMPARISON',
      value: `\`\`\`\n${buildAsciiChart(chartData, 12, 12)}\n\`\`\``,
      inline: false,
    });

    // Ranks 4+
    const remaining = entries.slice(3);
    if (remaining.length > 0) {
      const remLines = remaining.map((e, idx) => {
        const place = e.rank ?? idx + 4;
        return `• **#${place}** **${e.username}** — Lv **${e.level}** · **${formatCompactNumber(e.xp)}** XP`;
      });
      embed.addFields({
        name: '📋 Other Rankings',
        value: remLines.join('\n'),
        inline: false,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}
