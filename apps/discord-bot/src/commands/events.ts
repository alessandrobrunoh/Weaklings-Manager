import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData, EventView } from '../api/types.js';
import { buildEventSummaryEmbed } from '../embeds/event.embed.js';

export const data = new SlashCommandBuilder()
  .setName('events')
  .setDescription('📅 View upcoming and active guild events')
  .addIntegerOption((opt) =>
    opt
      .setName('page')
      .setDescription('Page number (default: 1)')
      .setMinValue(1)
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const page = interaction.options.getInteger('page') ?? 1;

  const data = await api.get<PaginatedData<EventView>>(
    'api/events',
    interaction.user.id,
    { page, limit: 10 },
  );

  const embed = buildEventSummaryEmbed(data.items, data.current_page, data.total_pages);

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`events:prev:${page}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`events:next:${page}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= data.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}
