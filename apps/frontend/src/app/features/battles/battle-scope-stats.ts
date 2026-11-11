import type { FightListItem } from '../../core/models/api.models';

/** Headline numbers of the Battles page, summed over the rows currently loaded (one page). */
export interface BattleScopeStats {
  readonly battles: number;
  /** Personal tab: matched battles. Guild tab: unused (see `peakPlayers`). */
  readonly players: number;
  /** Guild tab: players in the largest fight on the page; summing fights would count people twice. */
  readonly peakPlayers: number;
  readonly kills: number;
  readonly deaths: number;
  readonly fame: number;
  readonly victories: number;
  readonly defeats: number;
}

export function emptyScopeStats(): BattleScopeStats {
  return {
    battles: 0,
    players: 0,
    peakPlayers: 0,
    kills: 0,
    deaths: 0,
    fame: 0,
    victories: 0,
    defeats: 0,
  };
}

/** Folds the fights of the current page into scope stats. Deaths are used when the API sends them. */
export function buildGuildScopeStats(fights: readonly FightListItem[]): BattleScopeStats {
  return fights.reduce<BattleScopeStats>(
    (stats, fight) => ({
      ...stats,
      battles: stats.battles + 1,
      peakPlayers: Math.max(stats.peakPlayers, fight.total_players),
      kills: stats.kills + fight.total_kills,
      deaths: stats.deaths + (fight.total_deaths ?? 0),
      fame: stats.fame + fight.total_fame,
      victories: stats.victories + (fight.outcome.outcome === 'victory' ? 1 : 0),
      defeats: stats.defeats + (fight.outcome.outcome === 'defeat' ? 1 : 0),
    }),
    emptyScopeStats(),
  );
}
