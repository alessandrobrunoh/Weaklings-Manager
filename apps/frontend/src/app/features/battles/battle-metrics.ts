/**
 * Display helpers for fight/battle statistics, shared by the Battles, Fights and Event pages.
 *
 * Scales, as the API serializes them:
 * - `grouping_confidence` is a 0..1 fraction.
 * - every `win_rate` is a percentage in 0..100.
 */

/** Renders a 0..1 `grouping_confidence` as a whole percentage (0.93 -> "93%"). */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const clamped = Math.min(1, Math.max(0, value));
  return `${Math.round(clamped * 100)}%`;
}

/** Fights that count towards a win rate: draws and unknown outcomes are not decided. */
export function decidedFights(wins: number, losses: number): number {
  return Math.max(0, wins) + Math.max(0, losses);
}

/**
 * The one win-rate definition: wins / (wins + losses), as a 0..100 percentage.
 * `null` when nothing was decided, so the UI shows "no data" instead of 0%.
 */
export function winRatePercent(wins: number, losses: number): number | null {
  const decided = decidedFights(wins, losses);
  if (decided === 0) return null;
  return (Math.max(0, wins) / decided) * 100;
}

/** Fights excluded from the win rate (draws and unknown outcomes). */
export function undecidedFights(totalFights: number, wins: number, losses: number): number {
  return Math.max(0, totalFights - Math.max(0, wins) - Math.max(0, losses));
}

/** Public Albion Battles page of a battle (same battle id as AlbionBB; the link the app used before). */
export function albionBattlesUrl(battleId: string | number): string {
  return `https://albionbattles.com/battles/${encodeURIComponent(String(battleId))}`;
}
