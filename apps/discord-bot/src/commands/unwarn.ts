import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { WarnView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('unwarn')
  .setDescription('Revoke a warn by id (Officer+)')
  .addIntegerOption((opt) =>
    opt.setName('id').setDescription('Warn id').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const id = interaction.options.getInteger('id', true);
  const result = await api.post<WarnView>(`api/warns/${id}/revoke`, {}, interaction.user.id);

  const embed = createBaseEmbed({
    category: 'DISCIPLINARY ACTION',
    title: '✅ Warn Revoked',
    description: `*Warn \`#${result.id ?? id}\` has been formally revoked (historical record is archived).*`,
    color: BOT_COLORS.SUCCESS,
  });
  await interaction.editReply({ embeds: [embed] });
}
