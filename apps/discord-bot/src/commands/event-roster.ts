import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import { buildEventEmbed } from "../embeds/event.embed.js";

export const data = new SlashCommandBuilder()
  .setName("event-roster")
  .setDescription("View the full roster for a guild event")
  .addIntegerOption((opt) =>
    opt
      .setName("event_id")
      .setDescription("Event ID")
      .setRequired(true)
      .setMinValue(1),
  );

/**
 * `buildEventEmbed` already renders the full roster grouped by build (real
 * @mentions, one field per build, with the same field-count/value-length
 * safety guards) — this command used to rebuild an equivalent second embed
 * by hand, with plain usernames instead of mentions and none of those
 * guards. Just showing the one embed keeps both in sync automatically.
 */
export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply(); // Public — everyone can see it

  const eventId = interaction.options.getInteger("event_id", true);
  const event = await api.get<EventDetailView>(
    `api/events/${eventId}`,
    interaction.user.id,
  );

  await interaction.editReply({ embeds: [buildEventEmbed(event)] });
}
