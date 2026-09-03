import { ButtonInteraction } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  EventDetailView,
  EventParticipant,
  EventSignupOptionsView,
  PaginatedData,
  EventView,
  BattleSummary,
} from "../api/types.js";
import {
  buildEventEmbed,
  buildEventReminderMessage,
  buildEventSummaryEmbed,
  buildEventThreadActionRows,
} from "../embeds/event.embed.js";
import { buildBattleListEmbed } from "../embeds/battle.embed.js";
import { createResponseEmbed } from '../embeds/theme.js';
import { config } from "../config.js";
import { formatSilver } from '../format.js';
import { startDiscordEvent, stopDiscordEvent } from "../services/event-lifecycle.js";
import { getPoller } from "../services/poller.js";
import { buildSignupRoleOptions, signupRoles } from "../services/event-signup.js";
import { closeEventAnnouncementThread } from "../services/event-announcement-thread.js";
import { getSettingsService } from "../services/settings.js";
import { buildApplicationWelcomeComponents, buildApplicationWelcomeEmbed } from "../embeds/application.embed.js";
import type { ApplicationView, GuildSettingsView } from "../api/types.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";

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
    } else if (ns === "application") {
      await handleApplicationButton(interaction, api, action);
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

async function handleApplicationButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
): Promise<void> {
  if (action !== 'create') {
    await interaction.reply({
      embeds: [createResponseEmbed('info', 'Coming soon', 'Questa azione sarà disponibile nella prossima fase.', 'APPLICATIONS')],
      flags: ['Ephemeral'],
    });
    return;
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });
  const guild = interaction.guild;
  if (!guild) throw new Error('Applications can only be opened inside a server.');

  const settings: GuildSettingsView = await getSettingsService().applicationsSettings();
  if (!settings.discord_applications_open) {
    await interaction.editReply({
      embeds: [createResponseEmbed('warning', 'Applications closed', 'Le application sono momentaneamente chiuse.', 'APPLICATIONS')],
    });
    return;
  }
  if (!settings.discord_applications_category_id) {
    throw new Error('La categoria delle application non è configurata dal pannello admin.');
  }

  const active = await api.get<ApplicationView | null>(
    'api/applications/active',
    interaction.user.id,
  );
  if (active) {
    await interaction.editReply({
      embeds: [createResponseEmbed('info', 'Application already open', `Hai già un'applicatione aperta: <#${active.channel_id}>.`, 'APPLICATIONS')],
    });
    return;
  }

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || interaction.user.id;
  const channel = await guild.channels.create({
    name: `ticket-${safeName}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: settings.discord_applications_category_id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ...(settings.discord_applications_manage_role_id ? [{ id: settings.discord_applications_manage_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
      ...(interaction.client.user ? [{ id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }] : []),
    ],
    reason: `Application opened by ${interaction.user.tag}`,
  });

  try {
    await api.post<ApplicationView>('api/applications', channel.id, interaction.user.id);
    await channel.send({
      embeds: [buildApplicationWelcomeEmbed(settings)],
      components: buildApplicationWelcomeComponents(),
    });
  } catch (error) {
    await channel.delete('Application persistence failed').catch(() => undefined);
    throw error;
  }

  await interaction.editReply({
    embeds: [createResponseEmbed('success', 'Application created', `La tua application è stata aperta in <#${channel.id}>.`, 'APPLICATIONS')],
  });
}

