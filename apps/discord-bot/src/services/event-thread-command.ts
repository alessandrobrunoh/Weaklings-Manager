import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type ThreadChannel,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  EventDetailView,
  EventParticipant,
  EventSignupBuildOption,
  EventSignupOptionsView,
  EventView,
} from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";
import { buildEventReminderMessage } from "../embeds/event.embed.js";
import { ensureEventManagementAllowed } from "./event-authority.js";
import { startDiscordEvent, stopDiscordEvent, voiceChannelOccupantCount } from "./event-lifecycle.js";
import { getPoller, type Poller } from "./poller.js";
import { buildSignupRoleOptions, signupRoles } from "./event-signup.js";
import {
  buildGuildSelectRow,
  buildRoleSelectCustomId,
  JOIN_GUILD_PENDING_FLASH,
  participatePath,
  resolveJoinGuilds,
  type JoinGuildResolution,
} from "./event-join-guild.js";
import { eventJoinCopy } from "./event-join-copy.js";
import { eventThreadCopy } from "./event-thread-copy.js";
import { flashCopy } from "./flash-copy.js";
import {
  closeEventAnnouncementThread,
} from "./event-announcement-thread.js";
import { unlockAndUnarchiveThread } from "./discord-thread.js";

export type EventThreadAction =
  | "join"
  | "leave"
  | "ping"
  | "start"
  | "stop"
  | "reopen"
  | "cancel";

/** The part of a channel the thread lookup needs — threads and forum posts both satisfy it. */
export interface ThreadLikeChannel {
  id: string;
  isThread(): boolean;
}

/**
 * Resolves the event a command invocation targets: the discussion thread (or
 * forum post) it was typed in, via the poller's persisted thread mapping.
 * Returns null outside event threads, in unknown threads, and when this guild
 * has no poller yet.
 */
export function resolveEventFromThread(
  channel: ThreadLikeChannel | null | undefined,
  poller: Poller | null,
): number | null {
  if (!poller || !channel?.isThread()) return null;
  return poller.findEventIdForThread(channel.id);
}

export type SignupBuildMatch =
  | { kind: "unique"; build: EventSignupBuildOption }
  | { kind: "ambiguous"; matches: EventSignupBuildOption[] }
  | { kind: "none" };

/**
 * Matches a free-text `build` command argument against the server-authoritative
 * signup build list. Exact (case-insensitive) names win; otherwise unique
 * substring matches are accepted so partial names still work.
 */
