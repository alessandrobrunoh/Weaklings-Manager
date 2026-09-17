import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { ApiError, type ApiClient } from '../api/client.js';
import type { AlbionLinkStatus } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Register your Albion Online character by in-game name')
  .addStringOption((opt) =>
    opt.setName('ign').setDescription('Your Albion Online character name').setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const ign = interaction.options.getString('ign', true);

  try {
    // Checking status first makes /register safe to repeat and lets an
    // alliance member adopt the link created on their home guild. In that
    // case there is no reason to resolve an IGN (Albion names are not
    // globally unique, so the search may be ambiguous).
    let existing: AlbionLinkStatus | undefined;
    try {
      existing = await api.get<AlbionLinkStatus>(
        'api/albion/link/me',
        interaction.user.id,
      );
    } catch {
      // Keep the original register path available if the status check is
      // temporarily unavailable.
    }
    const result =
      existing?.linked === true
        ? existing
        : await api.post<AlbionLinkStatus>(
            'api/albion/register',
            { ign },
            interaction.user.id,
          );

    const embed = createBaseEmbed({
      category: 'ACCOUNT REGISTER',
      title: 'Albion Character Registered',
      description: '*Your Discord account has been linked to Albion Online*',
      color: BOT_COLORS.SUCCESS,
    }).addFields(
      {
        name: 'Discord User',
        value: `<@${interaction.user.id}>`,
        inline: true,
      },
      {
        name: 'Albion Character',
        value: `**${result.albion_player_name ?? ign}**`,
        inline: true,
      },
      {
        name: 'Player ID',
        value: `\`${result.albion_player_id ?? 'unknown'}\``,
        inline: false,
      },
    );

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const detail =
      error instanceof ApiError ? error.message : 'Could not register that character.';
    const embed = createResponseEmbed('error', 'Register failed', detail, 'ACCOUNT REGISTER');
    await interaction.editReply({ embeds: [embed] });
  }
}
