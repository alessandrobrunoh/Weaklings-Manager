import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { GiveawayDetailView, GiveawayView } from '../api/types.js';
import { formatSilver } from '../format.js';
import { BOT_COLORS, createBaseEmbed } from './theme.js';

const QUALITY_LABEL: Record<number, string> = {
  1: 'Normal',
  2: 'Good',
  3: 'Outstanding',
  4: 'Excellent',
  5: 'Masterpiece',
};

const STATUS_COLOR: Record<string, number> = {
  open: BOT_COLORS.BRAND,
  drawn: BOT_COLORS.SUCCESS,
  cancelled: BOT_COLORS.DANGER,
  expired_empty: BOT_COLORS.WARNING,
};

const STATUS_LABEL: Record<string, string> = {
  open: 'OPEN',
  drawn: 'DRAWN',
  cancelled: 'CANCELLED',
  expired_empty: 'NO ENTRIES',
};

function qualityLabel(quality: number): string {
  return QUALITY_LABEL[quality] ?? `Q${quality}`;
}

function prizeLine(prize: GiveawayView['prizes'][number]): string {
  const tier = prize.openalbion_item_tier ? `${prize.openalbion_item_tier} · ` : '';
  return `• ${prize.openalbion_item_name} — ${tier}${qualityLabel(prize.openalbion_item_quality)} · ×${prize.quantity}`;
}

function endsTimestamp(giveaway: GiveawayView): number {
  return Math.floor(new Date(giveaway.ends_at).getTime() / 1000);
}

/** Builds the public giveaway card shown in the configured Discord channel. */
export function buildGiveawayEmbed(giveaway: GiveawayView | GiveawayDetailView): EmbedBuilder {
  const endsTs = endsTimestamp(giveaway);
  const status = STATUS_LABEL[giveaway.status] ?? giveaway.status.toUpperCase();
  const prizeLines = giveaway.prizes.map(prizeLine);
  if (giveaway.silver_amount && Number(giveaway.silver_amount) > 0) {
    prizeLines.push(`• ${formatSilver(giveaway.silver_amount)} silver (credited to Guild Bank)`);
  }
  if (prizeLines.length === 0) {
    prizeLines.push('• *No prizes listed.*');
  }

  const winner =
    giveaway.status === 'drawn'
      ? giveaway.winner_discord_id
        ? `<@${giveaway.winner_discord_id}>`
        : giveaway.winner_username ?? 'Unknown'
      : giveaway.status === 'expired_empty'
        ? '*No entries — giveaway closed.*'
        : giveaway.status === 'cancelled'
          ? '*Cancelled.*'
          : null;

  const lines = [
    giveaway.description?.trim() ? `*${giveaway.description.trim()}*` : null,
    '',
    `🏆 **Prizes**`,
    prizeLines.join('\n'),
    '',
    `👥 **Participants** — ${giveaway.entry_count}`,
    `⏰ **Ends** — <t:${endsTs}:F> (<t:${endsTs}:R>)`,
    `⚡ **Status** — ${status}`,
    `👑 **Hosted by** — ${giveaway.created_by_username}`,
    winner ? `🎉 **Winner** — ${winner}` : null,
  ].filter((line): line is string => line !== null);

  return createBaseEmbed({
    category: 'GIVEAWAY',
    title: `🎁 ${giveaway.title}`,
    description: lines.join('\n'),
    color: STATUS_COLOR[giveaway.status] ?? BOT_COLORS.BRAND,
    footerText: `Giveaway #${giveaway.id} • Weaklings Guild Manager`,
  });
}

/** Participate / Leave controls. Disabled once the giveaway is no longer open. */
export function buildGiveawayActionRow(
  giveaway: GiveawayView,
): ActionRowBuilder<ButtonBuilder> {
  const open = giveaway.status === 'open';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway:join:${giveaway.id}`)
      .setLabel('Participate')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`giveaway:leave:${giveaway.id}`)
      .setLabel('Leave')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!open),
  );
}

export interface GiveawayAnnouncementMessage {
  content?: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: []; roles?: string[] };
}

/** Channel payload: optional role ping plus the giveaway card. */
export function buildGiveawayAnnouncementMessage(
  giveaway: GiveawayView,
  roleId?: string | null,
): GiveawayAnnouncementMessage {
  const roleIds = roleId ? [roleId] : [];
  return {
    content: roleIds.length ? `|| <@&${roleIds[0]}> ||` : undefined,
    embeds: [buildGiveawayEmbed(giveaway)],
    components: [buildGiveawayActionRow(giveaway)],
    allowedMentions: roleIds.length ? { parse: [], roles: roleIds } : { parse: [] },
  };
}

/** Follow-up ping after a winner is drawn. */
export function buildGiveawayWinnerMessage(giveaway: GiveawayView): {
  content: string;
  allowedMentions: { parse: []; users: string[] };
} {
  const userId = giveaway.winner_discord_id;
  const mention = userId ? `<@${userId}>` : giveaway.winner_username ?? 'the winner';
  return {
    content: `🎉 ${mention} won **${giveaway.title}**!`,
    allowedMentions: { parse: [], users: userId ? [userId] : [] },
  };
}