export function resolveSignupBuildByName(
  builds: readonly EventSignupBuildOption[],
  query: string,
): SignupBuildMatch {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { kind: "none" };
  const exact = builds.filter((build) => build.name.toLowerCase() === normalized);
  if (exact.length === 1) return { kind: "unique", build: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };
  const partial = builds.filter((build) =>
    build.name.toLowerCase().includes(normalized),
  );
  if (partial.length === 1) return { kind: "unique", build: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", matches: partial };
  return { kind: "none" };
}

function listBuildNames(builds: readonly EventSignupBuildOption[]): string {
  return builds.map((build) => `**${build.name}**`).join(", ") || "*none*";
}

async function refreshThreadCards(api: ApiClient, eventId: number, sourceLabel: string): Promise<void> {
  await getPoller(api.guildId)
    ?.pollNow()
    .catch((error) => {
      console.warn(`[${sourceLabel}] Could not refresh event #${eventId} thread after ${sourceLabel}:`, error);
    });
}

/**
 * Runs one button-equivalent event action from a slash command typed inside the
 * event's discussion thread. Permission gates, API calls, and responses mirror
 * the button handlers in `handlers/button.ts`; signup-card edits are left to
 * the poller refresh instead of a clicked message.
 */
export async function executeEventThreadAction(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  action: EventThreadAction,
): Promise<void> {
  await interaction.deferReply({ flags: ["Ephemeral"] });

  const poller = getPoller(api.guildId);
  const eventId = resolveEventFromThread(interaction.channel, poller);
  if (!eventId) {
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "warning",
          eventThreadCopy(interaction.locale, "wrongLocationTitle"),
          eventThreadCopy(interaction.locale, "wrongLocationBody"),
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  const thread = interaction.channel as ThreadChannel;

  if (action === "join") {
    await joinEvent(interaction, api, poller, eventId);
    return;
  }
  if (action === "leave") {
    await leaveEvent(interaction, api, eventId);
    return;
  }

  // Officer actions share the button path's fail-closed authority check.
  if (!(await ensureEventManagementAllowed(interaction, api, eventId))) {
    return;
  }

  if (action === "ping") {
    // The command already had to run inside the event thread, so that thread is
    // the reminder target (the button path uses resolveEventReminderThread for
    // the parent-channel starter-message case, which cannot happen here).
    const event = await api.post<EventView>(
      `api/events/${eventId}/remind`,
      {},
      interaction.user.id,
    );
    await thread.send(
      buildEventReminderMessage(event, interaction.guild?.preferredLocale),
    );
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "success",
          "Reminder Sent",
          `The reminder for event **#${eventId}** was posted in this thread.`,
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  if (action === "start") {
    const result = await startDiscordEvent(
      interaction.client,
      api,
      interaction.user.id,
      eventId,
      thread,
    );
    await refreshThreadCards(api, eventId, "Start command");
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "success",
          "Event Live",
          `Event **#${eventId}** is now **LIVE** in <#${result.voiceChannelId}>.`,
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  if (action === "stop") {
    const result = await stopDiscordEvent(
      interaction.client,
      api,
      interaction.user.id,
      eventId,
    );
    await poller?.finalizeStoppedEventThread(eventId);
    const message = result.voiceChannelOccupied
      ? `Event **#${eventId}** stopped. Its voice channel is still occupied, so it was kept.`
      : result.voiceChannelDeleted
        ? `Event **#${eventId}** stopped and its empty voice channel was deleted.`
        : `Event **#${eventId}** has been stopped. ⏹️`;
    await interaction.editReply({
      embeds: [createResponseEmbed("warning", "Event Stopped", message, "GUILD EVENT")],
    });
    return;
  }

  if (action === "cancel") {
    let event = await api.post<EventDetailView>(
      `api/events/${eventId}/cancel`,
      {},
      interaction.user.id,
    );
    // Cancellation may leave a Mass-created voice behind. Remove it only when empty; occupied
    // channels remain available for members to leave safely.
    if (event.discord_voice_channel_id) {
      try {
        const channel = await interaction.client.channels.fetch(event.discord_voice_channel_id);
        if (channel?.isVoiceBased() && voiceChannelOccupantCount(channel) === 0) {
          await channel.delete(`Event #${eventId} cancelled and voice channel was empty`);
          event = await api.delete<EventDetailView>(
            `api/events/${eventId}/discord-voice-channel`,
            interaction.user.id,
          ) ?? event;
        }
      } catch (error) {
        console.warn(`[Cancel command] Could not clean up cancelled event #${eventId} voice channel:`, error);
      }
    }
    const closed = await poller?.closeEventThread(eventId, { keepMapping: true });
    if (!closed) {
      await closeEventAnnouncementThread(thread, eventId, "Cancel command");
    }
    poller?.rememberEventThread(
      eventId,
      thread.id,
      poller?.eventSignupMessageIdFor(eventId) ?? undefined,
      `${event.roster_version ?? 0}:${event.status}`,
    );
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "warning",
          "Event Cancelled",
          `Event **#${eventId}** has been cancelled. Use **Reopen** if you need it back.`,
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  // action === "reopen"
  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/uncancel`,
    {},
    interaction.user.id,
  );
  await unlockAndUnarchiveThread(thread, `Event #${eventId} reopened`);
  poller?.rememberEventThread(
    eventId,
    thread.id,
    poller?.eventSignupMessageIdFor(eventId) ?? undefined,
    `${event.roster_version ?? 0}:${event.status}`,
  );
  await refreshThreadCards(api, eventId, "Reopen command");
  await interaction.editReply({
    embeds: [
      createResponseEmbed(
        "success",
        "Event Reopened",
        `Event **#${eventId}** is scheduled again. Join, ping, and start are available.`,
        "GUILD EVENT",
      ),
    ],
  });
}

async function joinEvent(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  poller: Poller | null,
  eventId: number,
): Promise<void> {
  // Flash masses are binary: the signup-options select menu is comp-shaped
  // and answers 409 for them, so the kind decides the flow before any
  // comp-specific call is made.
  let eventDetail: EventDetailView;
  try {
    eventDetail = await api.get<EventDetailView>(
      `api/events/${eventId}`,
      interaction.user.id,
    );
  } catch (err) {
    console.error("Failed to fetch event for thread join", err);
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event details.",
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  // Guild attribution: guild tenants are fixed; alliance tenants resolve the
  // caller's eligible guilds before any participate call is made.
  let guildResolution: JoinGuildResolution;
  try {
    guildResolution = await resolveJoinGuilds(
      api,
      interaction.guildId!,
      eventId,
      interaction.user.id,
    );
  } catch (err) {
    console.error("Failed to resolve join guild attribution for thread join", err);
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "error",
          eventJoinCopy(interaction.locale, "guildsFetchFailedTitle"),
          eventJoinCopy(interaction.locale, "guildsFetchFailed"),
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }
  if (guildResolution.kind === "none") {
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "warning",
          eventJoinCopy(interaction.locale, "noGuildTitle"),
          eventJoinCopy(interaction.locale, "noGuildBody"),
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }
  const guildTenantId =
    guildResolution.kind === "resolved" ? guildResolution.guildTenantId : null;
  const cardMessageId = poller?.eventSignupMessageIdFor(eventId) ?? "";

  if (eventDetail.event_kind === "flash") {
    if (guildResolution.kind === "choice") {
      const row = buildGuildSelectRow(
        guildResolution.guilds,
        eventId,
        cardMessageId,
        JOIN_GUILD_PENDING_FLASH,
        interaction.locale,
      );
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "info",
            eventJoinCopy(interaction.locale, "chooseGuildTitle"),
            eventJoinCopy(interaction.locale, "chooseGuildBody", { id: eventId }),
            "GUILD EVENT",
          ),
        ],
        components: [row],
      });
      return;
    }
    try {
      const updated = await api.post<EventDetailView>(
        participatePath(eventId, guildTenantId),
        { primary_build_id: null, secondary_build_id: null },
        interaction.user.id,
      );
      await refreshThreadCards(api, eventId, "Join command");
      const massTime = updated.mass_time_utc ?? updated.event_date_utc;
      const massTs = Math.floor(new Date(massTime).getTime() / 1000);
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "success",
            flashCopy(interaction.locale, "joinedTitle"),
            flashCopy(interaction.locale, "joinedBody", {
              id: eventId,
              massTs,
            }),
            "FLASH MASS",
          ),
        ],
      });
    } catch (e) {
      console.error("Failed to join flash mass", e);
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "error",
            flashCopy(interaction.locale, "joinFailedTitle"),
            flashCopy(interaction.locale, "joinFailed"),
            "FLASH MASS",
          ),
        ],
      });
    }
    return;
  }

  let signupOptions: EventSignupOptionsView;
  try {
    signupOptions = await api.get<EventSignupOptionsView>(
      `api/events/${eventId}/signup-options`,
      interaction.user.id,
    );
  } catch (err) {
    console.error("Failed to fetch signup options for thread join", err);
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event signup options.",
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  const buildQuery = interaction.options.getString("build", false);
  if (buildQuery !== null) {
    const match = resolveSignupBuildByName(signupOptions.builds, buildQuery);
    if (match.kind === "none") {
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "warning",
            eventThreadCopy(interaction.locale, "buildNoMatchTitle"),
            eventThreadCopy(interaction.locale, "buildNoMatchBody", {
              query: buildQuery,
              builds: listBuildNames(signupOptions.builds),
            }),
            "GUILD EVENT",
          ),
        ],
      });
      return;
    }
    if (match.kind === "ambiguous") {
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "warning",
            eventThreadCopy(interaction.locale, "buildAmbiguousTitle"),
            eventThreadCopy(interaction.locale, "buildAmbiguousBody", {
              query: buildQuery,
              matches: listBuildNames(match.matches),
            }),
            "GUILD EVENT",
          ),
        ],
      });
      return;
    }
    try {
      if (guildResolution.kind === "choice") {
        // Build already chosen; the guild choice completes it and the select
        // handler then submits guild + build together, exactly once.
        const row = buildGuildSelectRow(
          guildResolution.guilds,
          eventId,
          cardMessageId,
          String(match.build.build_id),
          interaction.locale,
        );
        await interaction.editReply({
          embeds: [
            createResponseEmbed(
              "info",
              eventJoinCopy(interaction.locale, "chooseGuildTitle"),
              eventJoinCopy(interaction.locale, "chooseGuildBody", { id: eventId }),
              "GUILD EVENT",
            ),
          ],
          components: [row],
        });
        return;
      }
      await api.post(
        participatePath(eventId, guildTenantId),
        { primary_build_id: match.build.build_id },
        interaction.user.id,
      );
      await refreshThreadCards(api, eventId, "Join command");
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "success",
            "Signed Up For Event",
            `You have successfully signed up for event **#${eventId}** as **${match.build.name}**.`,
            "GUILD EVENT",
          ),
        ],
      });
    } catch (e) {
      console.error("Failed to join event from thread", e);
      await interaction.editReply({
        embeds: [
          createResponseEmbed(
            "error",
            "Join Failed",
            "Failed to join the event.",
            "GUILD EVENT",
          ),
        ],
      });
    }
    return;
  }

  // No build argument: same role-select flow as the Join button. The select
  // handlers refresh the thread's signup card via the message id embedded in
  // the custom id, so pass the poller's remembered card when available. The
  // chosen guild rides the same custom id so the chain submits once.
  if (guildResolution.kind === "choice") {
    const row = buildGuildSelectRow(
      guildResolution.guilds,
      eventId,
      cardMessageId,
      "",
      interaction.locale,
    );
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "info",
          eventJoinCopy(interaction.locale, "chooseGuildTitle"),
          eventJoinCopy(interaction.locale, "chooseGuildBody", { id: eventId }),
          "GUILD EVENT",
        ),
      ],
      components: [row],
    });
    return;
  }
  const availableRoles = signupRoles(signupOptions.builds);
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(buildRoleSelectCustomId(eventId, cardMessageId, guildTenantId))
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
  await interaction.editReply({
    embeds: [
      createResponseEmbed(
        "info",
        "Select Role",
        signupOptions.is_already_registered
          ? `🎯 You're already signed up — pick a role to change your build for event **#${eventId}**:`
          : `🎯 Choose your role for event **#${eventId}**:`,
        "GUILD EVENT",
      ),
    ],
    components: [row],
  });
}

