import { StringSelectMenuInteraction } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { BuildRole } from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";

export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  api: ApiClient,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const [ns, action, ...rest] = parts;

  try {
    if (ns === "event" && action === "join_role") {
      const eventId = Number(rest[0]);
      const messageId = rest[1];
      const role = interaction.values[0] as BuildRole;

      await interaction.deferUpdate();

      // Fetch event and comp to get builds for this role
      let event, comp;
      try {
        event = await api.get<any>(
          `api/events/${eventId}`,
          interaction.user.id,
        );
        comp = await api.get<any>(
          `api/comps/${event.active_comp_id}`,
          interaction.user.id,
        );
      } catch (err) {
        const errEmbed = createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event or comp details.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed], components: [] });
        return;
      }

      const availableBuilds = comp.builds.filter(
        (b: any) => b.build.role === role,
      );

      if (availableBuilds.length === 0) {
        const warnEmbed = createResponseEmbed(
          "warning",
          "Role Not Required",
          `The active comp does not require any **${role}** builds.`,
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [warnEmbed], components: [] });
        return;
      }

      const {
        ActionRowBuilder,
        StringSelectMenuBuilder,
        StringSelectMenuOptionBuilder,
      } = await import("discord.js");

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`event:join_build:${eventId}:${messageId}`)
        .setPlaceholder("Select your specific build")
        .addOptions(
          availableBuilds.map((b: any) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(b.build.name)
              .setDescription(`Requested count: ${b.quantity}`)
              .setValue(String(b.build_id)),
          ),
        );

      const row = new ActionRowBuilder<
        InstanceType<typeof StringSelectMenuBuilder>
      >().addComponents(selectMenu);

      const infoEmbed = createResponseEmbed(
        "info",
        "Select Specific Build",
        `🎯 Choose your specific **${role}** build for event **#${eventId}**:`,
        "GUILD EVENT",
      );

      await interaction.editReply({
        embeds: [infoEmbed],
        components: [row],
      });
      return;
    }

    if (ns === "event" && action === "join_build") {
      const eventId = Number(rest[0]);
      const messageId = rest[1];
      const buildId = Number(interaction.values[0]);

      await interaction.deferUpdate();

      await api.post(
        `api/events/${eventId}/participate`,
        { primary_build_id: buildId },
        interaction.user.id,
      );

      if (messageId && interaction.channel) {
        try {
          const { buildEventEmbed } = await import("../embeds/event.embed.js");
          const updatedEvent = await api.get<any>(
            `api/events/${eventId}`,
            interaction.user.id,
          );
          const embed = buildEventEmbed(updatedEvent);
          const originalMsg =
            await interaction.channel.messages.fetch(messageId);
          if (originalMsg) {
            await originalMsg.edit({ embeds: [embed] });
          }
        } catch (e) {
          console.error("Failed to update original message on join", e);
        }
      }

      const successEmbed = createResponseEmbed(
        "success",
        "Signed Up For Event",
        `You have successfully signed up for event **#${eventId}** with build ID **${buildId}**.`,
        "GUILD EVENT",
      );

      await interaction.editReply({
        embeds: [successEmbed],
        components: [],
      });
      return;
    }

    const warnEmbed = createResponseEmbed(
      "warning",
      "Unknown Select Menu",
      "Unknown select menu action.",
      "SELECT HANDLER",
    );
    await interaction.reply({ embeds: [warnEmbed], flags: ["Ephemeral"] });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred.";
    const errEmbed = createResponseEmbed(
      "error",
      "Selection Failed",
      message,
      "GUILD EVENT",
    );

    await interaction
      .editReply({ embeds: [errEmbed], components: [] })
      .catch(() =>
        interaction.followUp({ embeds: [errEmbed], flags: ["Ephemeral"] }),
      );
  }
}
