import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionLinkRequest, AlbionLinkStatus } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('link')
  .setDescription('🔗 Link your Albion Online character to your guild account')
  .addStringOption((opt) =>
    opt
      .setName('player_id')
      .setDescription('Your Albion Online player ID (from the game or albionbb.com)')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('player_name').setDescription('Your Albion Online character name').setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const playerId = interaction.options.getString('player_id', true);
  const playerName = interaction.options.getString('player_name', true);

  const body: AlbionLinkRequest = {
    albion_player_id: playerId,
    albion_player_name: playerName,
  };

  const result = await api.post<AlbionLinkStatus>('api/albion/link', body, interaction.user.id);

  const embed = createBaseEmbed({
    category: 'ACCOUNT LINKING',
    title: '🔗 Albion Character Linked',
    description: '*Your Discord account has been successfully connected to Albion Online*',
    color: BOT_COLORS.SUCCESS,
  }).addFields(
    {
      name: '👤 Discord User',
      value: `<@${interaction.user.id}>`,
      inline: true,
    },
    {
      name: '⚔️ Albion Character',
      value: `**${result.albion_player_name ?? playerName}**`,
      inline: true,
    },
    {
      name: '🆔 Player ID',
      value: `\`${result.albion_player_id ?? playerId}\``,
      inline: false,
    },
  );

  await interaction.editReply({ embeds: [embed] });
}