async function leaveEvent(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  eventId: number,
): Promise<void> {
  let event: EventDetailView;
  try {
    event = await api.get<EventDetailView>(
      `api/events/${eventId}`,
      interaction.user.id,
    );
  } catch (err) {
    console.error("Failed to fetch event for thread leave", err);
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "error",
          "Fetch Error",
          "Failed to fetch event details.",
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  const isParticipant = event.participants?.some(
    (p: EventParticipant) => p.discord_id === interaction.user.id,
  );
  if (!isParticipant) {
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "info",
          "Not Signed Up",
          `You aren't signed up for event **#${eventId}** — nothing to leave.`,
          "GUILD EVENT",
        ),
      ],
    });
    return;
  }

  try {
    await api.delete(`api/events/${eventId}/participate`, interaction.user.id);
    await refreshThreadCards(api, eventId, "Leave command");
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "success",
          event.event_kind === "flash"
            ? flashCopy(interaction.locale, "leftTitle")
            : "Left Event",
          event.event_kind === "flash"
            ? flashCopy(interaction.locale, "leftBody", { id: eventId })
            : `You have successfully left event **#${eventId}**.`,
          "GUILD EVENT",
        ),
      ],
    });
  } catch (e) {
    console.error("Failed to leave event from thread", e);
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "error",
          event.event_kind === "flash"
            ? flashCopy(interaction.locale, "leaveFailedTitle")
            : "Leave Failed",
          event.event_kind === "flash"
            ? flashCopy(interaction.locale, "leaveFailed")
            : "Failed to leave the event.",
          "GUILD EVENT",
        ),
      ],
    });
  }
}