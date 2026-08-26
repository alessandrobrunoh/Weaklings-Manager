import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import { parseMultiplier, resolveInternalUserId } from '../api/resolve-user.js';
import type { ProgressionMeView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('View season XP, level, and rank')
  .addUserOption((opt) =>
    opt.setName('member').setDescription('Guild member to look up').setRequired(false),
  );

function xpBar(xp: number, nextAt: number): string {
  const width = 10;
  const filled = nextAt > 0 ? Math.max(0, Math.min(1, xp / nextAt)) : 1;
  const n = Math.round(filled * width);
  return `\`${'█'.repeat(n)}${'░'.repeat(width - n)}\``;
}

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
  const nextText =
    view.xp_to_next > 0
      ? `${view.xp.toLocaleString('en-US')} / ${view.next_level_at.toLocaleString('en-US')} (${view.xp_to_next.toLocaleString('en-US')} to next)`
      : `${view.xp.toLocaleString('en-US')} XP (max level)`;

  const lines = [
    `• **Season:** **${seasonName}**`,
    `• **Level:** **${view.level}**`,
    `• **XP:** **${nextText}**`,
    `• **Progress:** ${xpBar(view.xp, view.next_level_at)}`,
    `• **Rank:** **${rankText}**`,
  ];
  if (multiplier !== 1) {
    lines.push(`• **Multiplier:** **${multiplier}×**`);
  }

  const embed = createBaseEmbed({
    category: 'SEASON RANK',
    title: `🏅 ${target.displayName}`,
    description: lines.join('\n'),
    color: BOT_COLORS.BRAND,
  });

  await interaction.editReply({ embeds: [embed] });
}
