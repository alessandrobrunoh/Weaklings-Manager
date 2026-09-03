import { describe, expect, it } from 'vitest';

import type { BuildRole, BuildSummary, CompBuildEntry } from '../../core/models/api.models';
import { COMP_PARTY_SIZE, simulateCompParties } from './comp-parties';

function build(id: number, name: string, role: BuildRole): BuildSummary {
  return {
    id,
    name,
    description: null,
    role,
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_username: 'officer',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 1,
    archived_at: null,
  };
}

function entry(id: number, name: string, role: BuildRole, quantity: number): CompBuildEntry {
  return { build_id: id, build: build(id, name, role), quantity };
}

describe('simulateCompParties', () => {
  it('returns no parties when the roster is empty', () => {
    expect(simulateCompParties([])).toEqual([]);
  });

  it('keeps a 20-man roster in a single party', () => {
    const parties = simulateCompParties([entry(1, 'Tank', 'tank', 20)]);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.seats).toHaveLength(COMP_PARTY_SIZE);
    expect(parties[0]?.partyNumber).toBe(1);
  });

  it('splits overflow into a second party of the remainder', () => {
    const parties = simulateCompParties([
      entry(1, 'Tank', 'tank', 4),
      entry(2, 'Healer', 'healer', 8),
      entry(3, 'DPS', 'dps', 13),
    ]);
    expect(parties).toHaveLength(2);
    expect(parties[0]?.seats).toHaveLength(20);
    expect(parties[1]?.seats).toHaveLength(5);
    expect(parties[1]?.partyNumber).toBe(2);
  });

  it('orders seats by role before chunking', () => {
    const parties = simulateCompParties([
      entry(1, 'DPS', 'dps', 1),
      entry(2, 'Tank', 'tank', 1),
      entry(3, 'Healer', 'healer', 1),
    ]);
    expect(parties[0]?.seats.map((seat) => seat.role)).toEqual(['tank', 'healer', 'dps']);
  });
});
