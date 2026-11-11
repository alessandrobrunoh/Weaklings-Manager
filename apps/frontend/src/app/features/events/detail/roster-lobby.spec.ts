import { describe, expect, it } from 'vitest';

import type { EventRosterSeat } from '../../../core/models/api.models';
import {
  compareSeatsByRole,
  groupSeatsByRole,
  partyRoleCounts,
  roleColorVar,
  roleLabelKey,
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
    party_number: 1,
    position,
    build_id: buildId,
    build_name: `Build ${buildId}`,
    build_version: 1,
    role,
    participant: occupant
      ? {
          user_id: position,
          username: occupant,
          discord_id: null,
          primary_build_id: buildId,
          primary_build_name: `Build ${buildId}`,
          secondary_build_id: null,
          secondary_build_name: null,
          specializations: {},
        }
      : null,
  };
}

describe('groupSeatsByRole', () => {
  it('orders roles frontline first and counts filled seats per role and build', () => {
    const groups = groupSeatsByRole([
      seat('build:3:1', 'dps', 3, 1, 'Ada'),
      seat('build:3:2', 'dps', 3, 2),
      seat('build:1:1', 'tank', 1, 3, 'Bo'),
      seat('build:2:1', 'healer', 2, 4),
      seat('build:4:1', 'dps', 4, 5, 'Cy'),
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
      seat('build:9:1', 'scout', 9, 1),
      seat('build:1:1', 'tank', 1, 2),
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
