import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { getPoller } from "../services/poller.js";

export const data = new SlashCommandBuilder()
  .setName("event-calendar-refresh")
  .setDescription("Refresh the Content Pings and Call to Arms calendars");

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ["Ephemeral"] });

  const poller = getPoller(api.guildId);
  if (!poller) {
    const embed = createResponseEmbed(
      "warning",
      "Event Calendar Unavailable",
      "The event publisher is not running for this server yet. Try again in a minute.",
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const result = await poller.refreshEventCalendars(interaction.user.id);
  let title = "Content Pings Refreshed";
  let message: string;
  let kind: "success" | "warning" = "success";

  if (result.configuredChannels === 0) {
    title = "Event Channels Not Configured";
    message =
      `No events or Call to Arms channel is configured. ` +
      `${result.unroutedEvents} standard and ${result.unroutedCallToArms} Call to Arms events could not be routed. ` +
      "Set the channels in the website's Discord integration settings, then try again.";
    kind = "warning";
  } else if (result.updatedChannels.length === 0) {
    title = "Calendar Refresh Failed";
    message =
      `None of the ${result.configuredChannels} configured calendar channels could be updated. ` +
      result.failedChannels
        .map((failure) => `${failure.channelId}: ${failure.reason}`)
        .join("; ");
    kind = "warning";
  } else if (
    result.failedChannels.length > 0 ||
    result.unroutedEvents > 0 ||
    result.unroutedCallToArms > 0
  ) {
    title = "Calendar Partially Refreshed";
    message =
      `Updated ${result.updatedChannels.length} of ${result.configuredChannels} calendar channels with ` +
      `${result.eventCount} live or upcoming events.`;
    if (result.failedChannels.length > 0) {
      message += ` Failed channels: ${result.failedChannels
        .map((failure) => `${failure.channelId}: ${failure.reason}`)
        .join("; ")}.`;
    }
    if (result.unroutedEvents > 0) {
      message += ` ${result.unroutedEvents} standard event(s) have no events channel configured.`;
    }
    if (result.unroutedCallToArms > 0) {
      message += ` ${result.unroutedCallToArms} Call to Arms event(s) have no CTA channel configured.`;
    }
    kind = "warning";
  } else {
    message =
      `Updated ${result.updatedChannels.length} calendar channel${result.updatedChannels.length === 1 ? "" : "s"} ` +
      `with ${result.eventCount} live or upcoming events.`;
  }

  const embed = createResponseEmbed(kind, title, message, "GUILD EVENT");
  await interaction.editReply({ embeds: [embed] });
}