async function handleEventButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  if (action === "leave") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });

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

    const isParticipant = event.participants?.some(
      (p: EventParticipant) => p.discord_id === interaction.user.id,
    );
    if (!isParticipant) {
      const infoEmbed = createResponseEmbed(
        "info",
        "Not Signed Up",
        `You aren't signed up for event **#${eventId}** — nothing to leave.`,
        "GUILD EVENT",
      );
      await interaction.editReply({ embeds: [infoEmbed] });
      return;
    }

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
  }

  if (action === "join") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });

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
      await interaction.editReply({ embeds: [errEmbed] });
      return;
    }

    const availableRoles = signupRoles(signupOptions.builds);

    const {
      ActionRowBuilder,
      StringSelectMenuBuilder,
      StringSelectMenuOptionBuilder,
    } = await import("discord.js");

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`event:join_role:${eventId}:${interaction.message.id}`)
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

  if (action === "ping") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      throw new Error("Invalid event ID.");
    }
    const channel = interaction.channel;
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error("Event reminders can only be sent from a text channel.");
    }

    const event = await api.post<EventView>(
      `api/events/${eventId}/remind`,
      {},
      interaction.user.id,
    );
    await channel.send(buildEventReminderMessage(event));

    const successEmbed = createResponseEmbed(
      "success",
      "Reminder Sent",
      `The reminder for event **#${eventId}** was posted in this channel.`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [successEmbed] });
    return;
  }

  if (action === "start") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      throw new Error("Invalid event ID.");
    }
    const result = await startDiscordEvent(
      interaction.client,
      api,
      interaction.user.id,
      eventId,
      interaction.channel?.isThread() ? interaction.channel : undefined,
    );
    await interaction.message.edit({
      embeds: [buildEventEmbed(result.event)],
      components: buildEventThreadActionRows(result.event),
    });
    const successEmbed = createResponseEmbed(
      "success",
      "Event Live",
      `Event **#${eventId}** is now **LIVE** in <#${result.voiceChannelId}>.`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [successEmbed] });
    return;
  }

  if (action === "cancel") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);
    await interaction.deferReply({ flags: ["Ephemeral"] });
    if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error("Invalid event ID.");
    let event = await api.post<EventDetailView>(`api/events/${eventId}/cancel`, {}, interaction.user.id);
    // Cancellation may leave a Mass-created voice behind. Remove it only when empty; occupied
    // channels remain available for members to leave safely.
    if (event.discord_voice_channel_id) {
      try {
        const channel = await interaction.client.channels.fetch(event.discord_voice_channel_id);
        if (channel?.isVoiceBased() && channel.members.size === 0) {
          await channel.delete(`Event #${eventId} cancelled and voice channel was empty`);
          event = await api.delete<EventDetailView>(
            `api/events/${eventId}/discord-voice-channel`,
            interaction.user.id,
          ) ?? event;
        }
      } catch (error) {
        console.warn(`[Button] Could not clean up cancelled event #${eventId} voice channel:`, error);
      }
    }
    await interaction.message.edit({
      embeds: [buildEventEmbed(event)],
      components: buildEventThreadActionRows(event),
    });
    const closed = await getPoller()?.closeEventThread(eventId);
    if (!closed && interaction.channel?.isThread()) {
      await closeEventAnnouncementThread(interaction.channel, eventId, "Cancel button");
    }
    const successEmbed = createResponseEmbed(
      "warning",
      "Event Cancelled",
      `Event **#${eventId}** has been cancelled and its discussion thread was closed.`,
      "GUILD EVENT",
    );
    await interaction.editReply({ embeds: [successEmbed] });
    return;
  }

  if (action === "stop") {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ flags: ["Ephemeral"] });
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      throw new Error("Invalid event ID.");
    }
    const result = await stopDiscordEvent(
      interaction.client,
      api,
      interaction.user.id,
      eventId,
    );
    await getPoller()?.closeEventThread(eventId);
    await interaction.message.edit({
      embeds: [buildEventEmbed(result.event)],
      components: buildEventThreadActionRows(result.event),
    });
    const message = result.voiceChannelOccupied
      ? `Event **#${eventId}** stopped. Its voice channel is still occupied, so it was kept.`
      : result.voiceChannelDeleted
        ? `Event **#${eventId}** stopped and its empty voice channel was deleted.`
        : `Event **#${eventId}** has been stopped. ⏹️`;
    const warnEmbed = createResponseEmbed("warning", "Event Stopped", message, "GUILD EVENT");
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
    config.GUILD_NAME,
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

    const total = txs.reduce((sum, tx) => sum + Number(tx.amount), 0);
    const totalFmt = formatSilver(total);

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
