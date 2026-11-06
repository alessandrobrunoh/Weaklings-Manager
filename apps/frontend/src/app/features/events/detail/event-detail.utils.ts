import type { EventBattleSummary, EventFight, SplitSummary } from '../../../core/models/api.models';

/** Outcome and headline numbers for one Fight, derived from its linked battle segments. */
export interface FightKpis {
  readonly outcome: 'victory' | 'defeat' | 'draw' | 'unknown';
  readonly segments: number;
  readonly players: number | null;
  readonly kills: number | null;
  readonly fame: number | null;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

export function formatAmount(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString();
}

export function netOfSplit(split: SplitSummary): number {
  if (split.net_value !== null && split.net_value !== undefined) {
    return Number(split.net_value);
  }
  return (
    Number(split.estimated_market_value) - Number(split.repair_value) + Number(split.bags_value)
  );
}

export function formatCompact(value: number): string {
  return Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatRatio(value: number): string {
  return value.toFixed(2);
}

export function fightOutcomeLabel(outcome: FightKpis['outcome']): string {
  return outcome.toUpperCase();
}

export function fightMetrics(fight: EventFight, battles: readonly EventBattleSummary[]): FightKpis {
  const linkedBattles = battles.filter((battle) =>
    fight.battle_ids.includes(battle.albionbb_battle_id),
  );
  const playerCounts = linkedBattles
    .map((battle) => battle.battle_total_players)
    .filter((players): players is number => players !== null);
  const hasLinkedBattles = linkedBattles.length > 0;
  // Every segment of the same Fight reports the same outcome (Fase 0-5 resolves it at the
  // Fight level, not per raw battle segment), so the first linked segment's value is enough —
  // no need to reconcile several booleans any more.
  const fallbackOutcome = linkedBattles[0]?.outcome ?? 'unknown';

  return {
    outcome: fight.outcome?.outcome ?? fallbackOutcome,
    segments: fight.segment_count ?? fight.battle_ids.length,
    players:
      fight.total_players ??
      fight.stats?.total_players ??
      (playerCounts.length > 0 ? Math.max(...playerCounts) : null),
    kills:
      fight.total_kills ??
      fight.stats?.total_kills ??
      (hasLinkedBattles
        ? linkedBattles.reduce((total, battle) => total + battle.guild_kills, 0)
        : null),
    fame:
      fight.total_fame ??
      fight.stats?.total_fame ??
      fight.stats?.total_kill_fame ??
      fight.stats?.kill_fame ??
      (hasLinkedBattles
        ? linkedBattles.reduce((total, battle) => total + battle.guild_kill_fame, 0)
        : null),
  };
}
