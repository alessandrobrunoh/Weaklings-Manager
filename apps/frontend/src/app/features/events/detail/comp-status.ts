import type {
  EventRosterParticipant,
  EventRosterSeat,
  ParticipantWeapon,
  WeaponProficiency,
} from '../../../core/models/api.models';
import type { TranslationKey } from '../../../i18n/en';
import { proficiencyRank, weaponFit, type WeaponFit } from '../../../shared/data/user-weapons';
import { compareSeatsByRole, groupSeatsByRole } from './roster-lobby';

/**
 * Pure helpers behind the Parties board's comp status panel and the weapon level chips: how the
 * seated players fit their seats' weapons, and which moves would improve the comp.
 */

export interface WeaponFitChip {
  readonly tone: 'success' | 'info' | 'neutral' | 'warning' | 'error';
  readonly labelKey: TranslationKey;
  readonly icon: 'alert' | 'lock' | null;
}

/** Chip per weapon fit. The label always names the state, so colour is never the only cue. */
export const WEAPON_FIT_CHIP: Readonly<Record<WeaponFit, WeaponFitChip>> = {
  main: { tone: 'success', labelKey: 'weapons.proficiency.main', icon: null },
  good: { tone: 'info', labelKey: 'weapons.proficiency.good', icon: null },
  basic: { tone: 'neutral', labelKey: 'weapons.proficiency.basic', icon: null },
  no_declarations: { tone: 'neutral', labelKey: 'weapons.fit.noDeclarations', icon: null },
  not_declared: { tone: 'warning', labelKey: 'weapons.notDeclared', icon: 'alert' },
  locked: { tone: 'error', labelKey: 'weapons.locked', icon: 'lock' },
};

/** Fits in display order, best first. */
export const WEAPON_FIT_ORDER: readonly WeaponFit[] = [
  'main',
  'good',
  'basic',
  'no_declarations',
  'not_declared',
  'locked',
];

export type WeaponFitCounts = Readonly<Record<WeaponFit, number>>;

/** How the seated players fit their seats' weapons. Open seats and seats without a weapon are skipped. */
export function seatedFitCounts(seats: readonly EventRosterSeat[]): WeaponFitCounts {
  const counts: Record<WeaponFit, number> = {
    main: 0,
    good: 0,
    basic: 0,
    no_declarations: 0,
    not_declared: 0,
    locked: 0,
  };
  for (const seat of seats) {
    if (!seat.participant) continue;
    const fit = weaponFit(seat.participant.weapons, seat.weapon_key);
    if (fit) counts[fit] += 1;
  }
  return counts;
}

/** One suggestion of the comp status panel. Seat-bound entries carry the seat to reveal. */
export type CompAdvice =
  | {
      readonly kind: 'locked' | 'not_declared';
      readonly seat: EventRosterSeat;
      readonly username: string;
    }
  | {
      readonly kind: 'bench_match';
      readonly seat: EventRosterSeat;
      readonly userId: number;
      readonly username: string;
      readonly proficiency: WeaponProficiency;
    }
  | { readonly kind: 'missing_role'; readonly partyNumber: number; readonly role: string }
  | { readonly kind: 'no_bench'; readonly openSeats: number };

type BenchCandidate = Pick<
  EventRosterParticipant,
  'user_id' | 'username' | 'weapons' | 'primary_build_id' | 'secondary_build_id'
>;

function boardOrder(left: EventRosterSeat, right: EventRosterSeat): number {
  return left.party_number - right.party_number || compareSeatsByRole(left, right);
}

function signupPreference(member: BenchCandidate, seat: EventRosterSeat): number {
  if (member.primary_build_id === seat.build_id) return 0;
  if (member.secondary_build_id === seat.build_id) return 1;
  return 2;
}

/**
 * Waiting players who play an open seat's weapon at Main or Good, one per seat and one seat per
 * player. Pairs are taken best first: level, then the player's own signup choice, then board
 * order, then waiting-list order.
 */
