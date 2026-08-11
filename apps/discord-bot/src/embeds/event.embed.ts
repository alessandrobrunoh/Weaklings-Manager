import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { EventView, EventDetailView } from '../api/types.js';

// ── Colori per stato evento ──────────────────────────────────────────────────
const STATUS_COLOR: Record<string, number> = {
  scheduled: 0x5865f2, // Blurple
  live:       0x57f287, // Verde
  stopped:    0x4f545c, // Grigio scuro
  auto_stopped: 0xfee75c, // Giallo
};

const STATUS_LABEL: Record<string, string> = {
  scheduled:    'Scheduled',
  live:         'LIVE',
  stopped:      'Stopped',
  auto_stopped: 'Auto-stopped',
};

// ── Embed dettaglio evento ───────────────────────────────────────────────────

export function buildEventEmbed(event: EventView | EventDetailView): EmbedBuilder {
  const color  = STATUS_COLOR[event.status] ?? 0x5865f2;
  const status = STATUS_LABEL[event.status] ?? event.status;
  const date   = new Date(event.event_date_utc);
  const ts     = Math.floor(date.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: 'Guild Event' })
    .setTitle(event.title)
    .addFields(
      { name: 'Status',       value: `\`${status}\``,           inline: true },
      { name: 'Composition',  value: event.comp_name,           inline: true },
      { name: 'Date',         value: `<t:${ts}:F>`,             inline: false },
      { name: 'Created by',   value: event.created_by_username, inline: true },
    )
    .setFooter({ text: `Event #${event.id}` })
    .setTimestamp(date);

  if (event.description) {
    embed.setDescription(event.description);
  }

  // Se è un EventDetailView con partecipanti, mostriamo la lista
  const detail = event as EventDetailView;
  if (detail.participants?.length > 0) {
    const buildCounts: Record<string, number> = {};
    for (const p of detail.participants) {
      buildCounts[p.primary_build_name] = (buildCounts[p.primary_build_name] || 0) + 1;
    }

    const lines = Object.entries(buildCounts)
      .map(([buildName, count]) => `**${count}**x ${buildName}`)
      .join('\n');

    embed.addFields({
      name: `Roster (${detail.participants.length}/${detail.active_comp_capacity})`,
      value: lines,
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
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Guild Events')
    .setFooter({ text: `Page ${page} of ${totalPages}` })
    .setTimestamp();

  if (events.length === 0) {
    embed.setDescription('*No events found.*');
    return embed;
  }

  const lines = events.map((e) => {
    const ts     = Math.floor(new Date(e.event_date_utc).getTime() / 1000);
    const status = STATUS_LABEL[e.status] ?? e.status;
    return [
      `**[#${e.id}] ${e.title}**`,
      `\`${status}\` · ${e.comp_name} · <t:${ts}:R>`,
    ].join('\n');
  });

  embed.setDescription(lines.join('\n\n'));
  return embed;
}

// ── Bottoni partecipazione evento ────────────────────────────────────────────

export function buildEventActionRows(
  eventId: number,
): [ActionRowBuilder<ButtonBuilder>, ActionRowBuilder<ButtonBuilder>] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:healer`)
      .setLabel('Healer')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:tank`)
      .setLabel('Tank')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:dps`)
      .setLabel('DPS')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:support`)
      .setLabel('Support')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:battle_mount`)
      .setLabel('Battle Mount')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`event:join:${eventId}:brawler`)
      .setLabel('Brawler')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`event:leave:${eventId}`)
      .setLabel('Leave Event')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2];
}
