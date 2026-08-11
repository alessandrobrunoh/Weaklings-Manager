import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed, buildEventActionRows } from '../embeds/event.embed.js';
import { createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('event-join')
  .setDescription('🙋 Sign up for a guild event by role')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID (from /events)').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const eventId = interaction.options.getInteger('event_id', true);

  // Fetch event to confirm it exists and show details
  let event: EventDetailView;
  try {
    event = await api.get<EventDetailView>(`api/events/${eventId}`, interaction.user.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Event not found.';
    const errEmbed = createResponseEmbed('error', 'Event Not Found', msg, 'GUILD EVENT');
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  if (event.status !== 'scheduled') {
    const errEmbed = createResponseEmbed(
      'error',
      'Cannot Join Event',
      `You can only join events with status \`scheduled\`. This event is currently \`${event.status}\`.`,
      'GUILD EVENT',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const embed = buildEventEmbed(event);
  const [row1, row2] = buildEventActionRows(eventId);

  const infoEmbed = createResponseEmbed(
    'info',
    'Event Registration',
    '🎯 Select your build role below to sign up for this event:',
    'GUILD EVENT',
  );

  await interaction.editReply({
    embeds: [infoEmbed, embed],
    components: [row1, row2],
  });
}
