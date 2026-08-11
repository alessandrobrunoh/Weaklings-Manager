import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed, buildEventActionRows } from '../embeds/event.embed.js';

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
  await interaction.deferReply({ ephemeral: true });

  const eventId = interaction.options.getInteger('event_id', true);

  // Fetch event to confirm it exists and show details
  let event: EventDetailView;
  try {
    event = await api.get<EventDetailView>(`api/events/${eventId}`, interaction.user.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Event not found.';
    await interaction.editReply({ content: `❌ ${msg}` });
    return;
  }

  if (event.status !== 'scheduled') {
    await interaction.editReply({
      content: `❌ You can only join events with status \`scheduled\`. This event is \`${event.status}\`.`,
    });
    return;
  }

  const embed = buildEventEmbed(event);
  const [row1, row2] = buildEventActionRows(eventId);

  await interaction.editReply({
    content: '🎯 Select your build role to join the event:',
    embeds: [embed],
    components: [row1, row2],
  });
}
