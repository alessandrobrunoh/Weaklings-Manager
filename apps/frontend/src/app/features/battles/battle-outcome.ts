import type { TranslationKey } from '../../i18n/en';

/**
 * The outcome vocabulary the backend serializes.
 *
 * `contested` is not in it: it was the old label for a draw and is still
 * accepted as a filter value by `GET /api/battles`, but nothing renders it any
 * more.
 */
export type BattleOutcomeType = 'victory' | 'defeat' | 'draw' | 'unknown';

const OUTCOME_LABELS: Record<BattleOutcomeType, TranslationKey> = {
  victory: 'battles.victory',
  defeat: 'battles.defeat',
  draw: 'battles.draw',
  unknown: 'battles.unknown',
};

/**
 * Translation key for an outcome the backend already decided.
 *
 * This file used to *compute* the outcome, aggregating our alliance against its
 * own 45%/40%/30% fame thresholds. The backend had two more rules of its own,
 * so one battle could read "Victory" in the list and "Contested" on its detail
 * page. The single rule now lives in `modules::battles::outcome` and every
 * surface renders what it returns — a browser that scores battles by itself is
 * a third opinion nobody asked for.
 */
export function battleOutcomeLabel(outcome: BattleOutcomeType | null | undefined): TranslationKey {
  return OUTCOME_LABELS[outcome ?? 'unknown'];
}
