import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { EventView, EventDetailView } from "../api/types.js";
import { BOT_COLORS, createBaseEmbed } from "./theme.js";

/**
 * Plain Discord announcement copy for channels where users should only be pinged.
 *
 * The message intentionally avoids embeds, buttons, and reaction-driven UI because event creation
 * is only an announcement surface here; participation flows stay in slash commands/detail views.
 * Discord's timestamp tokens render in each user's local timezone while keeping a compact
 * `time | date` layout.
 *
 * @example
 * const content = buildEventAnnouncementContent(event, '123456789012345678');
 * await channel.send({ content, allowedMentions: { roles: ['123456789012345678'] } });
 */
export function buildEventAnnouncementContent(
  event: EventView,
  eventRoleId: string | undefined,
): string {
  const timestamp = Math.floor(new Date(event.event_date_utc).getTime() / 1000);
  const description = event.description?.trim() || "*No description provided.*";
  const roleMention = eventRoleId ? `<@&${eventRoleId}>` : "@Weak";

  return [
    `📌 ${event.title} - <t:${timestamp}:t> | <t:${timestamp}:d>`,
    "",
    description,
    "",
    `|| ${roleMention} ||`,
    "",
    "---",
  ].join("\n");
}

// Status colors
const STATUS_COLOR: Record<string, number> = {
  scheduled: BOT_COLORS.BRAND,
  live: BOT_COLORS.SUCCESS,
  stopped: BOT_COLORS.DARK,
  auto_stopped: BOT_COLORS.WARNING,
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: "SCHEDULED",
  live: "LIVE 🟢",
  stopped: "STOPPED ⏹️",
  auto_stopped: "AUTO-STOPPED ⚠️",
};

// ── Event detail embed ───────────────────────────────────────────────────────

export function buildEventEmbed(
  event: EventView | EventDetailView,
): EmbedBuilder {
  const color = STATUS_COLOR[event.status] ?? BOT_COLORS.BRAND;
  const status = STATUS_LABEL[event.status] ?? event.status.toUpperCase();
  const date = new Date(event.event_date_utc);
  const ts = Math.floor(date.getTime() / 1000);

  let descLines: string[] = [];

  if (event.description) {
    descLines.push(`*${event.description}*`, "");
  }

  descLines.push(
    `• 🗓️ **Date & Time:** <t:${ts}:F> (<t:${ts}:R>)`,
    `• ⚡ **Status:** \`${status}\``,
    `• ⚔️ **Composition:** **${event.comp_name}**`,
    `• 👑 **Organizer:** **${event.created_by_username}**`,
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

  // For EventDetailView with participants, show the roster grouped by build.
  const detail = event as EventDetailView;
  if (detail.participants?.length > 0) {
    const buildCounts: Record<string, number> = {};
    for (const p of detail.participants) {
      buildCounts[p.primary_build_name] =
        (buildCounts[p.primary_build_name] || 0) + 1;
    }

    const lines = Object.entries(buildCounts)
      .map(([buildName, count]) => `• **${count}x** ${buildName}`)
      .join("\n");

    embed.addFields({
      name: `📋 Roster (${detail.participants.length}/${detail.active_comp_capacity} Filled)`,
      value: lines,
      inline: false,
    });
  } else {
    embed.addFields({
      name: `📋 Roster (0/${detail.active_comp_capacity ?? "?"})`,
      value:
        "*No players registered yet. Click a role button below to sign up!*",
      inline: false,
    });
  }

  return embed;
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
    const ts = Math.floor(new Date(e.event_date_utc).getTime() / 1000);
    const status = STATUS_LABEL[e.status] ?? e.status.toUpperCase();
    return [
      `${e.call_to_arms ? "🚨 " : "📌 "}**[#${e.id}] ${e.title}**`,
      `• ⚡ \`${status}\` · ⚔️ **${e.comp_name}** · <t:${ts}:R>`,
    ].join("\n");
  });

  embed.setDescription(lines.join("\n\n"));
  return embed;
}

// ── Event participation buttons ──────────────────────────────────────────────

export function buildEventManageActionRow(
  eventId: number,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`event:manage:${eventId}`)
      .setLabel("Manage Participation")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
  );

  return row;
}
