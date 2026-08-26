import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { asListItems } from '../api/resolve-user.js';
import type { PaginatedData, ProgressionLeaderboardEntry } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Top season XP ranks');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
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
    await interaction.reply({ embeds: [errEmbed], flags: ['Ephemeral'] });
    return;
  }

  const entries = asListItems(result);
  const embed = createBaseEmbed({
    category: 'SEASON RANK',
    title: '🏆 Season XP Leaderboard',
    color: BOT_COLORS.BRAND,
  });

  if (entries.length === 0) {
    embed.setDescription('*No ranks yet this season.*');
  } else {
    const lines = entries.map((e, i) => {
      const place = e.rank ?? i + 1;
      return `**${place}.** **${e.username}** — Lv **${e.level}** · **${e.xp.toLocaleString('en-US')}** XP`;
    });
    embed.setDescription(lines.join('\n'));
  }

  await interaction.reply({ embeds: [embed] });
}
