import { describe, expect, it } from 'vitest';

import type { BuildRole, BuildSummary, CompBuildEntry } from '../../core/models/api.models';
import { COMP_PARTY_SIZE, groupPartySeats, partyRoleMix, simulateCompParties } from './comp-parties';

function build(id: number, name: string, role: BuildRole): BuildSummary {
  return {
    id,
    name,
    description: null,
    role,
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'officer',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 1,
    main_item_count: 1,
    archived_at: null,
    weapon_key: null,
    weapon_name: null,
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

describe('groupPartySeats and partyRoleMix', () => {
  const party = () =>
    simulateCompParties([
      entry(1, 'Great Hammer', 'tank', 3),
      entry(2, 'Hallowfall', 'healer', 2),
      entry(3, 'Bow', 'dps', 4),
      entry(4, 'Blazing Staff', 'dps', 1),
    ])[0]!;

  it('collapses the seats of one build into a single counted line', () => {
    const groups = groupPartySeats(party());
    expect(groups.map((group) => [group.build.name, group.count])).toEqual([
      ['Great Hammer', 3],
      ['Hallowfall', 2],
      ['Bow', 4],
      ['Blazing Staff', 1],
    ]);
  });

  it('counts a build again in the party its seats spill into', () => {
    const parties = simulateCompParties([entry(1, 'Bow', 'dps', 25)]);
    expect(groupPartySeats(parties[0]!).map((group) => group.count)).toEqual([20]);
    expect(groupPartySeats(parties[1]!).map((group) => group.count)).toEqual([5]);
  });

  it('reports the role mix in role-priority order', () => {
    expect(partyRoleMix(party())).toEqual([
      { role: 'tank', count: 3 },
      { role: 'healer', count: 2 },
      { role: 'dps', count: 5 },
    ]);
  });
});
