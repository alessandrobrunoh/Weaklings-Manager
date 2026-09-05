import { describe, expect, it } from 'vitest';

import type {
  ScenarioDeclaredCast,
  ScenarioDefinition,
  ScenarioResolvedCastLog,
  ScenarioResult,
  ScenarioUnitGroup,
  ScenarioUnitOutcome,
} from '../../../core/models/api.models';
import {
  CLIP_WIDTH,
  MIN_DURATION,
  assignClipRows,
  buildLanes,
  hpSegmentsFor,
  laneIndexAtY,
  logsTargeting,
  matchLandTimes,
  neverTargetedUnitIds,
  normalizeCast,
  normalizeDefinition,
  orphanClips,
  parseCooldownSeconds,
  secondsToX,
  snapSeconds,
  spellIdsOf,
  tickMarks,
  timelineDuration,
  unitIdsOf,
  xToSeconds,
} from './scenario-timeline';

function group(id: string, overrides: Partial<ScenarioUnitGroup> = {}): ScenarioUnitGroup {
  return { id, side: 'ally', label: id, item_id: null, count: 1, hit_points: 1200, ...overrides };
}

function cast(
  casterGroupId: string,
  spellId: string,
  castAt: number,
  overrides: Partial<ScenarioDeclaredCast> = {},
): ScenarioDeclaredCast {
  return {
    caster_group_id: casterGroupId,
    spell_id: spellId,
    cast_at: castAt,
    target_ids: [],
    attacker_style: 'melee',
    ...overrides,
  };
}

function definition(
  groups: ScenarioUnitGroup[],
  casts: ScenarioDeclaredCast[] = [],
): ScenarioDefinition {
  return { groups, casts };
}

function log(
  casterGroupId: string,
  spellId: string,
  landAt: number,
  targetIds: string[],
  change: number,
): ScenarioResolvedCastLog {
  return {
    caster_group_id: casterGroupId,
    spell_id: spellId,
    land_at: landAt,
    target_ids: targetIds,
    concurrent_attackers: 1,
    prior_cc_stacks: 0,
    escalation_multiplier: 1,
    focus_fire_reduction: 0,
    per_target_health_change: change,
    crowd_control: [],
    unsupported: [],
  };
}

function unit(id: string, overrides: Partial<ScenarioUnitOutcome> = {}): ScenarioUnitOutcome {
  return {
    id,
    group_id: id.split('#')[0],
    group_label: id.split('#')[0],
    side: 'enemy',
    starting_hp: 1200,
    damage_taken: 0,
    healing_received: 0,
    remaining_hp: 1200,
    died_at: null,
    ...overrides,
  };
}

