import { EmbedBuilder } from "discord.js";
import type {
  BattleGuildSummary,
  BattleOutcome,
  BattleSummary,
} from "../api/types.js";
import { BOT_COLORS, createBaseEmbed } from "./theme.js";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function kda(kills: number, deaths: number): string {
  const ratio = deaths === 0 ? kills : (kills / deaths).toFixed(2);
  return `${kills}K / ${deaths}D (${ratio})`;
}

function bar(value: number, max: number, width = 12): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return `${"█".repeat(Math.min(width, filled))}${"░".repeat(Math.max(0, width - filled))}`;
}

function chartLine(
  name: string,
  kills: number,
  deaths: number,
  maxKills: number,
  maxDeaths: number,
): string {
  return `${name.padEnd(16)} K ${bar(kills, maxKills)} ${kills}   D ${bar(deaths, maxDeaths)} ${deaths}`;
}

// ── Outcome e lato "nostro" (decisi dal backend, mai da nomi o env) ──────────

const OUTCOME_PRESENTATION: Record<
  BattleOutcome,
  { color: number; result: string; badge: string }
> = {
  victory: { color: BOT_COLORS.SUCCESS, result: "🏆 VICTORY", badge: "🏆 **WIN**" },
  defeat: { color: BOT_COLORS.DANGER, result: "💀 DEFEAT", badge: "💀 **LOSS**" },
  draw: { color: BOT_COLORS.WARNING, result: "⚖️ DRAW", badge: "⚖️ **DRAW**" },
  unknown: { color: BOT_COLORS.DARK, result: "❔ UNKNOWN", badge: "❔ **N/A**" },
};

/**
 * Presentation for the backend verdict. A battle without one is "unknown":
 * the bot must not guess a win or a loss.
 */
export function presentOutcome(battle: BattleSummary) {
  return OUTCOME_PRESENTATION[battle.outcome ?? "unknown"];
}

/** The tenant's own guild, else the first friendly one (alliance tenants have none). */
export function ourSide(battle: BattleSummary): BattleGuildSummary | undefined {
  return (
    battle.guilds.find((g) => g.is_own) ?? battle.guilds.find((g) => g.is_friendly)
  );
}

// ── Embed singola battaglia ──────────────────────────────────────────────────

export function buildBattleEmbed(battle: BattleSummary): EmbedBuilder {
  const guildSide = ourSide(battle);
  const { color, result: resultStr } = presentOutcome(battle);

  const start = new Date(battle.start_time);
  const end = new Date(battle.end_time);
  const durationMs = end.getTime() - start.getTime();
  const durationStr =
    durationMs < 3600000
      ? `${Math.round(durationMs / 60000)}m`
      : `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`;

  const ts = Math.floor(start.getTime() / 1000);

  const embed = createBaseEmbed({
    category: "BATTLE REPORT",
    title: `${resultStr} — <t:${ts}:F>`,
    description: `*⏱️ Duration: ${durationStr} · 💀 Total Battle Kills: ${fmt(battle.total_kills)}*`,
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
      ].join("\n"),
      inline: true,
    });
  }

  // Opponents (max 3 to keep the layout compact)
  const opponents = battle.guilds
    .filter((g) => !g.is_friendly)
    .sort((a, b) => b.kill_fame - a.kill_fame)
    .slice(0, 3);
  const chartGuilds = guildSide ? [guildSide, ...opponents] : opponents;
  const maxKills = Math.max(...chartGuilds.map((g) => g.kills), 0);
  const maxDeaths = Math.max(...chartGuilds.map((g) => g.deaths), 0);
  const maxFame = Math.max(...chartGuilds.map((g) => g.kill_fame), 0);
  const codeFence = "```";

  if (chartGuilds.length > 0) {
    embed.addFields({
      name: "⚔️ K/D BREAKDOWN",
      value: `${codeFence}\n${chartGuilds
        .map((g) => chartLine(g.name, g.kills, g.deaths, maxKills, maxDeaths))
        .join("\n")}\n${codeFence}`,
      inline: false,
    });

    embed.addFields({
      name: "⭐ KILL FAME",
      value: `${codeFence}\n${chartGuilds
        .map((g) => `${g.name.padEnd(16)} ${bar(g.kill_fame, maxFame)} ${fmt(g.kill_fame)}`)
        .join("\n")}\n${codeFence}`,
      inline: false,
    });
  }

  if (opponents.length > 0) {
    const lines = opponents.map(
      (g) => `• ⚔️ **${g.name}** · ${kda(g.kills, g.deaths)} · ${fmt(g.kill_fame)} fame`,
    );
    embed.addFields({
      name: "💀 Top Opponents",
      value: lines.join("\n"),
      inline: true,
    });
  }

  return embed;
}

// ── Embed lista battaglie ────────────────────────────────────────────────────

export function buildBattleListEmbed(
  battles: BattleSummary[],
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = createBaseEmbed({
    category: "BATTLE LOGS",
    title: "🗡️ Recent Guild Battles",
    color: BOT_COLORS.BRAND,
    footerText: `Page ${page} of ${totalPages} • Weaklings Guild Manager`,
  });

  if (battles.length === 0) {
    embed.setDescription("*No recent battles found.*");
    return embed;
  }

  const lines = battles.map((b) => {
    const guildSide = ourSide(b);
    const badge = presentOutcome(b).badge;
    const ts = Math.floor(new Date(b.start_time).getTime() / 1000);
    const kd = guildSide ? `${guildSide.kills}K / ${guildSide.deaths}D` : "—";
    const fame = guildSide ? fmt(guildSide.kill_fame) : "—";
    return `${badge} **#${b.battle_id}** · <t:${ts}:d> · ⚔️ ${kd} · ⭐ ${fame} fame`;
  });

  embed.setDescription(lines.join("\n\n"));
  return embed;
}
