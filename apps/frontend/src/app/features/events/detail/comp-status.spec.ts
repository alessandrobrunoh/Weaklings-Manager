import { describe, expect, it } from 'vitest';

import type {
  EventRosterParticipant,
  EventRosterSeat,
  ParticipantWeapon,
} from '../../../core/models/api.models';
import { benchMatches, carriedWeaponGroups, compAdvice, seatedFitCounts } from './comp-status';

const ARCANE = 'weapon:MAIN_ARCANESTAFF';
const HALLOW = 'weapon:2H_HOLYSTAFF_UNDEAD';
const EARTH = 'weapon:2H_HAMMER_AVALON';

function member(
  userId: number,
  username: string,
  weapons: ParticipantWeapon[] = [],
  primaryBuildId: number | null = null,
): EventRosterParticipant {
  return {
    user_id: userId,
    username,
    discord_id: null,
    primary_build_id: primaryBuildId,
    primary_build_name: '',
    secondary_build_id: null,
    secondary_build_name: null,
    weapons,
  };
}

function level(
  weaponKey: string,
  proficiency: ParticipantWeapon['proficiency'],
  locked = false,
): ParticipantWeapon {
  return { weapon_key: weaponKey, proficiency, locked };
}

function seat(
  key: string,
  options: {
    party?: number;
    role?: string;
    buildId?: number;
    weapon?: string | null;
    position?: number;
    occupant?: EventRosterParticipant | null;
  } = {},
): EventRosterSeat {
  const party = options.party ?? 1;
  return {
    key,
    party_id: party,
    party_name: null,
    party_position: party,
    party_number: party,
    position: options.position ?? 1,
    build_id: options.buildId ?? 1,
    build_name: `Build ${options.buildId ?? 1}`,
    build_version: 1,
    role: options.role ?? 'dps',
    weapon_key: options.weapon === undefined ? ARCANE : options.weapon,
    participant: options.occupant ?? null,
  };
}

describe('seatedFitCounts', () => {
  it('counts seated players by their level on the seat weapon, skipping open and weaponless seats', () => {
    const counts = seatedFitCounts([
      seat('a', { occupant: member(1, 'Main', [level(ARCANE, 'main')]) }),
      seat('b', { occupant: member(2, 'Other', [level(HALLOW, 'good')]) }),
      seat('c', { occupant: member(3, 'Locked', [level(ARCANE, 'main', true)]) }),
      seat('d', { occupant: member(4, 'Nothing') }),
      seat('e', { weapon: null, occupant: member(5, 'Mount') }),
      seat('f'),
    ]);

    expect(counts).toEqual({
      main: 1,
      good: 0,
      basic: 0,
      no_declarations: 1,
      not_declared: 1,
      locked: 1,
    });
  });
});

describe('benchMatches', () => {
  it('pairs each open seat with one waiting player at Main or Good, best level first, in board order', () => {
    const seats = [
      seat('arcane-1', { position: 1 }),
      seat('arcane-2', { position: 2 }),
      seat('hallow', { weapon: HALLOW, role: 'healer', buildId: 2, position: 3 }),
    ];
    const bench = [
      member(1, 'GoodArcane', [level(ARCANE, 'good')]),
      member(2, 'MainArcane', [level(ARCANE, 'main'), level(HALLOW, 'main')]),
      member(3, 'BasicArcane', [level(ARCANE, 'basic')]),
    ];

    const matches = benchMatches(seats, bench);

    // The healer seat sorts first on the board, so the Main player takes it and the Good one
    // gets the first arcane seat; nobody suggests the Basic player.
    expect(matches.map((match) => [match.username, match.seat.key, match.proficiency])).toEqual([
      ['MainArcane', 'hallow', 'main'],
      ['GoodArcane', 'arcane-1', 'good'],
    ]);
  });

  it('prefers the player who signed up for the seat build when levels tie', () => {
    const seats = [seat('arcane', { buildId: 7 })];
    const bench = [
      member(1, 'Anyone', [level(ARCANE, 'main')]),
      member(2, 'AskedForIt', [level(ARCANE, 'main')], 7),
    ];

    expect(benchMatches(seats, bench).map((match) => match.username)).toEqual(['AskedForIt']);
  });

  it('never suggests a locked weapon', () => {
    const seats = [seat('arcane')];
    const bench = [member(1, 'Locked', [level(ARCANE, 'main', true)])];

    expect(benchMatches(seats, bench)).toEqual([]);
  });
});

describe('compAdvice', () => {
  it('lists locked, then undeclared, then bench matches, then missing roles', () => {
    const seats = [
      seat('tank', { role: 'tank', weapon: EARTH, occupant: member(1, 'Undeclared', [level(HALLOW, 'main')]) }),
      seat('dps', { position: 2, occupant: member(2, 'Locked', [level(ARCANE, 'good', true)]) }),
      seat('healer', { role: 'healer', weapon: HALLOW, position: 3 }),
    ];
    const bench = [member(3, 'Healer', [level(HALLOW, 'good')])];

    expect(compAdvice(seats, bench).map((item) => item.kind)).toEqual([
      'locked',
      'not_declared',
      'bench_match',
      'missing_role',
    ]);
  });

  it('flags open seats with nobody waiting, and ignores parties nobody sits in', () => {
    const seats = [
      seat('p1', { occupant: member(1, 'Main', [level(ARCANE, 'main')]) }),
      seat('p1-open', { position: 2 }),
      seat('p2-tank', { party: 2, role: 'tank', weapon: EARTH }),
    ];

    expect(compAdvice(seats, [])).toEqual([{ kind: 'no_bench', openSeats: 2 }]);
  });

  it('is empty for a full comp where everyone fits', () => {
    const seats = [seat('a', { occupant: member(1, 'Main', [level(ARCANE, 'main')]) })];

    expect(compAdvice(seats, [])).toEqual([]);
  });
});

describe('carriedWeaponGroups', () => {
  it('groups weapons by level, alphabetically, with locked weapons apart', () => {
    const groups = carriedWeaponGroups(
      [
        level(HALLOW, 'main'),
        level(ARCANE, 'main'),
        level(EARTH, 'basic', true),
        level('weapon:MAIN_SWORD', 'good'),
      ],
      (base) => base,
    );

    expect(groups.main.map((weapon) => weapon.name)).toEqual(['2H_HOLYSTAFF_UNDEAD', 'MAIN_ARCANESTAFF']);
    expect(groups.good.map((weapon) => weapon.base)).toEqual(['MAIN_SWORD']);
    expect(groups.basic).toEqual([]);
    expect(groups.locked.map((weapon) => weapon.key)).toEqual([EARTH]);
  });
});
