import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventDetailView } from "../api/types.js";
import { getSettingsService } from "../services/settings.js";
import { createResponseEmbed } from "../embeds/theme.js";

export const data = new SlashCommandBuilder()
  .setName("event-start")
  .setDescription("▶️ Start a scheduled event (Officer+ only)")
  .addIntegerOption((opt) =>
    opt
      .setName("event_id")
      .setDescription("Event ID")
      .setRequired(true)
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ["Ephemeral"] });

  const eventId = interaction.options.getInteger("event_id", true);

  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/start`,
    {},
    interaction.user.id,
  );

  const settings = getSettingsService();
  const eventRoleId = await settings.eventRoleId();
  const eventsChannelId = await settings.eventsChannelId();
  if (eventRoleId && eventsChannelId) {
    try {
      const channel = await interaction.client.channels.fetch(eventsChannelId);

      if (channel?.isTextBased() && !channel.isDMBased() && "send" in channel) {
        await channel.send({
          content: `🚨 <@&${eventRoleId}> The event **${event.title}** is now **LIVE** 🟢!`,
          allowedMentions: { roles: [eventRoleId] },
        });
      }
    } catch (err) {
      console.error("Failed to ping event role on event start", err);
    }
  }

  const noticeEmbed = createResponseEmbed(
    "success",
    "Event Started",
    `Event **#${eventId}** is now **LIVE**! 🟢`,
    "GUILD EVENT",
  );

  await interaction.editReply({
    embeds: [noticeEmbed],
  });
}
