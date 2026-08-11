import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { TransactionView, WithdrawRequest } from '../api/types.js';

export const data = new SlashCommandBuilder()
  .setName('balance-request')
  .setDescription('Request a withdrawal of all your pending silver');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const body: WithdrawRequest = { all: true };
  const txs = await api.post<TransactionView[]>(
    'api/bank/transactions/withdraw',
    body,
    interaction.user.id,
  );

  const total  = txs.reduce((sum, tx) => sum + tx.amount, 0);
  const totalFmt = total.toLocaleString('en-US');

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setAuthor({ name: 'Bank — Withdrawal Request' })
    .setDescription(
      `Withdrawal of **${totalFmt} silver** across **${txs.length}** transaction${txs.length !== 1 ? 's' : ''} submitted.\nAn officer will process it shortly.`,
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
