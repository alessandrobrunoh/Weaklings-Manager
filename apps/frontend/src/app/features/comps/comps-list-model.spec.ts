import { describe, expect, it } from 'vitest';

import type {
  BuildSummary,
  CompBuildEntry,
  CompPerformanceView,
  CompSummary,
} from '../../core/models/api.models';
import {
  activeFilterCount,
  buildMatches,
  compMatches,
  compareGroups,
  formatListDate,
  groupVersions,
  matchesQuery,
  mergeRoleMix,
  NO_FILTERS,
  partyCount,
  roleMixOf,
  winRateOf,
} from './comps-list-model';

function build(id: number, overrides: Partial<BuildSummary> = {}): BuildSummary {
  return {
    id,
    name: `Build ${id}`,
    description: null,
    role: 'dps',
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'kris',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 9,
    main_item_count: 9,
    archived_at: null,
    weapon_key: 'weapon:2H_BOW',
    weapon_name: 'Bow',
    ...overrides,
  };
}

function comp(id: number, overrides: Partial<CompSummary> = {}): CompSummary {
  return {
    id,
    name: `Comp ${id}`,
    description: null,
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'kris',
    created_at: '2026-09-01T00:00:00Z',
    build_count: 3,
    total_quantity: 20,
    parent_id: null,
    archived_at: null,
    ...overrides,
  };
}

describe('groupVersions', () => {
  it('shows the newest version of a name and category, with older ones folded under it', () => {
    const groups = groupVersions([
      build(1, { name: 'Healer', version: 1 }),
      build(2, { name: 'Healer', version: 3 }),
      build(3, { name: 'Healer', version: 2 }),
      build(4, { name: 'Tank' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].latest.id).toBe(2);
    expect(groups[0].older.map((row) => row.version)).toEqual([2, 1]);
    expect(groups[1].older).toEqual([]);
  });

  it('keeps the same name in two categories apart and ignores case', () => {
    const groups = groupVersions([
      build(1, { name: 'Healer', category_id: 1 }),
      build(2, { name: 'healer', category_id: 1, version: 2 }),
      build(3, { name: 'Healer', category_id: 2 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].latest.id).toBe(2);
  });
});

describe('filters', () => {
  it('requires every word of the search to appear somewhere', () => {
    expect(matchesQuery('bow kris', ['Heavy Bow', 'kris'])).toBe(true);
    expect(matchesQuery('bow nobody', ['Heavy Bow', 'kris'])).toBe(false);
    expect(matchesQuery('   ', ['anything'])).toBe(true);
  });

  it('filters builds by role, category and weapon family', () => {
    const healer = build(1, { role: 'healer', category_id: 2, weapon_key: 'weapon:MAIN_HOLYSTAFF' });
    const bow = build(2, { weapon_key: 'weapon:2H_LONGBOW' });

    expect(buildMatches(healer, { ...NO_FILTERS, role: 'healer' })).toBe(true);
    expect(buildMatches(bow, { ...NO_FILTERS, role: 'healer' })).toBe(false);
    expect(buildMatches(healer, { ...NO_FILTERS, categoryId: 1 })).toBe(false);
    expect(buildMatches(bow, { ...NO_FILTERS, family: 'bows' })).toBe(true);
    expect(buildMatches(healer, { ...NO_FILTERS, family: 'bows' })).toBe(false);
    expect(buildMatches(build(3, { weapon_key: null }), { ...NO_FILTERS, family: 'bows' })).toBe(false);
  });

  it('separates base compositions from variants', () => {
    const root = comp(1);
    const variant = comp(2, { parent_id: 1 });

    expect(compMatches(root, { ...NO_FILTERS, type: 'base' })).toBe(true);
    expect(compMatches(variant, { ...NO_FILTERS, type: 'base' })).toBe(false);
    expect(compMatches(variant, { ...NO_FILTERS, type: 'variants' })).toBe(true);
    expect(compMatches(root, { ...NO_FILTERS, type: 'variants' })).toBe(false);
  });

  it('counts the filters in force', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, role: 'tank', categoryId: 3, type: 'base' })).toBe(3);
    expect(activeFilterCount({ ...NO_FILTERS, query: 'x' })).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, query: 'x' }, true)).toBe(1);
  });
});

describe('role mix and totals', () => {
  const entries = [
    { quantity: 4, build: build(1, { role: 'tank' }) },
    { quantity: 11, build: build(2, { role: 'dps' }) },
    { quantity: 5, build: build(3, { role: 'healer' }) },
    { quantity: 2, build: build(4, { role: 'dps' }) },
  ] as Pick<CompBuildEntry, 'quantity' | 'build'>[];

  it('counts players per role, front line first, leaving out empty roles', () => {
    expect(roleMixOf(entries)).toEqual([
      { role: 'tank', count: 4 },
      { role: 'healer', count: 5 },
      { role: 'dps', count: 13 },
    ]);
  });

  it('adds two mixes together', () => {
    expect(
      mergeRoleMix([{ role: 'tank', count: 2 }], [{ role: 'tank', count: 1 }, { role: 'healer', count: 3 }]),
    ).toEqual([
      { role: 'tank', count: 3 },
      { role: 'healer', count: 3 },
    ]);
  });

  it('counts a partial last party as a party', () => {
    expect(partyCount(0)).toBe(0);
    expect(partyCount(20)).toBe(1);
    expect(partyCount(21)).toBe(2);
  });
});

describe('winRateOf', () => {
  const performance = (battles: number, rate: number): CompPerformanceView =>
    ({
      comp_id: 1,
      comp_name: 'x',
      events_with_battles: 0,
      stats: { total_battles: battles, win_rate: rate },
    }) as CompPerformanceView;

  it('reports nothing for a composition that never fought, instead of 0.0%', () => {
    expect(winRateOf(performance(0, 0))).toBeNull();
    expect(winRateOf(null)).toBeNull();
  });

  it('reports the rate with the battles behind it', () => {
    expect(winRateOf(performance(14, 62.5))).toEqual({ rate: 62.5, battles: 14 });
  });
});

describe('compareGroups', () => {
  const rows = [
    build(1, { name: 'Bravo', created_by_username: 'zed' }),
    build(2, { name: 'Alpha', created_by_username: 'amy' }),
  ];
  const sorted = (key: 'name' | 'author', direction: 'asc' | 'desc') =>
    groupVersions(rows)
      .sort(
        compareGroups(
          { key, direction },
          (row: BuildSummary) => row.main_item_count,
          (row: BuildSummary) => row.updated_at,
          'en',
        ),
      )
      .map((group) => group.latest.name);

  it('sorts by name in both directions', () => {
    expect(sorted('name', 'asc')).toEqual(['Alpha', 'Bravo']);
    expect(sorted('name', 'desc')).toEqual(['Bravo', 'Alpha']);
  });

  it('sorts by author', () => {
    expect(sorted('author', 'asc')).toEqual(['Alpha', 'Bravo']);
    expect(sorted('author', 'desc')).toEqual(['Bravo', 'Alpha']);
  });
});

describe('formatListDate', () => {
  it('formats a date and shows a dash for a missing or invalid one', () => {
    expect(formatListDate('2026-09-01T00:00:00Z', 'en')).toMatch(/2026/);
    expect(formatListDate(null, 'en')).toBe('—');
    expect(formatListDate('nope', 'en')).toBe('—');
  });
});
