import type { EventRosterSeat } from '../../../core/models/api.models';
import type { TranslationKey } from '../../../i18n/en';

/** Display order of roles on the roster lobby: frontline first, mounts last. */
export const LOBBY_ROLE_ORDER: readonly string[] = [
  'tank',
  'healer',
  'support',
  'dps',
  'brawler',
  'battle_mount',
];

const ROLE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  tank: 'events.detail.role_tank',
  healer: 'events.detail.role_healer',
  support: 'events.detail.role_support',
  dps: 'events.detail.role_dps',
  battle_mount: 'events.detail.role_battle_mount',
  brawler: 'events.detail.role_brawler',
};

const ROLE_COLOR_VARS: Readonly<Record<string, string>> = {
  tank: 'var(--role-tank)',
  healer: 'var(--role-healer)',
  support: 'var(--role-support)',
  dps: 'var(--role-dps)',
  battle_mount: 'var(--role-bm)',
  brawler: 'var(--role-brawler)',
};

const ROLE_GLYPHS: Readonly<Record<string, string>> = {
  tank: 'T',
  healer: 'H',
  support: 'S',
  dps: 'D',
  battle_mount: 'BM',
  brawler: 'B',
};

/** Translation key for a role's name, or `null` for a role the app does not know. */
export function roleLabelKey(role: string): TranslationKey | null {
  return ROLE_LABEL_KEYS[role] ?? null;
}

/** The role's accent colour as a CSS value; unknown roles fall back to the neutral border. */
export function roleColorVar(role: string): string {
  return ROLE_COLOR_VARS[role] ?? 'var(--color-border-strong)';
}

/** Short letter shown when a seat's weapon icon is not available. */
export function roleGlyph(role: string): string {
  return ROLE_GLYPHS[role] ?? '•';
}

function roleRank(role: string): number {
  const index = LOBBY_ROLE_ORDER.indexOf(role);
  return index === -1 ? LOBBY_ROLE_ORDER.length : index;
}

/** Orders seats by role, then by their party position, so a party reads front to back. */
export function compareSeatsByRole(left: EventRosterSeat, right: EventRosterSeat): number {
  return roleRank(left.role) - roleRank(right.role) || left.position - right.position;
}

/** Every seat of one build, across all parties. */
export interface LobbyBuildGroup {
  readonly buildId: number;
  readonly buildName: string;
  readonly seats: readonly EventRosterSeat[];
  readonly filled: number;
  readonly total: number;
}

/** Every seat of one role, split by build. */
export interface LobbyRoleGroup {
  readonly role: string;
  readonly builds: readonly LobbyBuildGroup[];
  readonly filled: number;
  readonly total: number;
}

/**
 * Groups the roster's seats into roles, and each role into its builds.
 *
 * This is the member-facing view of the comp: which roles exist, how many seats each has, who
 * holds them and how many are still open. Roles follow {@link LOBBY_ROLE_ORDER} (unknown roles
 * last, alphabetically); builds keep the order their first seat appears in the roster.
 */
export function groupSeatsByRole(seats: readonly EventRosterSeat[]): LobbyRoleGroup[] {
  const roles = new Map<string, Map<number, EventRosterSeat[]>>();
  for (const seat of seats) {
    let builds = roles.get(seat.role);
    if (!builds) {
      builds = new Map();
      roles.set(seat.role, builds);
    }
    const buildSeats = builds.get(seat.build_id);
    if (buildSeats) {
      buildSeats.push(seat);
    } else {
      builds.set(seat.build_id, [seat]);
    }
  }

  return [...roles.entries()]
    .sort(([left], [right]) => roleRank(left) - roleRank(right) || left.localeCompare(right))
    .map(([role, builds]) => {
      const buildGroups = [...builds.values()].map((buildSeats) => {
        const filled = buildSeats.filter((seat) => seat.participant !== null).length;
        return {
          buildId: buildSeats[0].build_id,
          buildName: buildSeats[0].build_name,
          seats: buildSeats,
          filled,
          total: buildSeats.length,
        };
      });
      return {
        role,
        builds: buildGroups,
        filled: buildGroups.reduce((sum, build) => sum + build.filled, 0),
        total: buildGroups.reduce((sum, build) => sum + build.total, 0),
      };
    });
}

/** How many seats of each role a party has, and how many are taken, in lobby role order. */
export interface PartyRoleCount {
  readonly role: string;
  readonly filled: number;
  readonly total: number;
}

export function partyRoleCounts(seats: readonly EventRosterSeat[]): PartyRoleCount[] {
  return groupSeatsByRole(seats).map(({ role, filled, total }) => ({ role, filled, total }));
}
