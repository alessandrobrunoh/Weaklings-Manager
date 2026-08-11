import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed } from '../embeds/event.embed.js';
import { createResponseEmbed } from '../embeds/theme.js';

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

  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/stop`,
    {},
    interaction.user.id,
  );

  const embed = buildEventEmbed(event);
  const noticeEmbed = createResponseEmbed(
    'warning',
    'Event Stopped',
    `Event **#${eventId}** has been stopped. ⏹️`,
    'GUILD EVENT',
  );

  await interaction.editReply({
    embeds: [noticeEmbed, embed],
  });
}
