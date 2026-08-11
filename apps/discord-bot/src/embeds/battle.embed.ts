import { EmbedBuilder } from 'discord.js';
import type { BattleSummary } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from './theme.js';

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
  const color     = isWin ? BOT_COLORS.SUCCESS : BOT_COLORS.DANGER;
  const resultStr = isWin ? '🏆 VICTORY' : '💀 DEFEAT';

  const start      = new Date(battle.start_time);
  const end        = new Date(battle.end_time);
  const durationMs = end.getTime() - start.getTime();
  const durationStr = durationMs < 3600000
    ? `${Math.round(durationMs / 60000)}m`
    : `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`;

  const ts = Math.floor(start.getTime() / 1000);

  const embed = createBaseEmbed({
    category: 'BATTLE REPORT',
    title: `${resultStr} — <t:${ts}:F>`,
    description: `*Duration: ${durationStr} · Total Kills: ${fmt(battle.total_kills)}*`,
    color,
    footerText: `Battle #${battle.battle_id} • Weaklings Guild Manager`,
  });

  // Guild stats
  if (guildSide) {
    embed.addFields({
      name: `🛡️ ${guildSide.name}`,
      value: [
        `• ⚔️ **K/D Ratio:** ${kda(guildSide.kills, guildSide.deaths)}`,
        `• 👥 **Active Players:** ${guildSide.players}`,
        `• ⭐ **Kill Fame:** ${fmt(guildSide.kill_fame)}`,
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
      (g) => `• ⚔️ **${g.name}**\n  - K/D: ${kda(g.kills, g.deaths)} · ${fmt(g.kill_fame)} fame`,
    );
    embed.addFields({
      name: '💀 Top Opponents',
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
  const embed = createBaseEmbed({
    category: 'BATTLE LOGS',
    title: '🗡️ Recent Guild Battles',
    color: BOT_COLORS.BRAND,
    footerText: `Page ${page} of ${totalPages} • Weaklings Guild Manager`,
  });

  if (battles.length === 0) {
    embed.setDescription('*No recent battles found.*');
    return embed;
  }

  const lines = battles.map((b) => {
    const guildSide = b.guilds.find((g) => g.name === guildName);
    const badge     = guildSide?.winner ? '🏆 **WIN**' : '💀 **LOSS**';
    const ts        = Math.floor(new Date(b.start_time).getTime() / 1000);
    const kd        = guildSide ? `${guildSide.kills}K / ${guildSide.deaths}D` : '—';
    const fame      = guildSide ? fmt(guildSide.kill_fame) : '—';
    return `${badge} **#${b.battle_id}** · <t:${ts}:d> · ⚔️ ${kd} · ⭐ ${fame} fame`;
  });

  embed.setDescription(lines.join('\n\n'));
  return embed;
}
