import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import {
  buildEventEmbed,
  buildEventManageActionRow,
} from "../embeds/event.embed.js";
import { createResponseEmbed } from "../embeds/theme.js";
import {
  buildGuildSelectRow,
  JOIN_GUILD_PENDING_FLASH,
  resolveJoinGuilds,
} from "../services/event-join-guild.js";
import { eventJoinCopy } from "../services/event-join-copy.js";

export const data = new SlashCommandBuilder()
  .setName("event-join")
  .setDescription("🙋 Sign up for a guild event by role")
  .addIntegerOption((opt) =>
    opt
      .setName("event_id")
      .setDescription("Event ID (from /events)")
      .setRequired(true)
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ["Ephemeral"] });

  const eventId = interaction.options.getInteger("event_id", true);

  // Fetch event to confirm it exists and show details
  let event: EventDetailView;
  try {
    event = await api.get<EventDetailView>(
      `api/events/${eventId}`,
      interaction.user.id,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Event not found.";
    const errEmbed = createResponseEmbed(
      "error",
      "Event Not Found",
      msg,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  if (event.status !== "scheduled") {
    const errEmbed = createResponseEmbed(
      "error",
      "Cannot Join Event",
      `You can only join events with status \`scheduled\`. This event is currently \`${event.status}\`.`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const embed = buildEventEmbed(event);
  // Resolve guild attribution: guild tenants keep the plain Join flow,
  // alliance tenants need zero/one/many handling before the buttons are shown.
  let guildResolution;
  try {
    guildResolution = await resolveJoinGuilds(
      api,
      interaction.guildId!,
      eventId,
      interaction.user.id,
    );
  } catch (err) {
    console.error("Failed to resolve join guild attribution for /event-join", err);
    const errEmbed = createResponseEmbed(
      "error",
      eventJoinCopy(interaction.locale, "guildsFetchFailedTitle"),
      eventJoinCopy(interaction.locale, "guildsFetchFailed"),
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }
  if (guildResolution.kind === "none") {
    const warnEmbed = createResponseEmbed(
      "warning",
      eventJoinCopy(interaction.locale, "noGuildTitle"),
      eventJoinCopy(interaction.locale, "noGuildBody"),
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [warnEmbed] });
    return;
  }
  if (guildResolution.kind === "choice") {
    // Ask for the guild first; the role/build chain then submits once.
    const row = buildGuildSelectRow(
      guildResolution.guilds,
      eventId,
      null,
      event.event_kind === "flash" ? JOIN_GUILD_PENDING_FLASH : "",
      interaction.locale,
    );
    const infoEmbed = createResponseEmbed(
      "info",
      eventJoinCopy(interaction.locale, "chooseGuildTitle"),
      eventJoinCopy(interaction.locale, "chooseGuildBody", { id: eventId }),
      "GUILD EVENT",
    );
    await interaction.editReply({
      embeds: [infoEmbed, embed],
      components: [row],
    });
    return;
  }

  const row = buildEventManageActionRow(eventId);

  const infoEmbed = createResponseEmbed(
    "info",
    "Event Registration",
    "🎯 Select your build role below to sign up for this event:",
    "GUILD EVENT",
  );

  await interaction.editReply({
    embeds: [infoEmbed, embed],
    components: [row],
  });
}
