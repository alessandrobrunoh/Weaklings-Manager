import type { APIEmbed } from "discord.js";
import type { SplitDetail, SplitParticipant, SplitParticipantCreditStatus } from "../api/types.js";
import { formatSilver } from "../format.js";
import { BOT_COLORS, buildAsciiChart, createBaseEmbed } from "../embeds/theme.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const MAX_MESSAGE_LENGTH = 1_900;

export interface SplitSummaryPayload {
  content?: string;
  embeds?: APIEmbed[];
  allowedMentions: { users: string[]; parse: [] };
}

export function isValidDiscordUserId(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && DISCORD_SNOWFLAKE.test(value);
}

function safeText(value: string | null | undefined, fallback = "—"): string {
  const text = value?.trim();
  if (!text) return fallback;
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~>]/g, "\\$&");
}

function participantLabel(participant: SplitParticipant, mentions: Set<string>): string {
  if (isValidDiscordUserId(participant.discord_id)) {
    mentions.add(participant.discord_id);
    return `<@${participant.discord_id}>`;
  }
  return `**${safeText(participant.username)}**`;
}

function creditStatusPill(status: SplitParticipantCreditStatus | null | undefined): string {
  switch (status) {
    case "withdrawn": return "🟢 Paid";
    case "requested": return "🔵 Requested";
    case "rejected": return "🔴 Rejected";
    case "donated": return "🎁 Donated to Bank";
    case "pending": return "🟡 Pending Claim";
    default: return "⚪ Pending";
  }
}

export function buildSplitThreadName(split: SplitDetail): string {
  const context = split.event_title?.trim() || "No event";
  return Array.from(`Split #${split.id} — ${context}`).slice(0, 100).join("");
}

export function buildSplitSummary(split: SplitDetail): SplitSummaryPayload {
  const mentions = new Set<string>();

  const color =
    split.status === "completed"
      ? BOT_COLORS.SUCCESS
      : split.status === "pending" || split.status === "awaiting_event"
        ? BOT_COLORS.BRAND
        : BOT_COLORS.DANGER;

  const eventText = split.event_title
    ? `Event: **${safeText(split.event_title)}**${split.event_id ? ` (#${split.event_id})` : ''}`
    : 'No linked event';

  const subtitleParts = [
    eventText,
    `Status: **${split.status.toUpperCase()}**`,
    `Host: **${safeText(split.created_by_username)}**`,
  ];

  const embed = createBaseEmbed({
    category: "LOOT SPLIT",
    title: `💰 Split #${split.id}${split.event_title ? ` — ${split.event_title}` : ''}`,
    description: `*${subtitleParts.join(' · ')}*${split.note ? `\n\n💬 *Note: ${safeText(split.note)}*` : ''}`,
    color,
    footerText: `Split #${split.id} • Weaklings Guild Manager`,
  });

  const netValue = split.net_value ?? Math.max(0, split.estimated_market_value - (split.estimated_market_value * split.fee) / 100 - split.repair_value - split.bags_value);
  const taxAmount = (split.estimated_market_value * split.fee) / 100;
  const repairsAndBags = split.repair_value + split.bags_value;

  // Financial breakdown
  embed.addFields({
    name: "🪙 Financial Breakdown",
    value: [
      `• 💎 **Gross Loot Value:** **${formatSilver(split.estimated_market_value)}** Silver`,
      `• 🏛️ **Guild Fee (${split.fee}%):** -${formatSilver(taxAmount)} Silver`,
      `• 🛠️ **Repairs & Bags:** -${formatSilver(repairsAndBags)} Silver`,
      `• 💵 **Net Split Pool:** **${formatSilver(netValue)}** Silver`,
    ].join("\n"),
    inline: false,
  });

  // ASCII Pool allocation chart
  if (split.estimated_market_value > 0) {
    const chartItems = [
      { label: "Players Share", value: Math.max(0, netValue), display: `${formatSilver(netValue)} Silver` },
      { label: "Guild Fee", value: taxAmount, display: `${formatSilver(taxAmount)} Silver` },
      { label: "Repairs/Bags", value: repairsAndBags, display: `${formatSilver(repairsAndBags)} Silver` },
    ].filter((i) => i.value > 0);

    if (chartItems.length > 0) {
      embed.addFields({
        name: "📊 POOL ALLOCATION",
        value: `\`\`\`\n${buildAsciiChart(chartItems, 14, 12)}\n\`\`\``,
        inline: false,
      });
    }
  }

  // Drop-off location
  if (split.island_city || split.island_name || split.island_tab_name) {
    embed.addFields({
      name: "🏝️ Drop-off Chest Location",
      value: `• **City:** ${safeText(split.island_city)} · **Island:** ${safeText(split.island_name)} · **Tab:** \`${safeText(split.island_tab_name)}\``,
      inline: false,
    });
  }

  // Participants Roster
  if (split.participants.length > 0) {
    const rosterLines = split.participants.map((p) => {
      const share = p.share_amount !== null ? `${formatSilver(p.share_amount)} Silver` : "—";
      return `• ${participantLabel(p, mentions)} — **${share}** (${creditStatusPill(p.credit_status)})`;
    });

    embed.addFields({
      name: `👥 Payout Roster (${split.participants.length} Players)`,
      value: rosterLines.slice(0, 25).join("\n").slice(0, 1024),
      inline: false,
    });
  } else {
    embed.addFields({
      name: "👥 Payout Roster",
      value: "*No participants registered for this split.*",
      inline: false,
    });
  }

  return {
    content: mentions.size > 0 ? [...mentions].map((id) => `<@${id}>`).join(" ") : undefined,
    embeds: [embed.toJSON()],
    allowedMentions: { users: [...mentions], parse: [] },
  };
}

export function chunkSplitLog(message: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  const normalized = message.trim() || "(no details)";
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += maxLength) {
    chunks.push(normalized.slice(offset, offset + maxLength));
  }
  return chunks;
}
