import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { buildApplicationPanelComponents, buildApplicationPanelEmbed } from '../embeds/application.embed.js';
import { createResponseEmbed } from '../embeds/theme.js';
import { getSettingsService } from '../services/settings.js';
import type { GuildSettingsView } from '../api/types.js';

export const data = new SlashCommandBuilder()
  .setName('applications-panel')
  .setDescription('Pubblica la card delle application nel canale configurato')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(
  interaction: ChatInputCommandInteraction,
  _api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const settings: GuildSettingsView = await getSettingsService().applicationsSettings();
  const channelId = settings.discord_applications_channel_id;
  if (!channelId) {
    throw new Error('Configura prima il canale delle application dal pannello admin.');
  }

  const channel = await interaction.client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new Error('Il canale delle application non è un canale testuale del server.');
  }

  await channel.send({
    embeds: [buildApplicationPanelEmbed(settings)],
    components: buildApplicationPanelComponents(settings),
  });
  await interaction.editReply({
    embeds: [createResponseEmbed('success', 'Application panel', 'La card delle application è stata pubblicata.', 'APPLICATIONS')],
  });
}
