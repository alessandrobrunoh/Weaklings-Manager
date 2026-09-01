import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { ApiClient } from "../api/client.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { startDiscordEvent } from "../services/event-lifecycle.js";

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

  const result = await startDiscordEvent(
    interaction.client,
    api,
    interaction.user.id,
    eventId,
  );

  const noticeEmbed = createResponseEmbed(
    "success",
    "Event Started",
    `Event **#${eventId}** is now **LIVE** in <#${result.voiceChannelId}>.`,
    "GUILD EVENT",
  );

  await interaction.editReply({
    embeds: [noticeEmbed],
  });
}
