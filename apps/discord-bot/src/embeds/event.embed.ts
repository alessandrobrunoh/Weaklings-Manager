import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { EventView, EventDetailView } from "../api/types.js";
import { BOT_COLORS, createBaseEmbed } from "./theme.js";

/**
 * Plain Discord announcement copy used together with the interactive event card in the parent
 * channel. The text keeps role mentions and timestamps compact, while the embed and components
 * provide the event details and management controls.
 * Discord's timestamp tokens render in each user's local timezone while keeping a compact
 * `time | date` layout.
 *
 * @example
 * const content = buildEventAnnouncementContent(event);
 * await channel.send({
 *   content,
 *   embeds: [buildEventEmbed(event)],
 *   components: buildEventThreadActionRows(event),
 *   allowedMentions: { roles: event.discord_role_ids },
 * });
 */
export function buildEventAnnouncementContent(event: EventView): string {
  const massTimestamp = eventTimestamp(event, "mass");
  const startTimestamp = eventTimestamp(event, "start");
  const description = event.description?.trim() || "*No description provided.*";
  const roleMentions = (event.discord_role_ids ?? []).map((roleId) => `<@&${roleId}>`).join(" ");

  return [
    `📌 ${event.title} - Mass <t:${massTimestamp}:t> | Start <t:${startTimestamp}:t> | <t:${startTimestamp}:d>`, 
    "",
    description,
    "",
    `|| ${roleMentions} ||`,
    "",
    "---",
  ].join("\n");
}

export interface EventReminderMessage {
  content: string;
  allowedMentions: { parse: []; roles?: string[] };
}

export interface EventStartMessage {
  content: string;
  allowedMentions: { parse: []; users: string[] };
}

export const eventTimestamp = (event: EventView, kind: "mass" | "start"): number => {
  const value = kind === "mass" ? event.mass_time_utc : event.start_time_utc;
  return Math.floor(new Date(value ?? event.event_date_utc).getTime() / 1000);
};

export function buildEventMassMessage(
  event: EventView,
  participants: Array<{ discord_id: string | null; username: string }>,
  voiceChannelId: string,
): EventStartMessage {
  const linkedUserIds = [...new Set(participants.flatMap((p) => p.discord_id ? [p.discord_id] : []))];
  const unlinkedNames = participants.filter((p) => !p.discord_id).map((p) => p.username);
  const mentions = linkedUserIds.map((id) => `<@${id}>`).join(" ") || "No linked Discord participants yet.";
  const unlinked = unlinkedNames.length ? `\nNot linked on Discord: ${unlinkedNames.join(", ")}.` : "";
  return {
    content: `🔔 ${mentions}\n**${event.title}** mass is starting — join <#${voiceChannelId}>. Start: <t:${eventTimestamp(event, "start")}:R>.${unlinked}`,
    allowedMentions: { parse: [], users: linkedUserIds },
  };
}

/** Builds the manual pre-event reminder without enabling broad Discord mention parsing. */
export function buildEventReminderMessage(event: EventView): EventReminderMessage {
  const timestamp = eventTimestamp(event, "start");
  const roleIds = [...new Set(event.discord_role_ids ?? [])];
  const roleMentions = roleIds.map((roleId) => `<@&${roleId}>`).join(" ");
  const prefix = roleMentions ? `${roleMentions} ` : "";

  return {
    content: `🔔 ${prefix}Reminder: **${event.title}** starts <t:${timestamp}:R>. Use **Join / Change Build** to sign up!`,
    allowedMentions: roleIds.length > 0
      ? { parse: [], roles: roleIds }
      : { parse: [] },
  };
}

/** Builds the live-event notice without allowing arbitrary user or role mentions. */
export function buildEventStartMessage(
  event: EventView,
  participants: Array<{ discord_id: string | null; username: string }>,
  voiceChannelId: string,
): EventStartMessage {
  const linkedUserIds = [...new Set(
    participants.flatMap((participant) => participant.discord_id ? [participant.discord_id] : []),
  )];
  const unlinkedNames = participants
    .filter((participant) => !participant.discord_id)
    .map((participant) => participant.username);
  const linkedMentions = linkedUserIds.map((userId) => `<@${userId}>`).join(" ");
  const recipientLine = linkedMentions || "No linked Discord participants yet.";
  const unlinkedLine = unlinkedNames.length > 0
    ? `\nNot linked on Discord: ${unlinkedNames.join(", ")}.`
    : "";

  return {
    content: `🚨 ${recipientLine}\n**${event.title}** is now **LIVE** — join <#${voiceChannelId}>.${unlinkedLine}`,
    allowedMentions: { parse: [], users: linkedUserIds },
  };
}

