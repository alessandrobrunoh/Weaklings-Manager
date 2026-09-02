import type { BattleGuildSummary } from '../../core/models/api.models';

export type BattleOutcomeType = 'victory' | 'defeat' | 'contested';

export interface BattleOutcomeInput {
  readonly guilds: readonly BattleGuildSummary[];
  readonly totalFame: number;
  readonly ourGuildName: string;
}

/**
 * Single source of truth for "did we win this battle".
 *
 * Both the battles list and the battle detail page call this, so the same
 * battle can never read "Victory" in one place and "Contested" in the other
 * — they previously used different guild scopes (a single guild vs. an
 * alliance) and different fame-share thresholds.
 *
 * Aggregates every guild sharing our guild's alliance (or just our guild, if
 * it fought solo) and classifies the outcome from the combined kills/deaths
 * and share of the battle's total fame.
 */
export function resolveBattleOutcome({
  guilds,
  totalFame,
  ourGuildName,
}: BattleOutcomeInput): BattleOutcomeType {
  const ourName = ourGuildName.toLowerCase();
  const ourGuild = guilds.find((g) => g.name.toLowerCase() === ourName);
  if (!ourGuild) {
    return 'contested';
  }

  const ourAllianceName = ourGuild.alliance_name?.trim() || null;
  const ourGuilds = ourAllianceName
    ? guilds.filter((g) => (g.alliance_name?.trim() || null) === ourAllianceName)
    : [ourGuild];

  const kills = ourGuilds.reduce((sum, g) => sum + g.kills, 0);
  const deaths = ourGuilds.reduce((sum, g) => sum + g.deaths, 0);
  const fame = ourGuilds.reduce((sum, g) => sum + g.kill_fame, 0);
  const isWinner = ourGuilds.some((g) => g.winner) || (totalFame > 0 && fame >= totalFame * 0.45);

  if (isWinner || (kills > deaths && totalFame > 0 && fame >= totalFame * 0.4)) {
    return 'victory';
  }
  if (deaths > kills && totalFame > 0 && fame < totalFame * 0.3) {
    return 'defeat';
  }
  return 'contested';
}
