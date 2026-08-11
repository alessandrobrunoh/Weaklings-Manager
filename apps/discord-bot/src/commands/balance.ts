import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BalanceSummary } from '../api/types.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('View your guild bank balance');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const balance = await api.get<BalanceSummary>('api/bank/balance', interaction.user.id);

  const pendingFmt   = balance.pending_total.toLocaleString('en-US');
  const requestedFmt = balance.requested_total.toLocaleString('en-US');

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setAuthor({ name: 'Bank Balance' })
    .setTitle(interaction.user.displayName)
    .addFields(
      {
        name: 'Pending',
        value: `**${pendingFmt}** silver\n${balance.pending_count} transaction${balance.pending_count !== 1 ? 's' : ''}`,
        inline: true,
      },
      {
        name: 'Requested',
        value: `**${requestedFmt}** silver\n${balance.requested_count} transaction${balance.requested_count !== 1 ? 's' : ''}`,
        inline: true,
      },
    )
    .setFooter({ text: 'Use /balance-request to request a withdrawal of all pending silver.' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
