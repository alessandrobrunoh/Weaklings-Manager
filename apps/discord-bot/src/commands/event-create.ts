import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventView, CreateEventRequest } from "../api/types.js";
import { config, getEventRoleId } from "../config.js";
import { buildEventAnnouncementContent } from "../embeds/event.embed.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { createEventAnnouncementThread } from "../services/event-announcement-thread.js";

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

  const eventRoleId = getEventRoleId(config);
  const announcementMessage = await channel.send({
    content: buildEventAnnouncementContent(event, eventRoleId),
    allowedMentions: eventRoleId ? { roles: [eventRoleId] } : { parse: [] },
  });
  const wasThreadCreated = await createEventAnnouncementThread(
    announcementMessage,
    event,
    "EventCreateCommand",
  );

  if (!wasThreadCreated) {
    const warningEmbed = createResponseEmbed(
      "warning",
      "Guild Event Created",
      `Event **#${event.id}** was scheduled and announced, but Discord rejected the thread creation. Check bot permissions in this channel: \`Create Public Threads\` and \`Send Messages in Threads\`.`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [warningEmbed] });
  }
}
