import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventView, CreateEventRequest } from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { getPoller } from "../services/poller.js";

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

/**
 * Creates the event via the API and confirms ephemerally. It deliberately does
 * *not* post its own announcement or open its own thread in `interaction.channel`.
 *
 * That used to happen here, which meant a bot-created event got announced
 * *twice* — once immediately in whatever channel the command happened to be
 * run from, and again ~`POLL_INTERVAL_MS` later by the poller, which treats
 * any event with `id > lastEventId` as new regardless of how it was created.
 * A call-to-arms event added a *third* announcement on top, from the
 * backend's own direct-to-Discord CTA post (`EventService::announce_call_to_arms`,
 * fired by the same `POST /api/events` this command calls) — three messages,
 * up to three different channels, three separate signup threads for the
 * same event.
 *
 * The poller is the only path that also covers events created from the web
 * app, so it stays the single source of truth for the events-channel
 * announcement + signup thread. This command just asks it to run right away
 * (`pollNow`) instead of waiting for the next tick, so the announcement still
 * appears promptly.
 */
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

  const noticeEmbed = createResponseEmbed(
    "success",
    "Guild Event Created",
    `Event **#${event.id}** is now scheduled. It will be announced in the events channel` +
      (callToArms ? " and the call-to-arms channel " : " ") +
      "shortly.",
    "GUILD EVENT",
  );
  await interaction.editReply({ embeds: [noticeEmbed] });

  // Best-effort: ask the poller to announce it now rather than waiting for
  // its next scheduled tick. If the poller isn't registered yet (startup
  // race) or the immediate check fails, the scheduled tick still picks the
  // event up — this is purely a "make it feel instant" nicety, not the only
  // path that announces it.
  try {
    await getPoller()?.pollNow();
  } catch (err) {
    console.warn("[EventCreateCommand] Immediate poll after creation failed:", err);
  }
}
