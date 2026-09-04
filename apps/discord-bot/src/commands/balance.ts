import { ChatInputCommandInteraction, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BalanceSummary } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';
import { formatSilver } from '../format.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('View your guild bank balance');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const balance = await api.get<BalanceSummary>('api/bank/balance', interaction.user.id);

  const pendingFmt = formatSilver(balance.pending_total);
  const requestedFmt = formatSilver(balance.requested_total);

  const embed = createBaseEmbed({
    category: 'GUILD VAULT',
    title: `💰 Vault Balance — ${interaction.user.displayName}`,
    description: '*Track pending loot splits, regear payouts, and withdrawal requests*',
    color: BOT_COLORS.BRAND,
    footerText: '💡 Payouts are distributed in-game via Guild Chest or Trade by Officers',
  }).addFields(
    {
      name: '📥 Available to Withdraw',
      value: [
        `• 💵 **Amount:** **${pendingFmt}** Silver`,
        `• 🧾 **Transactions:** **${balance.pending_count}** item(s)`,
      ].join('\n'),
      inline: true,
    },
    {
      name: '📤 Pending Approval',
      value: [
        `• ⏳ **Amount:** **${requestedFmt}** Silver`,
        `• 📄 **Requests:** **${balance.requested_count}** pending`,
      ].join('\n'),
      inline: true,
    },
  );

  const payload: any = { embeds: [embed] };

  if (balance.pending_total > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('bank:request_all')
        .setLabel(`Request Payout (${pendingFmt} Silver)`)
        .setEmoji('💸')
        .setStyle(ButtonStyle.Success),
    );
    payload.components = [row];
  }

  await interaction.editReply(payload);
}
