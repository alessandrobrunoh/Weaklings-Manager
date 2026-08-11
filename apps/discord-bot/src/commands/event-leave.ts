import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';

export const data = new SlashCommandBuilder()
  .setName('event-leave')
  .setDescription('🚪 Leave a guild event you have signed up for')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID (from /events)').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const eventId = interaction.options.getInteger('event_id', true);

  await api.delete(`api/events/${eventId}/participate`, interaction.user.id);
  await interaction.editReply({ content: `✅ You have left event **#${eventId}**.` });
}
