import type { SplitDetail, SplitParticipant, SplitParticipantCreditStatus } from "../api/types.js";
import { formatSilver } from "../format.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const MAX_MESSAGE_LENGTH = 1_900;

export interface SplitSummaryPayload {
  content: string;
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
  return safeText(participant.username);
}

function creditStatus(status: SplitParticipantCreditStatus | null | undefined): string {
  switch (status) {
    case "withdrawn": return "paid/withdrawn";
    case "requested": return "requested";
    case "pending": return "credit pending";
    default: return "—";
  }
}

export function buildSplitThreadName(split: SplitDetail): string {
  const context = split.event_title?.trim() || "No event";
  return Array.from(`Split #${split.id} — ${context}`).slice(0, 100).join("");
}

export function buildSplitSummary(split: SplitDetail): SplitSummaryPayload {
  const mentions = new Set<string>();
  const lines = [
    `**Split #${split.id}**`,
    `**Event:** ${safeText(split.event_title)}${split.event_id === null ? "" : ` (\#${split.event_id})`}`,
    `**Note:** ${safeText(split.note)}`,
    `**Loot:** estimated ${formatSilver(split.estimated_market_value)} silver · repair ${formatSilver(split.repair_value)} · bags ${formatSilver(split.bags_value)} · net ${formatSilver(split.net_value)}`,
    `**Location:** ${safeText(split.island_city)} / ${safeText(split.island_name)} / ${safeText(split.island_tab_name)}`,
    `**Status:** ${safeText(split.status)} · **Created by:** ${safeText(split.created_by_username)} · **Date:** ${safeText(split.created_at)}`,
    "",
    "```text",
    "Player | Value | Status",
    "-------|-------|-------",
  ];

  for (const participant of split.participants) {
    lines.push(`${participantLabel(participant, mentions)} | ${formatSilver(participant.share_amount)} | ${creditStatus(participant.credit_status)}`);
  }
  lines.push("```");

  return {
    content: lines.join("\n").slice(0, MAX_MESSAGE_LENGTH),
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
