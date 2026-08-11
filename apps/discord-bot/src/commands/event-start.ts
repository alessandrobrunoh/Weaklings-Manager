import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed } from '../embeds/event.embed.js';

export const data = new SlashCommandBuilder()
  .setName('event-start')
  .setDescription('▶️ Start a scheduled event (Officer+ only)')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const eventId = interaction.options.getInteger('event_id', true);

  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/start`,
    {},
    interaction.user.id,
  );

  const embed = buildEventEmbed(event);
  await interaction.editReply({
    content: `✅ Event **#${eventId}** is now **LIVE**!`,
    embeds: [embed],
  });
}
