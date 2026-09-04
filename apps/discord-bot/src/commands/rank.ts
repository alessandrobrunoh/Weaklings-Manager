import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import { parseMultiplier, resolveInternalUserId } from '../api/resolve-user.js';
import type { ProgressionMeView } from '../api/types.js';
import { BOT_COLORS, buildAsciiBar, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('View season XP, level, and rank')
  .addUserOption((opt) =>
    opt.setName('member').setDescription('Guild member to look up').setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const target = interaction.options.getUser('member') ?? interaction.user;
  const isSelf = target.id === interaction.user.id;

  let view: ProgressionMeView;
  try {
    if (isSelf) {
      view = await api.get<ProgressionMeView>('api/progression/me', interaction.user.id);
    } else {
      const userId = await resolveInternalUserId(
        api,
        interaction.user.id,
        target.id,
        target.username,
      );
      if (userId === null) {
        const errEmbed = createResponseEmbed(
          'error',
          'Account Not Found',
          `**${target.displayName}** has no linked guild account.`,
          'SEASON RANK',
        );
        await interaction.editReply({ embeds: [errEmbed] });
        return;
      }
      view = await api.get<ProgressionMeView>(
        `api/progression/users/${userId}`,
        interaction.user.id,
      );
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      const errEmbed = createResponseEmbed(
        'error',
        'No Permission',
        'You do not have permission to view this member\'s season rank.',
        'SEASON RANK',
      );
      await interaction.editReply({ embeds: [errEmbed] });
      return;
    }
    throw err;
  }

  const multiplier = parseMultiplier(view.multiplier);
  const seasonName = view.season?.name ?? 'No active season';
  const rankText = view.rank != null ? `#${view.rank}` : '—';

  const embed = createBaseEmbed({
    category: 'SEASON PROGRESSION',
    title: `🏅 ${target.displayName}`,
    description: `*Standing: Rank **${rankText}** · Active Season: **${seasonName}***`,
    color: BOT_COLORS.BRAND,
  });

  embed.addFields(
    {
      name: '🎯 Current Standing',
      value: [
        `• 🌟 **Level:** **${view.level}**`,
        `• 🏆 **Season Rank:** **${rankText}**`,
        `• ⚡ **Multiplier:** **${multiplier}×**`,
      ].join('\n'),
      inline: true,
    },
    {
      name: '📈 Season Stats',
      value: [
        `• ⭐ **Total XP:** **${view.xp.toLocaleString('en-US')}**`,
        `• 🎯 **Target:** **${view.next_level_at.toLocaleString('en-US')}** XP`,
        `• ⏳ **To Next Level:** **${view.xp_to_next > 0 ? view.xp_to_next.toLocaleString('en-US') : 'Max Level'}**`,
      ].join('\n'),
      inline: true,
    },
  );

  if (view.next_level_at > 0) {
    const pct = Math.min(100, Math.round((view.xp / view.next_level_at) * 100));
    const bar = buildAsciiBar(view.xp, view.next_level_at, 18);
    embed.addFields({
      name: '⚡ LEVEL PROGRESSION',
      value: `\`\`\`\nLevel ${view.level}  ${bar}  ${view.xp.toLocaleString('en-US')} / ${view.next_level_at.toLocaleString('en-US')} XP (${pct}%)\n[ ${view.xp_to_next > 0 ? `${view.xp_to_next.toLocaleString('en-US')} XP remaining until Level ${view.level + 1}` : 'Max level achieved!'} ]\n\`\`\``,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