function result(
  units: ScenarioUnitOutcome[],
  casts: ScenarioResolvedCastLog[] = [],
): ScenarioResult {
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

describe('snapSeconds', () => {
  it('rounds onto the tenth-of-a-second grid', () => {
    expect(snapSeconds(1.234)).toBe(1.2);
    expect(snapSeconds(0.15)).toBe(0.2);
  });

  it('clamps at zero and survives a non-finite input', () => {
    expect(snapSeconds(-3)).toBe(0);
    expect(snapSeconds(Number.NaN)).toBe(0);
  });

  it('leaves no float dust behind, so dirty() stays a stable string compare', () => {
    expect(snapSeconds(0.1 + 0.2)).toBe(0.3);
    expect(String(snapSeconds(1.1 + 0.1))).toBe('1.2');
    expect(JSON.stringify({ cast_at: snapSeconds(1.1 + 0.1) })).toBe('{"cast_at":1.2}');
  });

  it('still trims float dust when snapping is suppressed', () => {
    expect(snapSeconds(1.1 + 0.1, false)).toBe(1.2);
  });
});

describe('secondsToX / xToSeconds', () => {
  it('round-trips at every zoom level', () => {
    for (const pxPerSecond of [20, 40, 80, 160, 320]) {
      expect(xToSeconds(secondsToX(3.7, pxPerSecond), pxPerSecond)).toBeCloseTo(3.7, 10);
    }
  });

  it('answers zero rather than dividing by zero', () => {
    expect(xToSeconds(100, 0)).toBe(0);
  });
});

describe('unitIdsOf', () => {
  it('expands a group into one id per unit', () => {
    expect(unitIdsOf(definition([group('g', { count: 3 })]))).toEqual(['g#0', 'g#1', 'g#2']);
  });

  it('treats an absent or zero count as one unit, like the engine does', () => {
    expect(unitIdsOf(definition([group('g', { count: undefined })]))).toEqual(['g#0']);
    expect(unitIdsOf(definition([group('g', { count: 0 })]))).toEqual(['g#0']);
  });
});

describe('normalizeCast / normalizeDefinition', () => {
  it('gives two equal casts the same serialisation regardless of key order', () => {
    const a: ScenarioDeclaredCast = {
      caster_group_id: 'g',
      spell_id: 'S',
      cast_at: 1,
      target_ids: ['g#1', 'g#0'],
      attacker_style: 'melee',
    };
    const b = {
      attacker_style: 'melee',
      target_ids: ['g#0', 'g#1'],
      cast_at: 1,
      spell_id: 'S',
      caster_group_id: 'g',
    } as ScenarioDeclaredCast;
    expect(JSON.stringify(normalizeCast(a))).toBe(JSON.stringify(normalizeCast(b)));
  });

  it('fills in the attacker style the server may omit', () => {
    const bare = { caster_group_id: 'g', spell_id: 'S', cast_at: 0, target_ids: [] };
    expect(normalizeCast(bare as ScenarioDeclaredCast).attacker_style).toBe('melee');
  });

  it('normalises a definition loaded from the server the same as one built locally', () => {
    const loaded = {
      groups: [{ id: 'g', side: 'ally', label: 'g' } as ScenarioUnitGroup],
      casts: [{ caster_group_id: 'g', spell_id: 'S', cast_at: 0, target_ids: [] }],
    } as ScenarioDefinition;
    const local = definition([group('g')], [cast('g', 'S', 0)]);
    expect(JSON.stringify(normalizeDefinition(loaded))).toBe(
      JSON.stringify(normalizeDefinition(local)),
    );
  });
});

describe('timelineDuration', () => {
  it('never goes below the minimum', () => {
    expect(timelineDuration(definition([]))).toBe(MIN_DURATION);
  });

  it('leaves room to the right of the last cast', () => {
    expect(timelineDuration(definition([group('g')], [cast('g', 'S', 14.2)]))).toBe(17);
  });

  it('grows under an in-flight drag', () => {
    expect(timelineDuration(definition([]), null, 20)).toBe(22);
  });

  it('covers a run that outlives the declared casts', () => {
    const run = result([unit('g#0', { died_at: 19.4 })], [log('g', 'S', 19.4, ['g#0'], -1200)]);
    expect(timelineDuration(definition([group('g')], [cast('g', 'S', 1)]), run)).toBe(22);
  });
});

describe('tickMarks', () => {
  it('picks a coarse step when zoomed out and a fine one when zoomed in', () => {
    const coarse = tickMarks(30, 20).filter((mark) => mark.major).map((mark) => mark.seconds);
    expect(coarse.slice(0, 3)).toEqual([0, 5, 10]);
    const fine = tickMarks(10, 320).filter((mark) => mark.major).map((mark) => mark.seconds);
    expect(fine.slice(0, 3)).toEqual([0, 0.25, 0.5]);
  });

  it('starts at zero and never runs past the duration', () => {
    const marks = tickMarks(10, 80);
    expect(marks[0]).toEqual({ seconds: 0, major: true });
    expect(marks[marks.length - 1].seconds).toBeLessThanOrEqual(10);
  });
});

describe('assignClipRows', () => {
  it('stacks casts declared at the same instant', () => {
    expect(assignClipRows([{ cast_at: 2 }, { cast_at: 2 }], 80)).toEqual([0, 1]);
  });

  it('reuses row zero once there is room again', () => {
    expect(assignClipRows([{ cast_at: 2 }, { cast_at: 2 }, { cast_at: 7 }], 80)).toEqual([0, 1, 0]);
  });

  it('separates a stack as the zoom grows, since collision is measured in pixels', () => {
    const oneSecondApart = [{ cast_at: 1 }, { cast_at: 2 }];
    expect(assignClipRows(oneSecondApart, 20)).toEqual([0, 1]);
    expect(assignClipRows(oneSecondApart, 320)).toEqual([0, 0]);
  });
});

describe('buildLanes / orphanClips', () => {
  const def = definition(
    [group('a'), group('b', { side: 'enemy', count: 2 })],
    [cast('a', 'S1', 0), cast('b', 'S2', 1), cast('gone', 'S3', 2)],
  );

  it('gives each group its own casts, addressed by their index in the definition', () => {
    const lanes = buildLanes(def, 80);
    expect(lanes.map((lane) => lane.clips.map((clip) => clip.castIndex))).toEqual([[0], [1]]);
    expect(lanes[1].unitIds).toEqual(['b#0', 'b#1']);
  });

  it('places a clip at its own time', () => {
    expect(buildLanes(def, 80)[1].clips[0].x).toBe(secondsToX(1, 80));
  });

  it('collects casts whose caster group no longer exists', () => {
    expect(orphanClips(def, 80).map((clip) => clip.castIndex)).toEqual([2]);
  });

  it('keeps lanes distinguishable when two groups share an id', () => {
    const collided = definition([group('g'), group('g')], [cast('g', 'S', 0)]);
    const lanes = buildLanes(collided, 80);
    expect(lanes.map((lane) => lane.index)).toEqual([0, 1]);
  });
});

describe('laneIndexAtY', () => {
  const lanes = buildLanes(definition([group('a'), group('b', { count: 3 }), group('c')]), 80);

  it('resolves the first lane above the track and the last below it', () => {
    expect(laneIndexAtY(-20, lanes, new Set())).toBe(0);
    expect(laneIndexAtY(10_000, lanes, new Set())).toBe(2);
  });

  it('walks the collapsed lane heights', () => {
    expect(laneIndexAtY(0, lanes, new Set())).toBe(0);
    expect(laneIndexAtY(80, lanes, new Set())).toBe(1);
  });

  it('keeps the sub-rows of an expanded lane inside that lane', () => {
    const expanded = new Set(['b']);
    const secondLaneTop = 76;
    expect(laneIndexAtY(secondLaneTop + 100, lanes, expanded)).toBe(1);
    expect(laneIndexAtY(secondLaneTop + 100, lanes, new Set())).toBe(2);
  });

  it('has no answer without lanes', () => {
    expect(laneIndexAtY(10, [], new Set())).toBeNull();
  });
});

describe('parseCooldownSeconds', () => {
  it('reads the number out of the free text the catalog stores', () => {
    expect(parseCooldownSeconds('4')).toBe(4);
    expect(parseCooldownSeconds('4s')).toBe(4);
    expect(parseCooldownSeconds('4.5 s')).toBe(4.5);
    expect(parseCooldownSeconds('4,5')).toBe(4.5);
  });

  it('says nothing rather than zero when the catalog does not know', () => {
    for (const value of [null, undefined, '', '—', 'n/a', '0']) {
      expect(parseCooldownSeconds(value)).toBeNull();
    }
  });
});

describe('spellIdsOf', () => {
  it('collects every active and passive choice', () => {
    const ids = spellIdsOf({
      label: 'Polehammer',
      slot_type: 'weapon',
      two_handed: true,
      active_slots: 2,
      passive_slots: 1,
      active: { '1': [{ id: 'Q1', name: 'Q1' }], '2': [{ id: 'W1', name: 'W1' }] },
      passive: { '1': [{ id: 'P1', name: 'P1' }] },
    });
    expect([...ids].sort()).toEqual(['P1', 'Q1', 'W1']);
  });

  it('is empty for a group with no weapon', () => {
    expect(spellIdsOf(undefined).size).toBe(0);
  });
});

describe('hpSegmentsFor', () => {
  it('steps hit points down at each landing and holds to the end of the track', () => {
    const target = unit('e#0', { damage_taken: 1300, remaining_hp: 0, died_at: 2 });
    const logs = [log('a', 'S', 1, ['e#0'], -400), log('a', 'S', 2, ['e#0'], -900)];
    const { segments, replayMismatch } = hpSegmentsFor(target, logs, 10);
    expect(segments.map((segment) => segment.hp)).toEqual([1200, 800, 0]);
    expect(segments[segments.length - 1].toSeconds).toBe(10);
    expect(replayMismatch).toBe(false);
  });

  it('lets healing raise the curve again', () => {
    const target = unit('e#0', {
      damage_taken: 400,
      healing_received: 300,
      remaining_hp: 1100,
    });
    const logs = [log('a', 'S', 1, ['e#0'], -400), log('a', 'H', 1.5, ['e#0'], 300)];
    expect(hpSegmentsFor(target, logs, 5).segments.map((segment) => segment.hp)).toEqual([
      1200, 800, 1100,
    ]);
  });

  it('accumulates overkill uncapped, the way the engine does', () => {
    const target = unit('e#0', {
      damage_taken: 3000,
      healing_received: 1000,
      remaining_hp: 0,
      died_at: 1,
    });
    const logs = [log('a', 'S', 1, ['e#0'], -3000), log('a', 'H', 2, ['e#0'], 1000)];
    const { segments } = hpSegmentsFor(target, logs, 5);
    // 1200 - 3000 + 1000 is still below zero: a heal after a big overkill does not revive.
    expect(segments.map((segment) => segment.hp)).toEqual([1200, 0, 0]);
  });

  it('flags a replay that no longer agrees with the reported total', () => {
    const target = unit('e#0', { remaining_hp: 500 });
    expect(hpSegmentsFor(target, [log('a', 'S', 1, ['e#0'], -400)], 5).replayMismatch).toBe(true);
  });

  it('holds flat for a unit nothing ever hit', () => {
    const { segments } = hpSegmentsFor(unit('e#0'), [], 10);
    expect(segments).toEqual([{ fromSeconds: 0, toSeconds: 10, hp: 1200 }]);
  });
});

describe('logsTargeting', () => {
  it('keeps only the casts that named this unit', () => {
    const run = result(
      [unit('e#0'), unit('e#1')],
      [log('a', 'S', 1, ['e#0'], -100), log('a', 'S', 2, ['e#1'], -100)],
    );
    expect(logsTargeting('e#0', run).map((entry) => entry.land_at)).toEqual([1]);
  });
});

describe('matchLandTimes', () => {
  it('pairs repeats of the same spell in time order', () => {
    const def = definition([group('a')], [cast('a', 'S', 2), cast('a', 'S', 0)]);
    const run = result([], [log('a', 'S', 0.4, [], -1), log('a', 'S', 2.4, [], -1)]);
    expect(matchLandTimes(def, run)).toEqual([2.4, 0.4]);
  });

  it('declines to guess for a spell the engine dropped, without disturbing the others', () => {
    const def = definition([group('a')], [cast('a', 'GOOD', 0), cast('a', 'BOGUS', 1)]);
    const run = result([], [log('a', 'GOOD', 0.4, [], -1)]);
    expect(matchLandTimes(def, run)).toEqual([0.4, null]);
  });
});

describe('neverTargetedUnitIds', () => {
  it('names the units no cast ever mentions', () => {
    const def = definition(
      [group('e', { side: 'enemy', count: 3 })],
      [cast('a', 'S', 0, { target_ids: ['e#0'] })],
    );
    expect(neverTargetedUnitIds(def)).toEqual(['e#1', 'e#2']);
  });
});

describe('layout constants', () => {
  it('keeps a clip wide enough for the collision test to mean something', () => {
    expect(CLIP_WIDTH).toBeGreaterThan(0);
  });
});
