import type { APIEmbed } from "discord.js";
import type { DecimalValue, SplitDetail, SplitParticipant, SplitParticipantCreditStatus } from "../api/types.js";
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

interface Fixed {
  units: bigint;
  scale: number;
}

const ZERO: Fixed = { units: 0n, scale: 0 };

/** Parses a decimal string (or number) into exact integer units; unparseable input is 0. */
function parseFixed(value: DecimalValue | null | undefined): Fixed {
  if (value === null || value === undefined) return ZERO;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return ZERO;
    text = value.toFixed(8);
  } else {
    text = value.trim();
  }
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) return ZERO;
  const fraction = match[3] ?? "";
  const units = BigInt(`${match[2] || "0"}${fraction}`);
  return { units: match[1] === "-" ? -units : units, scale: fraction.length };
}

function rescale(value: Fixed, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** Integer division rounding half to even, like `rust_decimal::round_dp`. */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const twiceRemainder = (n % d) * 2n;
  if (twiceRemainder > d || (twiceRemainder === d && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}

/** Converts a backend decimal (string or number) to a JS number without ever concatenating. */
export function decimalToNumber(value: DecimalValue | null | undefined): number {
  const fixed = parseFixed(value);
  return Number(fixed.units) / 10 ** fixed.scale;
}

/** Pending pool before the backend stores `net_value`.
 *
 * Mirrors `calculate_net_value`: the fee applies to gross - repairs + bags, and bags
 * increase the pool. The backend serialises money as decimal strings, so the maths runs
 * on exact integers and rounds to cents half-to-even like `Decimal::round_dp(2)`.
 */
export function pendingSplitPool(split: Pick<SplitDetail, "estimated_market_value" | "fee" | "repair_value" | "bags_value">): {
  valueBeforeFee: number;
  feeAmount: number;
  net: number;
} {
  const gross = parseFixed(split.estimated_market_value);
  const repairs = parseFixed(split.repair_value);
  const bags = parseFixed(split.bags_value);
  const fee = parseFixed(split.fee);

  const scale = Math.max(gross.scale, repairs.scale, bags.scale);
  const valueBeforeFee = rescale(gross, scale) - rescale(repairs, scale) + rescale(bags, scale);
  const scaleFactor = 10n ** BigInt(scale);
  // fee percent = fee.units / 10^fee.scale / 100
  const feeDenominator = 100n * 10n ** BigInt(fee.scale);

  // Exact value in cents = valueBeforeFee / 10^scale * 100 * (fee or 100%-fee).
  const feeCents = divRoundHalfEven(valueBeforeFee * fee.units * 100n, feeDenominator * scaleFactor);
  const netCents = divRoundHalfEven(
    valueBeforeFee * (feeDenominator - fee.units) * 100n,
    feeDenominator * scaleFactor,
  );

  return {
    valueBeforeFee: Number(valueBeforeFee) / 10 ** scale,
    feeAmount: centsToNumber(feeCents),
    net: Math.max(0, centsToNumber(netCents)),
  };
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

  const pool = pendingSplitPool(split);
  const netValue = split.net_value === null || split.net_value === undefined ? pool.net : decimalToNumber(split.net_value);
  const gross = decimalToNumber(split.estimated_market_value);
  const repairs = decimalToNumber(split.repair_value);
  const bags = decimalToNumber(split.bags_value);
  const feePercent = decimalToNumber(split.fee);
  const taxAmount = pool.feeAmount;

  // Financial breakdown
  embed.addFields({
    name: "🪙 Financial Breakdown",
    value: [
      `• 💎 **Gross Loot Value:** **${formatSilver(gross)}** Silver`,
      `• 🏛️ **Guild Fee (${feePercent}%):** -${formatSilver(taxAmount)} Silver`,
      `• 🛠️ **Repairs:** -${formatSilver(repairs)} Silver`,
      `• 🎒 **Bags:** +${formatSilver(bags)} Silver`,
      `• 💵 **Net Split Pool:** **${formatSilver(netValue)}** Silver`,
    ].join("\n"),
    inline: false,
  });

  // ASCII Pool allocation chart
  if (gross > 0) {
    const chartItems = [
      { label: "Players Share", value: Math.max(0, netValue), display: `${formatSilver(netValue)} Silver` },
      { label: "Guild Fee", value: taxAmount, display: `${formatSilver(taxAmount)} Silver` },
      { label: "Repairs", value: repairs, display: `${formatSilver(repairs)} Silver` },
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
