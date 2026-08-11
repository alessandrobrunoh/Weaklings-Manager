import { Colors, EmbedBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionLinkRequest, AlbionLinkStatus } from '../api/types.js';

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
  await interaction.deferReply({ ephemeral: true });

  const playerId = interaction.options.getString('player_id', true);
  const playerName = interaction.options.getString('player_name', true);

  const body: AlbionLinkRequest = {
    albion_player_id: playerId,
    albion_player_name: playerName,
  };

  const result = await api.post<AlbionLinkStatus>('api/albion/link', body, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('🔗 Account Linked!')
    .setDescription(
      `Your Discord account has been linked to Albion character **${result.albion_player_name ?? playerName}**.`,
    )
    .addFields({
      name: '🆔 Player ID',
      value: result.albion_player_id ?? playerId,
      inline: true,
    })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