// Status colors
const STATUS_COLOR: Record<string, number> = {
  scheduled: BOT_COLORS.BRAND,
  live: BOT_COLORS.SUCCESS,
  stopped: BOT_COLORS.DARK,
  auto_stopped: BOT_COLORS.WARNING,
  cancelled: BOT_COLORS.DANGER,
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: "SCHEDULED",
  live: "LIVE 🟢",
  stopped: "STOPPED ⏹️",
  auto_stopped: "AUTO-STOPPED ⚠️",
  cancelled: "CANCELLED ❌",
};

// ── Event detail embed ───────────────────────────────────────────────────────

export function buildEventEmbed(
  event: EventView | EventDetailView,
): EmbedBuilder {
  const color = STATUS_COLOR[event.status] ?? BOT_COLORS.BRAND;
  const status = STATUS_LABEL[event.status] ?? event.status.toUpperCase();
  const dateTs = Math.floor(new Date(event.event_date_utc).getTime() / 1000);
  const massTs = event.mass_time_utc
    ? Math.floor(new Date(event.mass_time_utc).getTime() / 1000)
    : dateTs;
  const startTs = event.start_time_utc
    ? Math.floor(new Date(event.start_time_utc).getTime() / 1000)
    : dateTs;

  let descLines: string[] = [];

  if (event.description) {
    descLines.push(`*${event.description}*`, "");
  }

  const detail = event as EventDetailView;
  const rosterCount = detail.participants?.length ?? 0;

  descLines.push(
    `🗓️ **Date** — <t:${dateTs}:d>`,
    `📣 **Mass** — <t:${massTs}:F> (<t:${massTs}:R>)`,
    `▶️ **Start** — <t:${startTs}:F> (<t:${startTs}:R>)`,
    `⚡ **Status** — ${status}`,
    `⚔️ **Composition** — ${detail.active_comp_name ?? event.comp_name}`,
    `👑 **Organizer** — ${event.created_by_username}`,
    `📋 **Roster** — ${rosterCount}/${detail.active_comp_capacity ?? "?"} filled`,
    ...(event.player_cap
      ? [`🎯 **Player cap** — ${event.player_cap} (expands automatically)`]
      : []),
    ...(event.call_to_arms
      ? ["", "🚨 **URGENT — CALL TO ARMS** — be online and ready!"]
      : []),
  );

  const embed = createBaseEmbed({
    category: "GUILD EVENT",
    title: event.call_to_arms
      ? `🚨 CALL TO ARMS: ${event.title}`
      : `📌 ${event.title}`,
    description: descLines.join("\n"),
    color,
    footerText: `Event #${event.id} • Weaklings Guild Manager`,
  });

  // Render the complete active comp, including every unfilled seat. This lets
  // shotcallers see missing roles directly in the announcement instead of
  // inferring them from a list that only contained the builds already chosen.
  const compBuilds = detail.comp_builds ?? [];
  if (compBuilds.length > 0) {
    const namesByBuildId = new Map<number, string[]>();
    const fillNames: string[] = [];
    for (const participant of detail.participants) {
      const name = participant.discord_id
        ? `<@${participant.discord_id}>`
        : participant.username;
      if (participant.primary_build_id === null) {
        fillNames.push(name);
      } else {
        const names = namesByBuildId.get(participant.primary_build_id) ?? [];
        names.push(name);
        namesByBuildId.set(participant.primary_build_id, names);
      }
    }

    for (const compBuild of compBuilds) {
      const assigned = namesByBuildId.get(compBuild.build_id) ?? [];
      const playerSlots = assigned.slice(0, compBuild.quantity);
      const emptySlots = Array.from(
        { length: Math.max(compBuild.quantity - playerSlots.length, 0) },
        () => "*?*",
      );
      embed.addFields({
        name: `${compBuild.name} (${playerSlots.length}/${compBuild.quantity})`,
        value: formatNameList([...playerSlots, ...emptySlots]),
        inline: true,
      });
    }

    if (fillNames.length > 0) {
      embed.addFields({
        name: `Fill (${fillNames.length})`,
        value: formatNameList(fillNames),
        inline: true,
      });
    }
  } else if (rosterCount > 0) {
    const byBuild = new Map<string, string[]>();
    for (const participant of detail.participants) {
      const names = byBuild.get(participant.primary_build_name) ?? [];
      names.push(participant.discord_id ? `<@${participant.discord_id}>` : participant.username);
      byBuild.set(participant.primary_build_name, names);
    }
    for (const [buildName, names] of byBuild) {
      embed.addFields({ name: `${buildName} (${names.length})`, value: formatNameList(names), inline: true });
    }
  } else {
    embed.addFields({
      name: "📋 Roster",
      value: "*No players registered yet. Click a role button below to sign up!*",
      inline: false,
    });
  }

  return embed;
}

