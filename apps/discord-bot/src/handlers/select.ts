import { StringSelectMenuInteraction } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { EventSignupOptionsView } from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { getPoller } from "../services/poller.js";
import {
  buildSignupRoleOptions,
  buildsForSignupRole,
  FILL_SIGNUP_VALUE,
  selectableSignupBuilds,
  signupRoles,
  type SignupRoleValue,
} from "../services/event-signup.js";
import {
  buildBuildSelectCustomId,
  buildRoleSelectCustomId,
  JOIN_GUILD_PENDING_FLASH,
  participatePath,
} from "../services/event-join-guild.js";
import { flashCopy } from "../services/flash-copy.js";

export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  api: ApiClient,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const [ns, action, ...rest] = parts;

  try {
    if (ns === "event" && action === "join_guild") {
      const eventId = Number(rest[0]);
      const messageId = rest[1] ?? "";
      const pending = rest[2] ?? "";
      const guildTenantId = interaction.values[0];

      await interaction.deferUpdate();

      // A flash-mass signup deferred its only submission until the guild was
      // known; finish it here so the join is sent exactly once.
      if (pending === JOIN_GUILD_PENDING_FLASH) {
        try {
          const updated = await api.post<any>(
            participatePath(eventId, guildTenantId),
            { primary_build_id: null, secondary_build_id: null },
            interaction.user.id,
          );
          await getPoller(api.guildId)?.addMemberToEventThread(
            eventId,
            interaction.user.id,
          );
          if (messageId && interaction.channel) {
            try {
              const { buildEventEmbed } = await import("../embeds/event.embed.js");
              const originalMsg = await interaction.channel.messages.fetch(messageId);
              if (originalMsg) {
                await originalMsg.edit({
                  embeds: [buildEventEmbed(updated, interaction.guild?.preferredLocale)],
                });
              }
            } catch (error) {
              console.error("Failed to update original message on flash guild join", error);
            }
          }
          const massTime = updated.mass_time_utc ?? updated.event_date_utc;
          const massTs = Math.floor(new Date(massTime).getTime() / 1000);
          const successEmbed = createResponseEmbed(
            "success",
            flashCopy(interaction.locale, "joinedTitle"),
            flashCopy(interaction.locale, "joinedBody", { id: eventId, massTs }),
            "FLASH MASS",
          );
          await interaction.editReply({ embeds: [successEmbed], components: [] });
        } catch (e) {
          console.error("Failed to join flash mass after guild choice", e);
          const errEmbed = createResponseEmbed(
            "error",
            flashCopy(interaction.locale, "joinFailedTitle"),
            flashCopy(interaction.locale, "joinFailed"),
            "FLASH MASS",
          );
          await interaction.editReply({ embeds: [errEmbed], components: [] });
        }
        return;
      }

      // A concrete build id was chosen before the guild: one submission now.
      const pendingBuildId = Number(pending);
      if (pending && Number.isSafeInteger(pendingBuildId) && pendingBuildId > 0) {
        try {
          await api.post(
            participatePath(eventId, guildTenantId),
            { primary_build_id: pendingBuildId },
            interaction.user.id,
          );
          await getPoller(api.guildId)?.addMemberToEventThread(
            eventId,
            interaction.user.id,
          );
          if (messageId && interaction.channel) {
            try {
              const { buildEventEmbed } = await import("../embeds/event.embed.js");
              const updatedEvent = await api.get<any>(
                `api/events/${eventId}`,
                interaction.user.id,
              );
              const originalMsg = await interaction.channel.messages.fetch(messageId);
              if (originalMsg) {
                await originalMsg.edit({ embeds: [buildEventEmbed(updatedEvent)] });
              }
            } catch (error) {
              console.error("Failed to update original message on guild join", error);
            }
          }
          const successEmbed = createResponseEmbed(
            "success",
            "Signed Up For Event",
            `You have successfully signed up for event **#${eventId}** with build ID **${pendingBuildId}**.`,
            "GUILD EVENT",
          );
          await interaction.editReply({ embeds: [successEmbed], components: [] });
        } catch (e) {
          console.error("Failed to join event after guild choice", e);
          const errEmbed = createResponseEmbed(
            "error",
            "Join Failed",
            "Failed to join the event.",
            "GUILD EVENT",
          );
          await interaction.editReply({ embeds: [errEmbed], components: [] });
        }
        return;
      }

      // Interactive role flow: the chosen guild rides the custom id so the
      // role/build steps end in a single participate submission.
      let signupOptions;
      try {
        signupOptions = await api.get<EventSignupOptionsView>(
          `api/events/${eventId}/signup-options`,
          interaction.user.id,
        );
      } catch (err) {
        const errEmbed = createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event signup options.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed], components: [] });
        return;
      }

      const availableRoles = signupRoles(selectableSignupBuilds(signupOptions.builds));

      const {
        ActionRowBuilder,
        StringSelectMenuBuilder,
        StringSelectMenuOptionBuilder,
      } = await import("discord.js");

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(buildRoleSelectCustomId(eventId, messageId, guildTenantId))
        .setPlaceholder("Select your Role")
        .addOptions(
          buildSignupRoleOptions(availableRoles).map((option) => {
            const menuOption = new StringSelectMenuOptionBuilder()
              .setLabel(option.label)
              .setValue(option.value);
            if (option.description) {
              menuOption.setDescription(option.description);
            }
            return menuOption;
          }),
        );

      const row = new ActionRowBuilder<
        InstanceType<typeof StringSelectMenuBuilder>
      >().addComponents(selectMenu);

      const infoEmbed = createResponseEmbed(
        "info",
        "Select Role",
        signupOptions.is_already_registered
          ? `🎯 You're already signed up — pick a role to change your build for event **#${eventId}**:`
          : `🎯 Choose your role for event **#${eventId}**:`,
        "GUILD EVENT",
      );

      await interaction.editReply({
        embeds: [infoEmbed],
        components: [row],
      });
      return;
    }

    if (ns === "event" && action === "join_role") {
      const eventId = Number(rest[0]);
      const messageId = rest[1];
      const guildTenantId = rest[2] || null;
      const role = interaction.values[0] as SignupRoleValue;

      await interaction.deferUpdate();

      if (role === FILL_SIGNUP_VALUE) {
        await api.post(
          participatePath(eventId, guildTenantId),
          { primary_build_id: null },
          interaction.user.id,
        );
        // Calendar delivery keeps the discussion in a private thread; the new
        // member has to be invited to it. No-op for public threads, never fatal.
        await getPoller(api.guildId)?.addMemberToEventThread(
          eventId,
          interaction.user.id,
        );

        if (messageId && interaction.channel) {
          try {
            const { buildEventEmbed } = await import("../embeds/event.embed.js");
            const updatedEvent = await api.get<any>(
              `api/events/${eventId}`,
              interaction.user.id,
            );
            const originalMsg = await interaction.channel.messages.fetch(messageId);
            if (originalMsg) {
              await originalMsg.edit({ embeds: [buildEventEmbed(updatedEvent)] });
            }
          } catch (error) {
            console.error("Failed to update original message on Fill signup", error);
          }
        }

        const successEmbed = createResponseEmbed(
          "success",
          "Signed Up For Event",
          `You have successfully signed up for event **#${eventId}** as **Fill**.`,
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [successEmbed], components: [] });
        return;
      }

      let signupOptions;
      try {
        signupOptions = await api.get<EventSignupOptionsView>(
          `api/events/${eventId}/signup-options`,
          interaction.user.id,
        );
      } catch (err) {
        const errEmbed = createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event signup options.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed], components: [] });
        return;
      }

      const availableBuilds = buildsForSignupRole(selectableSignupBuilds(signupOptions.builds), role);

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
        .setCustomId(buildBuildSelectCustomId(eventId, messageId, guildTenantId))
        .setPlaceholder("Select your specific build")
        .addOptions(
          availableBuilds.map((build) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(build.name)
              .setDescription(`Requested count: ${build.quantity}`)
              .setValue(String(build.build_id)),
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
      const guildTenantId = rest[2] || null;
      const buildId = Number(interaction.values[0]);

      await interaction.deferUpdate();

      await api.post(
        participatePath(eventId, guildTenantId),
        { primary_build_id: buildId },
        interaction.user.id,
      );
      // Calendar delivery keeps the discussion in a private thread; the new
      // member has to be invited to it. No-op for public threads, never fatal.
      await getPoller(api.guildId)?.addMemberToEventThread(
        eventId,
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
