import { ButtonInteraction } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  BuildRole,
  EventDetailView,
  PaginatedData,
  EventView,
  BattleSummary,
  CompDetail,
} from "../api/types.js";
import {
  buildEventEmbed,
  buildEventSummaryEmbed,
} from "../embeds/event.embed.js";
import { buildBattleListEmbed } from "../embeds/battle.embed.js";
import { createResponseEmbed } from "../embeds/theme.js";

const GUILD_NAME = process.env["GUILD_NAME"] ?? "";

const BUILD_ROLE_LABELS: Record<BuildRole, string> = {
  healer: "🛡️ Healer",
  tank: "🪓 Tank",
  dps: "⚔️ DPS",
  support: "✨ Support",
  battle_mount: "🐴 Battle Mount",
  brawler: "🥊 Brawler",
};

/**
 * Handles all button interactions.
 */
export async function handleButton(
  interaction: ButtonInteraction,
  api: ApiClient,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const [ns, action, ...rest] = parts;

  try {
    if (ns === "event") {
      await handleEventButton(interaction, api, action, rest);
    } else if (ns === "events") {
      await handleEventsNav(interaction, api, action, rest);
    } else if (ns === "battles") {
      await handleBattlesNav(interaction, api, action, rest);
    } else if (ns === "bank") {
      await handleBankButton(interaction, api, action, rest);
    } else {
      const embed = createResponseEmbed(
        "warning",
        "Unknown Action",
        "Unknown button action.",
        "BUTTON SYSTEM",
      );
      await interaction.reply({ embeds: [embed], flags: ["Ephemeral"] });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred.";
    const errEmbed = createResponseEmbed(
      "error",
      "Button Action Failed",
      message,
      "BUTTON SYSTEM",
    );
    const reply = { embeds: [errEmbed], flags: ["Ephemeral"] as any };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

async function handleEventButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  if (action === "manage") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });

    // Fetch the event to get participants and active comp
    let event;
    try {
      event = await api.get<EventDetailView>(
        `api/events/${eventId}`,
        interaction.user.id,
      );
    } catch (err) {
      const errEmbed = createResponseEmbed(
        "error",
        "Fetch Error",
        "Failed to fetch event details.",
        "GUILD EVENT",
      );
      await interaction.editReply({ embeds: [errEmbed] });
      return;
    }

    // Check if user is already a participant
    const isParticipant = event.participants?.some(
      (p: any) => p.discord_id === interaction.user.id,
    );

    if (isParticipant) {
      // User is already signed up -> Leave
      try {
        await api.delete(
          `api/events/${eventId}/participate`,
          interaction.user.id,
        );
        const updatedEvent = await api.get<EventDetailView>(
          `api/events/${eventId}`,
          interaction.user.id,
        );
        const embed = buildEventEmbed(updatedEvent);
        await interaction.message.edit({ embeds: [embed] });

        const successEmbed = createResponseEmbed(
          "success",
          "Left Event",
          `You have successfully left event **#${eventId}**.`,
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [successEmbed] });
      } catch (e) {
        console.error("Failed to leave event", e);
        const errEmbed = createResponseEmbed(
          "error",
          "Leave Failed",
          "Failed to leave the event.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed] });
      }
      return;
    } else {
      // User is not signed up -> Join (show roles)
      if (!event.active_comp_id) {
        const errEmbed = createResponseEmbed(
          "error",
          "No Active Comp",
          "This event has no active composition assigned.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed] });
        return;
      }

      let comp;
      try {
        comp = await api.get<CompDetail>(
          `api/comps/${event.active_comp_id}`,
          interaction.user.id,
        );
      } catch (err) {
        const errEmbed = createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch composition details.",
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [errEmbed] });
        return;
      }

      // Find all unique roles required by the composition
      const availableRoles = [
        ...new Set<string>(comp.builds.map((b: any) => b.build.role)),
      ] as BuildRole[];

      if (availableRoles.length === 0) {
        const warnEmbed = createResponseEmbed(
          "warning",
          "No Roles Available",
          `The active comp (**${comp.name}**) does not require any builds.`,
          "GUILD EVENT",
        );
        await interaction.editReply({ embeds: [warnEmbed] });
        return;
      }

      const {
        ActionRowBuilder,
        StringSelectMenuBuilder,
        StringSelectMenuOptionBuilder,
      } = await import("discord.js");

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`event:join_role:${eventId}:${interaction.message.id}`)
        .setPlaceholder("Select your Role")
        .addOptions(
          availableRoles.map((role) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(BUILD_ROLE_LABELS[role] ?? role)
              .setValue(role),
          ),
        );

      const row = new ActionRowBuilder<
        InstanceType<typeof StringSelectMenuBuilder>
      >().addComponents(selectMenu);

      const infoEmbed = createResponseEmbed(
        "info",
        "Select Role",
        `🎯 Choose your role for event **#${eventId}**:`,
        "GUILD EVENT",
      );

      await interaction.editReply({
        embeds: [infoEmbed],
        components: [row],
      });
      return;
    }
  }

  if (action === "start") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });
    const event = await api.post<EventDetailView>(
      `api/events/${eventId}/start`,
      {},
      interaction.user.id,
    );
    const embed = buildEventEmbed(event);
    await interaction.message.edit({ embeds: [embed] });
    const successEmbed = createResponseEmbed(
      "success",
      "Event Live",
      `Event **#${eventId}** is now **LIVE**! 🟢`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [successEmbed] });
    return;
  }

  if (action === "stop") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });
    const event = await api.post<EventDetailView>(
      `api/events/${eventId}/stop`,
      {},
      interaction.user.id,
    );
    const embed = buildEventEmbed(event);
    await interaction.message.edit({ embeds: [embed] });
    const warnEmbed = createResponseEmbed(
      "warning",
      "Event Stopped",
      `Event **#${eventId}** has been stopped. ⏹️`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [warnEmbed] });
    return;
  }

  const errEmbed = createResponseEmbed(
    "warning",
    "Unknown Event Action",
    "Unknown event button action.",
    "GUILD EVENT",
  );
  await interaction.reply({ embeds: [errEmbed], flags: ["Ephemeral"] });
}

