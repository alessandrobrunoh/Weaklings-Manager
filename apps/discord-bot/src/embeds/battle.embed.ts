import { EmbedBuilder } from 'discord.js';
import type { BattleSummary } from '../api/types.js';

const WIN_COLOR  = 0x57f287; // Verde
const LOSS_COLOR = 0xed4245; // Rosso
const LIST_COLOR = 0x2b2d31; // Grigio scuro Discord

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function kda(kills: number, deaths: number): string {
  const ratio = deaths === 0 ? kills : (kills / deaths).toFixed(2);
  return `${kills}K / ${deaths}D (${ratio})`;
}

// ── Embed singola battaglia ──────────────────────────────────────────────────

export function buildBattleEmbed(battle: BattleSummary, guildName: string): EmbedBuilder {
  const guildSide = battle.guilds.find((g) => g.name === guildName);
  const isWin     = guildSide?.winner ?? false;
  const color     = isWin ? WIN_COLOR : LOSS_COLOR;
  const result    = isWin ? 'Victory' : 'Defeat';

  const start      = new Date(battle.start_time);
  const end        = new Date(battle.end_time);
  const durationMs = end.getTime() - start.getTime();
  const durationStr = durationMs < 3600000
    ? `${Math.round(durationMs / 60000)}m`
    : `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `Battle Report — ${result}` })
    .setTitle(`<t:${Math.floor(start.getTime() / 1000)}:F>`)
    .setFooter({
      text: `Battle #${battle.battle_id} · ${durationStr} · ${fmt(battle.total_kills)} total kills`,
    })
    .setTimestamp(start);

  // Guild stats
  if (guildSide) {
    embed.addFields({
      name: guildSide.name,
      value: [
        `**K/D:** ${kda(guildSide.kills, guildSide.deaths)}`,
        `**Players:** ${guildSide.players}`,
        `**Fame:** ${fmt(guildSide.kill_fame)}`,
      ].join('\n'),
      inline: true,
    });
  }

  // Opponents (max 3 per stare nello spazio)
  const opponents = battle.guilds
    .filter((g) => g.name !== guildName)
    .sort((a, b) => b.kill_fame - a.kill_fame)
    .slice(0, 3);

  if (opponents.length > 0) {
    const lines = opponents.map(
      (g) => `**${g.name}**\nK/D: ${kda(g.kills, g.deaths)} · ${fmt(g.kill_fame)} fame`,
    );
    embed.addFields({
      name: 'Opponents',
      value: lines.join('\n\n'),
      inline: true,
    });
  }

  return embed;
}

// ── Embed lista battaglie ────────────────────────────────────────────────────

export function buildBattleListEmbed(
  battles: BattleSummary[],
  guildName: string,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(LIST_COLOR)
    .setTitle('Recent Battles')
    .setFooter({ text: `Page ${page} of ${totalPages}` })
    .setTimestamp();

  if (battles.length === 0) {
    embed.setDescription('*No battles found.*');
    return embed;
  }

  const lines = battles.map((b) => {
    const guildSide = b.guilds.find((g) => g.name === guildName);
    const result    = guildSide?.winner ? '`WIN `' : '`LOSS`';
    const ts        = Math.floor(new Date(b.start_time).getTime() / 1000);
    const kd        = guildSide ? `${guildSide.kills}K / ${guildSide.deaths}D` : '—';
    const fame      = guildSide ? fmt(guildSide.kill_fame) : '—';
    return `${result} **#${b.battle_id}** · <t:${ts}:d> · ${kd} · ${fame} fame`;
  });

  embed.setDescription(lines.join('\n'));
  return embed;
}
