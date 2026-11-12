import { describe, expect, it } from 'vitest';

import type { EventRosterSeat } from '../../../core/models/api.models';
import {
  compareSeatsByRole,
  groupSeatsByRole,
  movedPartyOrder,
  partyForBoardNumber,
  partyHeading,
  partyRoleCounts,
  roleColorVar,
  roleLabelKey,
  seatPartyLabel,
  sortedRoleCounts,
} from './roster-lobby';

function seat(
  key: string,
  role: string,
  buildId: number,
  position: number,
  occupant: string | null = null,
): EventRosterSeat {
  return {
    key,
    party_id: 1,
    party_name: null,
    party_position: 1,
    party_number: 1,
    position,
    build_id: buildId,
    build_name: `Build ${buildId}`,
    build_version: 1,
    role,
    weapon_key: null,
    participant: occupant
      ? {
          user_id: position,
          username: occupant,
          discord_id: null,
          primary_build_id: buildId,
          primary_build_name: `Build ${buildId}`,
          secondary_build_id: null,
          secondary_build_name: null,
          weapons: [],
        }
      : null,
  };
}

describe('groupSeatsByRole', () => {
  it('orders roles frontline first and counts filled seats per role and build', () => {
    const groups = groupSeatsByRole([
      seat('party:1:build:3:1', 'dps', 3, 1, 'Ada'),
      seat('party:1:build:3:2', 'dps', 3, 2),
      seat('party:1:build:1:1', 'tank', 1, 3, 'Bo'),
      seat('party:1:build:2:1', 'healer', 2, 4),
      seat('party:1:build:4:1', 'dps', 4, 5, 'Cy'),
    ]);

    expect(groups.map((group) => group.role)).toEqual(['tank', 'healer', 'dps']);
    const dps = groups[2];
    expect([dps.filled, dps.total]).toEqual([2, 3]);
    expect(dps.builds.map((build) => [build.buildId, build.filled, build.total])).toEqual([
      [3, 1, 2],
      [4, 1, 1],
    ]);
  });

  it('puts roles it does not know after the known ones', () => {
    const groups = groupSeatsByRole([
      seat('party:1:build:9:1', 'scout', 9, 1),
      seat('party:1:build:1:1', 'tank', 1, 2),
    ]);
    expect(groups.map((group) => group.role)).toEqual(['tank', 'scout']);
    expect(roleLabelKey('scout')).toBeNull();
    expect(roleColorVar('scout')).toBe('var(--color-border-strong)');
  });

  it('is empty for an empty roster', () => {
    expect(groupSeatsByRole([])).toEqual([]);
    expect(partyRoleCounts([])).toEqual([]);
  });
});

describe('compareSeatsByRole', () => {
  it('sorts by role, then by position', () => {
    const sorted = [
      seat('a', 'dps', 3, 1),
      seat('b', 'tank', 1, 4),
      seat('c', 'tank', 1, 2),
    ].sort(compareSeatsByRole);
    expect(sorted.map((entry) => entry.key)).toEqual(['c', 'b', 'a']);
  });
});

describe('party labels', () => {
  const brawl = { name: 'Brawl', position: 2, board_party_numbers: [3, 4] };
  const plain = { name: null, position: 1, board_party_numbers: [1] };
  const defaultName = (position: number): string => `Party ${position}`;

  it('finds the event party that owns a board party number', () => {
    expect(partyForBoardNumber([plain, brawl], 4)).toBe(brawl);
    expect(partyForBoardNumber([plain, brawl], 9)).toBeNull();
  });

  it('names a party by its label or position and numbers the boards of a spanning comp', () => {
    expect(partyHeading(plain, 1, defaultName)).toBe('Party 1');
    expect(partyHeading(brawl, 3, defaultName)).toBe('Brawl 1/2');
    expect(partyHeading(brawl, 4, defaultName)).toBe('Brawl 2/2');
    expect(partyHeading({ ...brawl, name: '  ' }, 3, defaultName)).toBe('Party 2 1/2');
  });

  it('labels a seat from its own party fields', () => {
    expect(seatPartyLabel({ party_name: 'Clap', party_position: 3 }, defaultName)).toBe('Clap');
    expect(seatPartyLabel({ party_name: null, party_position: 3 }, defaultName)).toBe('Party 3');
  });

  it('moves a party one place and refuses to leave the list', () => {
    expect(movedPartyOrder([5, 6, 7], 6, -1)).toEqual([6, 5, 7]);
    expect(movedPartyOrder([5, 6, 7], 6, 1)).toEqual([5, 7, 6]);
    expect(movedPartyOrder([5, 6, 7], 5, -1)).toBeNull();
    expect(movedPartyOrder([5, 6, 7], 7, 1)).toBeNull();
    expect(movedPartyOrder([5, 6, 7], 99, 1)).toBeNull();
  });

  it('lists role counts in lobby order and drops empty ones', () => {
    expect(
      sortedRoleCounts([
        { role: 'dps', count: 4 },
        { role: 'tank', count: 2 },
        { role: 'healer', count: 0 },
      ]),
    ).toEqual([
      { role: 'tank', count: 2 },
      { role: 'dps', count: 4 },
    ]);
  });
});
