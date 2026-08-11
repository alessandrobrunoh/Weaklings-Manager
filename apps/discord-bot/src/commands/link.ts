import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionLinkRequest, AlbionLinkStatus } from '../api/types.js';
import { createResponseEmbed } from '../embeds/theme.js';

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

  const desc = [
    `• 👤 **Discord User:** <@${interaction.user.id}>`,
    `• ⚔️ **Albion Character:** **${result.albion_player_name ?? playerName}**`,
    `• 🆔 **Player ID:** \`${result.albion_player_id ?? playerId}\``,
  ].join('\n');

  const embed = createResponseEmbed(
    'success',
    'Character Linked Successfully',
    desc,
    'ACCOUNT LINKING',
  );

  await interaction.editReply({ embeds: [embed] });
}
