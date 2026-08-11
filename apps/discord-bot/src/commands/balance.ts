import { ChatInputCommandInteraction, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BalanceSummary } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('View your guild bank balance');

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const balance = await api.get<BalanceSummary>('api/bank/balance', interaction.user.id);

  const pendingFmt   = balance.pending_total.toLocaleString('en-US');
  const requestedFmt = balance.requested_total.toLocaleString('en-US');

  const embed = createBaseEmbed({
    category: 'GUILD BANK',
    title: `💰 Bank Balance — ${interaction.user.displayName}`,
    description: '*View and manage your pending silver rewards and withdrawal requests.*',
    color: BOT_COLORS.BRAND,
    footerText: '💡 Tip: Use /balance-request to withdraw all pending silver.',
  }).addFields(
    {
      name: '📥 Pending Balance',
      value: `• **Amount:** **${pendingFmt}** silver\n• **Transactions:** ${balance.pending_count} pending`,
      inline: true,
    },
    {
      name: '📤 Requested Balance',
      value: `• **Amount:** **${requestedFmt}** silver\n• **Transactions:** ${balance.requested_count} requested`,
      inline: true,
    },
  );

  const payload: any = { embeds: [embed] };

  if (balance.pending_total > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('bank:request_all')
        .setLabel('Request your Balance')
        .setEmoji('💸')
        .setStyle(ButtonStyle.Success),
    );
    payload.components = [row];
  }

  await interaction.editReply(payload);
}
