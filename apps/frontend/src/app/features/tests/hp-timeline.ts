import type { ScenarioResult } from '../../core/models/api.models';

/** One point on the HP-over-time chart: total HP remaining on each side at `time` seconds. */
export interface HpOverTimePoint {
  readonly time: number;
  readonly allyHp: number;
  readonly enemyHp: number;
}

/**
 * Reconstructs total HP per side over the burst window from an already-resolved
 * {@link ScenarioResult} — no backend call needed, this replays data the run already returned.
 *
 * Mirrors the backend's own bookkeeping exactly (`combat::scenario::apply_health_change`): each
 * unit's running HP is `starting_hp - damage_taken + healing_received`, floored at `0` and never
 * capped back down at `starting_hp` — a heal can only ever raise a unit's tracked HP, the same
 * asymmetry the engine itself has. `result.casts` is already sorted by `land_at`, so replaying it
 * in order reproduces the same timeline the run computed.
 *
 * Starts with one point at `t = 0` holding the starting totals, so a chart's line begins flat
 * before the first cast lands rather than jumping in from nothing.
 */
export function hpOverTimeSeries(result: ScenarioResult): HpOverTimePoint[] {
  const hp = new Map<string, { side: 'ally' | 'enemy'; value: number }>();
  let allyTotal = 0;
  let enemyTotal = 0;
  for (const unit of result.units) {
    hp.set(unit.id, { side: unit.side, value: unit.starting_hp });
    if (unit.side === 'ally') {
      allyTotal += unit.starting_hp;
    } else {
      enemyTotal += unit.starting_hp;
    }
  }

  const points: HpOverTimePoint[] = [{ time: 0, allyHp: allyTotal, enemyHp: enemyTotal }];

  for (const cast of result.casts) {
    for (const targetId of cast.target_ids) {
      const unit = hp.get(targetId);
      if (!unit) continue;
      const next = Math.max(0, unit.value + cast.per_target_health_change);
      const delta = next - unit.value;
      unit.value = next;
      if (unit.side === 'ally') {
        allyTotal += delta;
      } else {
        enemyTotal += delta;
      }
    }
    points.push({ time: cast.land_at, allyHp: allyTotal, enemyHp: enemyTotal });
  }

  return points;
}
