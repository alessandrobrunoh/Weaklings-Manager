import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { TransactionView, WithdrawRequest } from '../api/types.js';
import { createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('balance-request')
  .setDescription('Request a withdrawal of all your pending silver');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const body: WithdrawRequest = { all: true };
  const txs = await api.post<TransactionView[]>(
    'api/bank/transactions/withdraw',
    body,
    interaction.user.id,
  );

  const total    = txs.reduce((sum, tx) => sum + tx.amount, 0);
  const totalFmt = total.toLocaleString('en-US');

  const desc = [
    `• 💰 **Total Amount:** **${totalFmt} silver**`,
    `• 📄 **Transactions:** **${txs.length}** pending item${txs.length !== 1 ? 's' : ''}`,
    `• ⏳ **Status:** Sent to Officers for payout approval`,
  ].join('\n');

  const embed = createResponseEmbed('success', 'Withdrawal Request Submitted', desc, 'GUILD BANK');

  await interaction.editReply({ embeds: [embed] });
}