async function handleEventsNav(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  const currentPage = Number(rest[0]) ?? 1;
  const newPage =
    action === "next" ? currentPage + 1 : Math.max(1, currentPage - 1);

  await interaction.deferUpdate();

  const result = await api.get<PaginatedData<EventView>>(
    "api/events",
    interaction.user.id,
    { page: newPage, limit: 10 },
  );

  const embed = buildEventSummaryEmbed(
    result.items,
    result.current_page,
    result.total_pages,
  );

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
    await import("discord.js");
  const navRow = new ActionRowBuilder<
    InstanceType<typeof ButtonBuilder>
  >().addComponents(
    new ButtonBuilder()
      .setCustomId(`events:prev:${newPage}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage <= 1),
    new ButtonBuilder()
      .setCustomId(`events:next:${newPage}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage >= result.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}

async function handleBattlesNav(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  const currentPage = Number(rest[0]) ?? 1;
  const newPage =
    action === "next" ? currentPage + 1 : Math.max(1, currentPage - 1);

  await interaction.deferUpdate();

  const result = await api.get<PaginatedData<BattleSummary>>(
    "api/battles",
    interaction.user.id,
    { page: newPage, limit: 10 },
  );

  const embed = buildBattleListEmbed(
    result.items,
    GUILD_NAME,
    result.current_page,
    result.total_pages,
  );

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
    await import("discord.js");
  const navRow = new ActionRowBuilder<
    InstanceType<typeof ButtonBuilder>
  >().addComponents(
    new ButtonBuilder()
      .setCustomId(`battles:prev:${newPage}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage <= 1),
    new ButtonBuilder()
      .setCustomId(`battles:next:${newPage}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage >= result.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}

async function handleBankButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  if (action === "request_all") {
    await interaction.deferReply({ flags: ["Ephemeral"] });

    try {
      const components = interaction.message.components;
      if (components && components.length > 0) {
        await interaction.message.edit({ components: [] });
      }
    } catch (e) {}

    const txs = await api.post<any[]>(
      "api/bank/transactions/withdraw",
      { all: true },
      interaction.user.id,
    );

    const total = txs.reduce((sum, tx) => sum + tx.amount, 0);
    const totalFmt = total.toLocaleString("en-US");

    const desc = [
      `• 💰 **Total Amount:** **${totalFmt} silver**`,
      `• 📄 **Transactions:** **${txs.length}** item(s)`,
      `• ⏳ **Status:** Withdrawal submitted to Officers`,
    ].join("\n");

    const embed = createResponseEmbed(
      "success",
      "Withdrawal Requested",
      desc,
      "GUILD BANK",
    );

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (action === "accept") {
    const [txIdStr] = rest;
    const txId = Number(txIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });

    try {
      await api.post<any>(
        "api/bank/transactions/withdraw/accept",
        { transaction_ids: [txId] },
        interaction.user.id,
      );

      try {
        await interaction.message.edit({ components: [] });
      } catch (e) {}

      const successEmbed = createResponseEmbed(
        "success",
        "Withdrawal Approved",
        `Withdrawal request **#${txId}** has been accepted and marked as paid.`,
        "GUILD BANK",
      );

      await interaction.editReply({ embeds: [successEmbed] });
    } catch (err: any) {
      const errEmbed = createResponseEmbed(
        "error",
        "Approval Failed",
        err.message || "Failed to accept withdrawal request.",
        "GUILD BANK",
      );
      await interaction.editReply({ embeds: [errEmbed] });
    }
    return;
  }

  if (action === "reject") {
    const [txIdStr] = rest;
    const txId = Number(txIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });

    try {
      await api.post<any>(
        "api/bank/transactions/withdraw/reject",
        { transaction_ids: [txId] },
        interaction.user.id,
      );

      try {
        await interaction.message.edit({ components: [] });
      } catch (e) {}

      const rejectEmbed = createResponseEmbed(
        "error",
        "Withdrawal Rejected",
        `Withdrawal request **#${txId}** has been rejected.`,
        "GUILD BANK",
      );

      await interaction.editReply({ embeds: [rejectEmbed] });
    } catch (err: any) {
      const errEmbed = createResponseEmbed(
        "error",
        "Rejection Failed",
        err.message || "Failed to reject withdrawal request.",
        "GUILD BANK",
      );
      await interaction.editReply({ embeds: [errEmbed] });
    }
    return;
  }

  const errEmbed = createResponseEmbed(
    "warning",
    "Unknown Bank Action",
    "Unknown bank action.",
    "GUILD BANK",
  );
  await interaction.reply({ embeds: [errEmbed], flags: ["Ephemeral"] });
}