/**
 * Renders a bulleted name list for one embed field, truncating rather than
 * exceeding Discord's 1024-character field-value cap. A single very popular
 * build (a whole raid signing up as the same tank, say) could otherwise push
 * past that limit and get the field silently rejected by Discord instead of
 * gracefully cut off.
 */
function formatNameList(names: string[]): string {
  const FIELD_VALUE_LIMIT = 1024;
  const SAFETY_MARGIN = 40; // room for the "+N more" line appended below

  let value = "";
  let shown = 0;
  for (const name of names) {
    const line = `• ${name}\n`;
    if (value.length + line.length > FIELD_VALUE_LIMIT - SAFETY_MARGIN) break;
    value += line;
    shown++;
  }

  const remaining = names.length - shown;
  if (remaining > 0) {
    value += `*+${remaining} more*`;
  }
  return value.trim();
}

// ── Embed lista eventi ───────────────────────────────────────────────────────

export function buildEventSummaryEmbed(
  events: EventView[],
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = createBaseEmbed({
    category: "EVENT CALENDAR",
    title: "📅 Guild Events",
    color: BOT_COLORS.BRAND,
    footerText: `Page ${page} of ${totalPages} • Weaklings Guild Manager`,
  });

  if (events.length === 0) {
    embed.setDescription("*No upcoming or past events found.*");
    return embed;
  }

  const lines = events.map((e) => {
    const timestamp = eventTimestamp(e, "start");
    const status = STATUS_LABEL[e.status] ?? e.status.toUpperCase();
    return [
      `${e.call_to_arms ? "🚨 " : "📌 "}**[#${e.id}] ${e.title}**`,
      `• ⚡ \`${status}\` · ⚔️ **${e.comp_name}** · Mass <t:${eventTimestamp(e, "mass")}:R> · Start <t:${timestamp}:R>`,
    ].join("\n");
  });

  embed.setDescription(lines.join("\n\n"));
  return embed;
}

// ── Event participation buttons ──────────────────────────────────────────────

/**
 * Two explicit buttons instead of one "Manage Participation" button whose
 * behaviour silently depended on whether *you* happened to already be signed
 * up. Both are always visible to everyone on the shared signup message —
 * that's a Discord constraint, not a choice: a message's components can't
 * differ per viewer — so each button just responds sensibly no matter who
 * clicks it: "Leave" tells a non-participant they aren't signed up instead
 * of erroring, and "Join" lets an existing participant re-pick their build
 * rather than refusing a second signup.
 */
export function buildEventManageActionRow(
  eventId: number,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}`)
      .setLabel("Join / Change Build")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`event:leave:${eventId}`)
      .setLabel("Leave Event")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Danger),
  );

  return row;
}

/** Builds the shared event control rows shown inside an event announcement thread. */
export function buildEventThreadActionRows(
  event: EventView,
): ActionRowBuilder<ButtonBuilder>[] {
  const isScheduled = event.status === "scheduled";
  const isLive = event.status === "live";
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`event:join:${event.id}`)
      .setLabel("Join / Change Build")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isScheduled),
    new ButtonBuilder()
      .setCustomId(`event:leave:${event.id}`)
      .setLabel("Leave")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isScheduled),
    new ButtonBuilder()
      .setCustomId(`event:ping:${event.id}`)
      .setLabel("Ping")
      .setEmoji("🔔")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isScheduled),
    new ButtonBuilder()
      .setCustomId(`event:start:${event.id}`)
      .setLabel("Start")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isScheduled),
    new ButtonBuilder()
      .setCustomId(`event:stop:${event.id}`)
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isLive),
    new ButtonBuilder()
      .setCustomId(`event:cancel:${event.id}`)
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!(isScheduled || isLive)),
  ];

  // Discord allows at most five buttons in one action row.
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(0, 5)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(5)),
  ];
}
