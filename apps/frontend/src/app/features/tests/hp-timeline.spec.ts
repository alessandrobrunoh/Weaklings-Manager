import { describe, expect, it } from 'vitest';

import type { ScenarioResult, ScenarioResolvedCastLog, ScenarioUnitOutcome } from '../../core/models/api.models';
import { hpOverTimeSeries } from './hp-timeline';

function unit(
  id: string,
  side: 'ally' | 'enemy',
  starting_hp: number,
  overrides: Partial<ScenarioUnitOutcome> = {},
): ScenarioUnitOutcome {
  return {
    id,
    group_id: id,
    group_label: id,
    side,
    starting_hp,
    damage_taken: 0,
    healing_received: 0,
    remaining_hp: starting_hp,
    died_at: null,
    ...overrides,
  };
}

function cast(
  target_ids: string[],
  per_target_health_change: number,
  land_at = 0,
  overrides: Partial<ScenarioResolvedCastLog> = {},
): ScenarioResolvedCastLog {
  return {
    caster_group_id: 'caster',
    spell_id: 'SPELL',
    land_at,
    target_ids,
    concurrent_attackers: 1,
    prior_cc_stacks: 0,
    escalation_multiplier: 1,
    focus_fire_reduction: 0,
    per_target_health_change,
    crowd_control: [],
    unsupported: [],
    ...overrides,
  };
}

function result(units: ScenarioUnitOutcome[], casts: ScenarioResolvedCastLog[]): ScenarioResult {
  return {
    units,
    casts,
    total_damage_dealt: 0,
    total_healing_done: 0,
    deaths: 0,
    average_time_to_kill: null,
    overkill_ratio: 0,
    unknown_spells: [],
    casts_with_no_targets: [],
  };
}

describe('hpOverTimeSeries', () => {
  it('returns a single flat point at the starting totals when there are no casts', () => {
    const points = hpOverTimeSeries(
      result([unit('ally-1', 'ally', 1200), unit('enemy-1', 'enemy', 800)], []),
    );
    expect(points).toEqual([{ time: 0, allyHp: 1200, enemyHp: 800 }]);
  });

  it('drops the losing side to 0 and holds it there from a lethal hit onward', () => {
    const points = hpOverTimeSeries(
      result(
        [unit('ally-1', 'ally', 1200), unit('enemy-1', 'enemy', 50)],
        [cast(['enemy-1'], -66.6, 0.4)],
      ),
    );
    expect(points).toEqual([
      { time: 0, allyHp: 1200, enemyHp: 50 },
      { time: 0.4, allyHp: 1200, enemyHp: 0 },
    ]);
  });

  it('lets a heal raise a side total back up', () => {
    const points = hpOverTimeSeries(
      result(
        [unit('enemy-1', 'enemy', 1000)],
        [cast(['enemy-1'], -400, 1), cast(['enemy-1'], 250, 2)],
      ),
    );
    expect(points).toEqual([
      { time: 0, allyHp: 0, enemyHp: 1000 },
      { time: 1, allyHp: 0, enemyHp: 600 },
      { time: 2, allyHp: 0, enemyHp: 850 },
    ]);
  });

  it('tracks ally and enemy totals independently', () => {
    const points = hpOverTimeSeries(
      result(
        [unit('ally-1', 'ally', 500), unit('enemy-1', 'enemy', 500)],
        [cast(['ally-1'], -100, 1)],
      ),
    );
    expect(points).toEqual([
      { time: 0, allyHp: 500, enemyHp: 500 },
      { time: 1, allyHp: 400, enemyHp: 500 },
    ]);
  });

  it('emits one point per cast even when several land at the same time', () => {
    const points = hpOverTimeSeries(
      result(
        [unit('enemy-1', 'enemy', 1000), unit('enemy-2', 'enemy', 1000)],
        [cast(['enemy-1'], -300, 2), cast(['enemy-2'], -200, 2)],
      ),
    );
    expect(points).toEqual([
      { time: 0, allyHp: 0, enemyHp: 2000 },
      { time: 2, allyHp: 0, enemyHp: 1700 },
      { time: 2, allyHp: 0, enemyHp: 1500 },
    ]);
  });

  it('ignores a target id that is not a known unit rather than crashing', () => {
    const points = hpOverTimeSeries(
      result([unit('enemy-1', 'enemy', 1000)], [cast(['ghost'], -500, 1)]),
    );
    expect(points).toEqual([
      { time: 0, allyHp: 0, enemyHp: 1000 },
      { time: 1, allyHp: 0, enemyHp: 1000 },
    ]);
  });
});
