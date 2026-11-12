import type {
  BuildRole,
  BuildSummary,
  CompBuildEntry,
  CompPerformanceView,
  CompSummary,
} from '../../core/models/api.models';
import { BUILD_ROLES } from '../../shared/components/role-tag/role-tag';
import { weaponFamilyOfKey } from '../../shared/data/user-weapons';
import type { WeaponFamilyId } from '../../shared/data/albion-weapon-families';
import { COMP_PARTY_SIZE } from './comp-parties';

/** Rows loaded per request; lists page on the client over this window and offer "Load more". */
export const LIST_FETCH_LIMIT = 500;

/** Which kind of composition a list shows: every one, only roots, or only variants of another comp. */
export type CompTypeFilter = 'all' | 'base' | 'variants';

/** The versions of one build or composition: its `(name, category)` group. */
export interface VersionGroup<T> {
  /** `name|category` identity shared by every version. */
  readonly key: string;
  /** The highest version present in the rows that were grouped. */
  readonly latest: T;
  /** Lower versions, newest first. */
  readonly older: readonly T[];
}

interface Versioned {
  readonly id: number;
  readonly name: string;
  readonly category_id: number;
  readonly version: number;
}

/** Identity of a version group, matching the server rule that versions share name and category. */
export function versionKey(row: Pick<Versioned, 'name' | 'category_id'>): string {
  return `${row.name.trim().toLowerCase()}|${row.category_id}`;
}

/**
 * Groups rows into their version groups, keeping the order in which each group first appears.
 *
 * Callers filter first and group second, so the row shown for a group is the newest version that
 * matches the filters instead of a version the officer filtered away.
 */
export function groupVersions<T extends Versioned>(rows: readonly T[]): VersionGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = versionKey(row);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const sorted = [...bucket].sort((left, right) => right.version - left.version || right.id - left.id);
    return { key, latest: sorted[0], older: sorted.slice(1) };
  });
}

/** Lower-cased haystack match: every word of the query must appear somewhere in the fields. */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = fields.join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The filters both lists share, plus the ones only one of them has. */
export interface ListFilters {
  readonly query: string;
  readonly categoryId: number | null;
  readonly role: BuildRole | null;
  readonly family: WeaponFamilyId | null;
  readonly type: CompTypeFilter;
}

export const NO_FILTERS: ListFilters = {
  query: '',
  categoryId: null,
  role: null,
  family: null,
  type: 'all',
};

/** How many filters narrow the list, for the "Filters (n)" button on a phone. */
export function activeFilterCount(filters: ListFilters, includeQuery = false): number {
  return (
    (includeQuery && filters.query.trim() ? 1 : 0) +
    (filters.categoryId !== null ? 1 : 0) +
    (filters.role !== null ? 1 : 0) +
    (filters.family !== null ? 1 : 0) +
    (filters.type !== 'all' ? 1 : 0)
  );
}

/** Whether a build passes the search, role, category and weapon-family filters. */
export function buildMatches(build: BuildSummary, filters: ListFilters): boolean {
  if (filters.categoryId !== null && build.category_id !== filters.categoryId) {
    return false;
  }
  if (filters.role !== null && build.role !== filters.role) {
    return false;
  }
  if (
    filters.family !== null &&
    (!build.weapon_key || weaponFamilyOfKey(build.weapon_key) !== filters.family)
  ) {
    return false;
  }
  return matchesQuery(filters.query, [
    build.name,
    build.weapon_name,
    build.category_name,
    build.created_by_username,
    build.description,
  ]);
}

/** Whether a composition passes the search, category and type filters. */
export function compMatches(comp: CompSummary, filters: ListFilters): boolean {
  if (filters.categoryId !== null && comp.category_id !== filters.categoryId) {
    return false;
  }
  if (filters.type === 'base' && comp.parent_id !== null) {
    return false;
  }
  if (filters.type === 'variants' && comp.parent_id === null) {
    return false;
  }
  return matchesQuery(filters.query, [
    comp.name,
    comp.category_name,
    comp.created_by_username,
    comp.description,
  ]);
}

/** One role and how many players a composition fields in it. */
export interface RoleCount {
  readonly role: BuildRole;
  readonly count: number;
}

/** Players per role of a composition's builds, in front-line-first role order; empty roles are left out. */
export function roleMixOf(entries: readonly Pick<CompBuildEntry, 'quantity' | 'build'>[]): RoleCount[] {
  const counts = new Map<BuildRole, number>();
  for (const entry of entries) {
    counts.set(entry.build.role, (counts.get(entry.build.role) ?? 0) + entry.quantity);
  }
  return BUILD_ROLES.filter((role) => (counts.get(role) ?? 0) > 0).map((role) => ({
    role,
    count: counts.get(role) ?? 0,
  }));
}

/** Adds two role mixes, for a variant that sits on top of its parent. */
export function mergeRoleMix(left: readonly RoleCount[], right: readonly RoleCount[]): RoleCount[] {
  const counts = new Map<BuildRole, number>();
  for (const entry of [...left, ...right]) {
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + entry.count);
  }
  return BUILD_ROLES.filter((role) => (counts.get(role) ?? 0) > 0).map((role) => ({
    role,
    count: counts.get(role) ?? 0,
  }));
}

/** Parties of {@link COMP_PARTY_SIZE} a number of players fills, counting a partial last party. */
export function partyCount(players: number): number {
  return players <= 0 ? 0 : Math.ceil(players / COMP_PARTY_SIZE);
}

/**
 * Win rate to show for a composition, or `null` when nothing was fought.
 *
 * A composition with no battles has a win rate of 0.0 in the API payload, which reads as "loses
 * every fight" in a list; the list shows "No battles" instead.
 */
export function winRateOf(
  performance: CompPerformanceView | null | undefined,
): { readonly rate: number; readonly battles: number } | null {
  const stats = performance?.stats;
  if (!stats || stats.total_battles <= 0) {
    return null;
  }
  return { rate: stats.win_rate, battles: stats.total_battles };
}

/** Sort keys a list column can offer. */
export type ListSortKey = 'name' | 'category' | 'size' | 'updated' | 'author' | 'role';

export interface ListSort {
  readonly key: ListSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Compares two version groups by their latest rows for a sort key; ties fall back to name. */
export function compareGroups<T extends Versioned & { created_by_username: string; category_name: string | null }>(
  sort: ListSort,
  size: (row: T) => number,
  updated: (row: T) => string,
  locale: string,
  role?: (row: T) => string,
): (left: VersionGroup<T>, right: VersionGroup<T>) => number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return (left, right) => {
    const a = left.latest;
    const b = right.latest;
    let result = 0;
    switch (sort.key) {
      case 'category':
        result = (a.category_name ?? '').localeCompare(b.category_name ?? '', locale);
        break;
      case 'size':
        result = size(a) - size(b);
        break;
      case 'updated':
        result = updated(a).localeCompare(updated(b));
        break;
      case 'author':
        result = a.created_by_username.localeCompare(b.created_by_username, locale);
        break;
      case 'role':
        result = (role?.(a) ?? '').localeCompare(role?.(b) ?? '', locale);
        break;
      default:
        result = a.name.localeCompare(b.name, locale);
        break;
    }
    return sign * result || a.name.localeCompare(b.name, locale) || a.id - b.id;
  };
}

/** A short, localized date for a list cell; an unparseable value reads as an em dash. */
export function formatListDate(value: string | null | undefined, locale: string): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}