export function benchMatches(
  seats: readonly EventRosterSeat[],
  bench: readonly BenchCandidate[],
): Extract<CompAdvice, { kind: 'bench_match' }>[] {
  const open = seats.filter((seat) => seat.participant === null && seat.weapon_key).sort(boardOrder);
  const seatRank = new Map(open.map((seat, index) => [seat.key, index] as const));
  const pairs: {
    seat: EventRosterSeat;
    member: BenchCandidate;
    level: WeaponProficiency;
    benchIndex: number;
  }[] = [];
  bench.forEach((member, benchIndex) => {
    for (const seat of open) {
      const fit = weaponFit(member.weapons, seat.weapon_key);
      if (fit === 'main' || fit === 'good') pairs.push({ seat, member, level: fit, benchIndex });
    }
  });
  pairs.sort(
    (left, right) =>
      proficiencyRank(left.level) - proficiencyRank(right.level) ||
      signupPreference(left.member, left.seat) - signupPreference(right.member, right.seat) ||
      (seatRank.get(left.seat.key) ?? 0) - (seatRank.get(right.seat.key) ?? 0) ||
      left.benchIndex - right.benchIndex,
  );

  const usedSeats = new Set<string>();
  const usedMembers = new Set<number>();
  const matches: Extract<CompAdvice, { kind: 'bench_match' }>[] = [];
  for (const pair of pairs) {
    if (usedSeats.has(pair.seat.key) || usedMembers.has(pair.member.user_id)) continue;
    usedSeats.add(pair.seat.key);
    usedMembers.add(pair.member.user_id);
    matches.push({
      kind: 'bench_match',
      seat: pair.seat,
      userId: pair.member.user_id,
      username: pair.member.username,
      proficiency: pair.level,
    });
  }
  return matches.sort((left, right) => boardOrder(left.seat, right.seat));
}

/**
 * Everything worth fixing on the board, most urgent first: players on a weapon locked for them,
 * players on a weapon they never declared, waiting players who fit an open seat, parties that are
 * in use but miss a whole role, and open seats with nobody left to fill them.
 */
export function compAdvice(
  seats: readonly EventRosterSeat[],
  bench: readonly BenchCandidate[],
): CompAdvice[] {
  const ordered = [...seats].sort(boardOrder);
  const warnings: CompAdvice[] = [];
  for (const kind of ['locked', 'not_declared'] as const) {
    for (const seat of ordered) {
      if (seat.participant && weaponFit(seat.participant.weapons, seat.weapon_key) === kind) {
        warnings.push({ kind, seat, username: seat.participant.username });
      }
    }
  }

  const missingRoles: CompAdvice[] = [];
  const byParty = new Map<number, EventRosterSeat[]>();
  for (const seat of ordered) {
    const partySeats = byParty.get(seat.party_number);
    if (partySeats) partySeats.push(seat);
    else byParty.set(seat.party_number, [seat]);
  }
  for (const [partyNumber, partySeats] of byParty) {
    if (!partySeats.some((seat) => seat.participant !== null)) continue;
    for (const group of groupSeatsByRole(partySeats)) {
      if (group.filled === 0) missingRoles.push({ kind: 'missing_role', partyNumber, role: group.role });
    }
  }

  const openSeats = seats.filter((seat) => seat.participant === null).length;
  const tail: CompAdvice[] =
    openSeats > 0 && bench.length === 0 ? [{ kind: 'no_bench', openSeats }] : [];

  return [...warnings, ...benchMatches(seats, bench), ...missingRoles, ...tail];
}

/** A weapon of the member being moved, named and with an icon. */
export interface CarriedWeapon {
  readonly key: string;
  readonly name: string;
  readonly base: string;
}

/** The moved member's weapons per level; locked weapons are listed apart, whatever their level. */
export interface CarriedWeaponGroups {
  readonly main: readonly CarriedWeapon[];
  readonly good: readonly CarriedWeapon[];
  readonly basic: readonly CarriedWeapon[];
  readonly locked: readonly CarriedWeapon[];
}

export function carriedWeaponGroups(
  weapons: readonly ParticipantWeapon[] | null | undefined,
  nameOf: (base: string) => string,
): CarriedWeaponGroups {
  const groups: Record<keyof CarriedWeaponGroups, CarriedWeapon[]> = {
    main: [],
    good: [],
    basic: [],
    locked: [],
  };
  for (const weapon of weapons ?? []) {
    const base = weapon.weapon_key.replace(/^weapon:/, '');
    const entry = { key: weapon.weapon_key, name: nameOf(base), base };
    if (weapon.locked) groups.locked.push(entry);
    else if (weapon.proficiency) groups[weapon.proficiency].push(entry);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}
