import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BattleSummary, PaginatedData } from '../api/types.js';
import { config } from '../config.js';
import { buildBattleListEmbed } from '../embeds/battle.embed.js';

export const data = new SlashCommandBuilder()
  .setName('battles')
  .setDescription('⚔️ View recent guild battles')
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
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const page = interaction.options.getInteger('page') ?? 1;

  const result = await api.get<PaginatedData<BattleSummary>>(
    'api/battles',
    interaction.user.id,
    { page, limit: 10 },
  );

  const embed = buildBattleListEmbed(result.items, config.GUILD_NAME, result.current_page, result.total_pages);

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`battles:prev:${page}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`battles:next:${page}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= result.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}
