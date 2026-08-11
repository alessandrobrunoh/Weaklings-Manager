import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventView, CreateEventRequest } from "../api/types.js";
import {
  buildEventEmbed,
  buildEventManageActionRow,
} from "../embeds/event.embed.js";
import { createResponseEmbed } from "../embeds/theme.js";

export const data = new SlashCommandBuilder()
  .setName("event-create")
  .setDescription("🗓️ Create a new guild event (Officer+ only)")
  .addStringOption((opt) =>
    opt.setName("title").setDescription("Event title").setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("date")
      .setDescription(
        "Event date/time in ISO format (e.g. 2026-08-15T20:00:00Z)",
      )
      .setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("comp_id")
      .setDescription("Composition ID")
      .setRequired(true)
      .setMinValue(1),
  )
  .addStringOption((opt) =>
    opt
      .setName("description")
      .setDescription("Optional description")
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("call_to_arms")
      .setDescription("Urgent call to arms — posted to the CTA channel")
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ["Ephemeral"] });

  const title = interaction.options.getString("title", true);
  const dateStr = interaction.options.getString("date", true);
  const compId = interaction.options.getInteger("comp_id", true);
  const description = interaction.options.getString("description") ?? undefined;
  const callToArms = interaction.options.getBoolean("call_to_arms") ?? false;

  // Validate date
  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) {
    const errEmbed = createResponseEmbed(
      "error",
      "Invalid Date Format",
      "Use ISO format like `2026-08-15T20:00:00Z`.",
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const body: CreateEventRequest = {
    title,
    comp_id: compId,
    event_date_utc: parsedDate.toISOString(),
  };
  if (description) body.description = description;
  if (callToArms) body.call_to_arms = true;

  const event = await api.post<EventView>(
    "api/events",
    body,
    interaction.user.id,
  );

  // Acknowledge the command ephemerally
  const noticeEmbed = createResponseEmbed(
    "success",
    "Guild Event Created",
    `Event **#${event.id}** is now scheduled.`,
    "GUILD EVENT",
  );
  await interaction.editReply({ embeds: [noticeEmbed] });

  // Ensure we are in a text channel that supports outbound messages.
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) return;

  // Send public empty message (no buttons)
  const ts = Math.floor(new Date(event.event_date_utc).getTime() / 1000);
  const publicMsg = await channel.send({
    content: `🔔 **Nuovo Evento Gilda: ${event.title}**\n<t:${ts}:F>`,
  });

  // Create a thread
  const thread = await publicMsg.startThread({
    name: `Event #${event.id} - ${event.title}`,
    autoArchiveDuration: 1440, // 24 hours
  });

  // Send the actual COMP inside the thread with the manage button
  const embed = buildEventEmbed(event);
  const row = buildEventManageActionRow(event.id);

  await thread.send({
    embeds: [embed],
    components: [row],
  });
}
