import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventView, PaginatedData, CompSummary, CreateEventRequest } from '../api/types.js';
import { buildEventEmbed, buildEventActionRows } from '../embeds/event.embed.js';

export const data = new SlashCommandBuilder()
  .setName('event-create')
  .setDescription('🗓️ Create a new guild event (Officer+ only)')
  .addStringOption((opt) =>
    opt.setName('title').setDescription('Event title').setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('date')
      .setDescription('Event date/time in ISO format (e.g. 2026-08-15T20:00:00Z)')
      .setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt.setName('comp_id').setDescription('Composition ID').setRequired(true).setMinValue(1),
  )
  .addStringOption((opt) =>
    opt.setName('description').setDescription('Optional description').setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.options.getString('title', true);
  const dateStr = interaction.options.getString('date', true);
  const compId = interaction.options.getInteger('comp_id', true);
  const description = interaction.options.getString('description') ?? undefined;

  // Validate date
  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) {
    await interaction.editReply({
      content: '❌ Invalid date format. Use ISO format like `2026-08-15T20:00:00Z`.',
    });
    return;
  }

  const body: CreateEventRequest = {
    title,
    comp_id: compId,
    event_date_utc: parsedDate.toISOString(),
  };
  if (description) body.description = description;

  const event = await api.post<EventView>('api/events', body, interaction.user.id);

  const embed = buildEventEmbed(event);
  const [row1, row2] = buildEventActionRows(event.id);

  await interaction.editReply({
    content: '✅ Event created! Members can now sign up using the buttons below.',
    embeds: [embed],
    components: [row1, row2],
  });
}
