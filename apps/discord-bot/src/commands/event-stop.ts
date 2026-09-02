import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { createResponseEmbed } from '../embeds/theme.js';
import { stopDiscordEvent } from '../services/event-lifecycle.js';
import { getPoller } from '../services/poller.js';

export const data = new SlashCommandBuilder()
  .setName('event-stop')
  .setDescription('⏹️ Stop a live event (Officer+ only)')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const eventId = interaction.options.getInteger('event_id', true);

  const result = await stopDiscordEvent(
    interaction.client,
    api,
    interaction.user.id,
    eventId,
  );
  // Close the discussion immediately when the command is issued from Discord. Events stopped from
  // the web app are handled by the poller's terminal-status reconciliation.
  await getPoller()?.closeEventThread(eventId);

  const message = result.voiceChannelOccupied
    ? `Event **#${eventId}** stopped. Its voice channel is still occupied, so it was kept.`
    : result.voiceChannelDeleted
      ? `Event **#${eventId}** stopped and its empty voice channel was deleted.`
      : `Event **#${eventId}** has been stopped. ⏹️`;
  const noticeEmbed = createResponseEmbed('warning', 'Event Stopped', message, 'GUILD EVENT');

  await interaction.editReply({ embeds: [noticeEmbed] });
}
