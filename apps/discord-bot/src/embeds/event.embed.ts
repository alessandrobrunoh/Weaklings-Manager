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
 * const content = buildEventAnnouncementContent(event);
 * await channel.send({ content, allowedMentions: { roles: event.discord_role_ids } });
 */
export function buildEventAnnouncementContent(event: EventView): string {
  const timestamp = Math.floor(new Date(event.event_date_utc).getTime() / 1000);
  const description = event.description?.trim() || "*No description provided.*";
  const roleMentions = (event.discord_role_ids ?? []).map((roleId) => `<@&${roleId}>`).join(" ");

  return [
    `📌 ${event.title} - <t:${timestamp}:t> | <t:${timestamp}:d>`,
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

/** Builds the manual pre-event reminder without enabling broad Discord mention parsing. */
export function buildEventReminderMessage(event: EventView): EventReminderMessage {
  const timestamp = Math.floor(new Date(event.event_date_utc).getTime() / 1000);
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

  const detail = event as EventDetailView;
  const rosterCount = detail.participants?.length ?? 0;

  descLines.push(
    `🗓️ **Date & Time** — <t:${ts}:F> (<t:${ts}:R>)`,
    `⚡ **Status** — ${status}`,
    `⚔️ **Composition** — ${event.comp_name}`,
    `👑 **Organizer** — ${event.created_by_username}`,
    `📋 **Roster** — ${rosterCount}/${detail.active_comp_capacity ?? "?"} filled`,
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

  // Who is actually signed up, grouped by build — not just how many, which
  // told an officer nothing about *whether the right people* had signed up
  // (e.g. three healers all on alts) short of opening the web app.
  if (rosterCount > 0) {
    const byBuild = new Map<string, string[]>();
    for (const p of detail.participants) {
      const names = byBuild.get(p.primary_build_name) ?? [];
      // A real @mention pings/links to the member, unlike plain text — falls
      // back to a plain (not @-triggering) name for a participant whose
      // Discord account isn't linked, since `<@undefined>` would render as
      // broken literal text instead of quietly degrading.
      names.push(p.discord_id ? `<@${p.discord_id}>` : p.username);
      byBuild.set(p.primary_build_name, names);
    }

    // Discord caps an embed at 25 fields total; this one is shared with a
    // handful of others (description counts as the embed itself, not a
    // field, so the real budget here is generous), but a comp with an
    // unusually large number of distinct builds could still overflow it —
    // fold the tail into a single "+N more roles" field rather than
    // silently dropping fields past Discord's limit.
    const MAX_BUILD_FIELDS = 23;
    const entries = [...byBuild.entries()];
    const shown = entries.slice(0, MAX_BUILD_FIELDS);
    const overflow = entries.slice(MAX_BUILD_FIELDS);

    for (const [buildName, names] of shown) {
      embed.addFields({
        name: `${buildName} (${names.length})`,
        value: formatNameList(names),
        inline: true,
      });
    }
    if (overflow.length > 0) {
      const overflowCount = overflow.reduce((sum, [, names]) => sum + names.length, 0);
      embed.addFields({
        name: `+${overflow.length} more roles`,
        value: `${overflowCount} more player(s) — see the web app for the full roster.`,
        inline: true,
      });
    }
  } else {
    embed.addFields({
      name: "📋 Roster",
      value:
        "*No players registered yet. Click a role button below to sign up!*",
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

/** Builds the shared five-button control row shown inside an event announcement thread. */
export function buildEventThreadActionRow(
  event: EventView,
): ActionRowBuilder<ButtonBuilder> {
  const isScheduled = event.status === "scheduled";
  const isLive = event.status === "live";

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
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
  );
}
