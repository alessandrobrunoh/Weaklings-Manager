import type {
  ManageUserWeaponsRequest,
  OpenAlbionItem,
  ParticipantWeapon,
  UpdateMyWeaponsRequest,
  UserWeapon,
  WeaponProficiency,
} from '../../core/models/api.models';
import {
  classifyWeaponFamily,
  weaponFamilyOrder,
  type WeaponFamilyId,
} from './albion-weapon-families';
import { albionBaseIdentifier, deduplicateAlbionCombatCatalog } from './albion-equipment-catalog';

/**
 * "My weapons": the weapons a member declares they can play, each with a level. Pure helpers shared
 * by the profile, the admin member view, the event signup dialog, the Parties board and the builds
 * page. A weapon key is `weapon:{BASE}` (tier-less base identifier).
 */

/** Proficiencies from strongest to weakest. */
export const WEAPON_PROFICIENCIES: readonly WeaponProficiency[] = ['main', 'good', 'basic'];

/** Sort rank of a proficiency; an undeclared row ranks after every declared one. */
export function proficiencyRank(proficiency: WeaponProficiency | null): number {
  if (proficiency === null) return WEAPON_PROFICIENCIES.length;
  return WEAPON_PROFICIENCIES.indexOf(proficiency);
}

/** Canonical weapon key for a catalog identifier, tier and enchantment stripped. */
export function weaponKeyForIdentifier(identifier: string): string {
  return `weapon:${albionBaseIdentifier(identifier).split('@')[0]}`;
}

/** An editable weapon row. `proficiency: null` with `locked` is a lock-only row (never declared). */
export interface WeaponDraft {
  weapon_key: string;
  weapon_name: string;
  proficiency: WeaponProficiency | null;
  locked: boolean;
}

export function draftsFromWeapons(rows: readonly UserWeapon[]): WeaponDraft[] {
  return sortWeaponDrafts(
    rows.map((row) => ({
      weapon_key: row.weapon_key,
      weapon_name: row.weapon_name,
      proficiency: row.proficiency,
      locked: row.locked,
    })),
  );
}

/** Main, good, basic, then lock-only rows; alphabetical inside each level. */
export function sortWeaponDrafts(drafts: readonly WeaponDraft[]): WeaponDraft[] {
  return [...drafts].sort(
    (left, right) =>
      proficiencyRank(left.proficiency) - proficiencyRank(right.proficiency) ||
      left.weapon_name.localeCompare(right.weapon_name),
  );
}

/** Body for `PUT /api/users/me/weapons`: declared, unlocked rows only (locked rows are server-owned). */
export function updateMyWeaponsRequest(drafts: readonly WeaponDraft[]): UpdateMyWeaponsRequest {
  return {
    weapons: drafts.flatMap((draft) =>
      draft.proficiency && !draft.locked
        ? [{ weapon_key: draft.weapon_key, proficiency: draft.proficiency }]
        : [],
    ),
  };
}

/** Body for `PUT /api/users/{id}/weapons`: rows that carry neither a level nor a lock are dropped. */
export function manageUserWeaponsRequest(drafts: readonly WeaponDraft[]): ManageUserWeaponsRequest {
  return {
    weapons: drafts.flatMap((draft) =>
      draft.proficiency || draft.locked
        ? [{ weapon_key: draft.weapon_key, proficiency: draft.proficiency, locked: draft.locked }]
        : [],
    ),
  };
}

/** True when the drafts differ from the saved list (order-insensitive). */
export function weaponDraftsChanged(
  saved: readonly WeaponDraft[],
  current: readonly WeaponDraft[],
): boolean {
  const key = (draft: WeaponDraft) =>
    `${draft.weapon_key}|${draft.proficiency ?? ''}|${draft.locked ? 1 : 0}`;
  const left = saved.map(key).sort();
  const right = current.map(key).sort();
  return left.length !== right.length || left.some((entry, index) => entry !== right[index]);
}

/** Family a weapon key (`weapon:{BASE}`) belongs to, for grouping the list. */
export function weaponFamilyOfKey(weaponKey: string): WeaponFamilyId {
  return classifyWeaponFamily(weaponKey.replace(/^weapon:/, ''));
}

/** Weapons of one family, alphabetical so changing a level never moves a row. */
export interface WeaponGroup {
  readonly family: WeaponFamilyId;
  readonly drafts: readonly WeaponDraft[];
}

/** Groups drafts by weapon family in display order; empty families are omitted. */
export function groupWeaponDrafts(drafts: readonly WeaponDraft[]): WeaponGroup[] {
  const byFamily = new Map<WeaponFamilyId, WeaponDraft[]>();
  for (const draft of drafts) {
    const family = weaponFamilyOfKey(draft.weapon_key);
    const group = byFamily.get(family);
    if (group) group.push(draft);
    else byFamily.set(family, [draft]);
  }
  return weaponFamilyOrder()
    .filter((family) => byFamily.has(family))
    .map((family) => ({
      family,
      drafts: (byFamily.get(family) ?? []).sort((left, right) =>
        left.weapon_name.localeCompare(right.weapon_name),
      ),
    }));
}

/** How many weapons sit at each level, and how many an officer locked. */
export interface WeaponSummary {
  readonly main: number;
  readonly good: number;
  readonly basic: number;
  readonly locked: number;
}

export function summarizeWeaponDrafts(drafts: readonly WeaponDraft[]): WeaponSummary {
  const count = (level: WeaponProficiency) =>
    drafts.filter((draft) => draft.proficiency === level).length;
  return {
    main: count('main'),
    good: count('good'),
    basic: count('basic'),
    locked: drafts.filter((draft) => draft.locked).length,
  };
}

/** A weapon the picker can add. */
export interface WeaponOption {
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly family: WeaponFamilyId;
}

/** Tier-less catalog weapons, grouped by family and alphabetical inside. */
export function weaponOptionsFromCatalog(catalog: readonly OpenAlbionItem[]): WeaponOption[] {
  const familyOrder = weaponFamilyOrder();
  return deduplicateAlbionCombatCatalog(catalog)
    .filter((item) => item.type === 'weapon' && item.identifier)
    .map((item) => ({
      key: weaponKeyForIdentifier(item.identifier ?? ''),
      name: item.name,
      icon: item.icon ?? null,
      family: classifyWeaponFamily(item.identifier ?? ''),
    }))
    .sort(
      (left, right) =>
        familyOrder.indexOf(left.family) - familyOrder.indexOf(right.family) ||
        left.name.localeCompare(right.name),
    );
}

/** One row of the "My weapons" grid: a catalog weapon merged with the member's declaration. */
export interface WeaponEntry {
  readonly key: string;
  readonly name: string;
  readonly family: WeaponFamilyId;
  readonly proficiency: WeaponProficiency | null;
  readonly locked: boolean;
  /** Lower-cased name, so a keystroke filter does no string work per row. */
  readonly search: string;
}

/**
 * Every catalog weapon with the member's level and lock merged in. A declared or locked weapon the
 * catalog does not list (a removed or unknown item) is kept so it never silently disappears.
 */
export function buildWeaponEntries(
  options: readonly WeaponOption[],
  drafts: readonly WeaponDraft[],
): WeaponEntry[] {
  const byKey = new Map(drafts.map((draft) => [draft.weapon_key, draft] as const));
  const entries: WeaponEntry[] = options.map((option) => {
    const draft = byKey.get(option.key);
    byKey.delete(option.key);
    return {
      key: option.key,
      name: option.name,
      family: option.family,
      proficiency: draft?.proficiency ?? null,
      locked: draft?.locked ?? false,
      search: option.name.toLowerCase(),
    };
  });
  for (const draft of byKey.values()) {
    entries.push({
      key: draft.weapon_key,
      name: draft.weapon_name,
      family: weaponFamilyOfKey(draft.weapon_key),
      proficiency: draft.proficiency,
      locked: draft.locked,
      search: draft.weapon_name.toLowerCase(),
    });
  }
  return entries;
}

/** Which weapons the grid shows, by declaration. */
export type WeaponLevelFilter = 'all' | 'declared' | WeaponProficiency | 'undeclared' | 'locked';

export interface WeaponFilters {
  readonly query: string;
  readonly family: WeaponFamilyId | 'all';
  readonly level: WeaponLevelFilter;
}

/** True when any filter narrows the grid. */
export function weaponFiltersActive(filters: WeaponFilters): boolean {
  return filters.query.trim() !== '' || filters.family !== 'all' || filters.level !== 'all';
}

function matchesLevel(entry: WeaponEntry, level: WeaponLevelFilter): boolean {
  switch (level) {
    case 'all':
      return true;
    case 'declared':
      return entry.proficiency !== null;
    case 'undeclared':
      return entry.proficiency === null;
    case 'locked':
      return entry.locked;
    default:
      return entry.proficiency === level;
  }
}

/** Entries that satisfy the name search, the family and the level filter. */
export function filterWeaponEntries(
  entries: readonly WeaponEntry[],
  filters: WeaponFilters,
): WeaponEntry[] {
  const query = filters.query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filters.family === 'all' || entry.family === filters.family) &&
      matchesLevel(entry, filters.level) &&
      (query === '' || entry.search.includes(query)),
  );
}

/** Weapons of one family for the grid; `declared` counts the group's declared weapons. */
export interface WeaponEntryGroup {
  readonly family: WeaponFamilyId;
  readonly entries: readonly WeaponEntry[];
  readonly declared: number;
}

/** Groups entries by family in display order, alphabetical inside; empty families are omitted. */
export function groupWeaponEntries(entries: readonly WeaponEntry[]): WeaponEntryGroup[] {
  const byFamily = new Map<WeaponFamilyId, WeaponEntry[]>();
  for (const entry of entries) {
    const group = byFamily.get(entry.family);
    if (group) group.push(entry);
    else byFamily.set(entry.family, [entry]);
  }
  return weaponFamilyOrder()
    .filter((family) => byFamily.has(family))
    .map((family) => {
      const members = (byFamily.get(family) ?? []).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      return {
        family,
        entries: members,
        declared: members.filter((entry) => entry.proficiency !== null).length,
      };
    });
}

/** How many weapons differ between the saved list and the current drafts (the unsaved count). */
export function countWeaponDraftChanges(
  saved: readonly WeaponDraft[],
  current: readonly WeaponDraft[],
): number {
  const signature = (draft: WeaponDraft) => `${draft.proficiency ?? ''}|${draft.locked ? 1 : 0}`;
  const before = new Map(saved.map((draft) => [draft.weapon_key, signature(draft)] as const));
  const after = new Map(current.map((draft) => [draft.weapon_key, signature(draft)] as const));
  let changes = 0;
  for (const [key, value] of after) if (before.get(key) !== value) changes += 1;
  for (const key of before.keys()) if (!after.has(key)) changes += 1;
  return changes;
}

/** How a member stands against one weapon, from best to worst for filling a seat of it. */
export type WeaponFit =
  | WeaponProficiency
  | 'no_declarations'
  | 'not_declared'
  | 'locked';

const WEAPON_FIT_RANK: Readonly<Record<WeaponFit, number>> = {
  main: 0,
  good: 1,
  basic: 2,
  no_declarations: 3,
  not_declared: 4,
  locked: 5,
};

/**
 * A member's fit for a seat's weapon. `null` when the seat has no weapon, because there is then
 * nothing to compare. A locked weapon always wins over a declared level. A member with no
 * declaration at all is `no_declarations` (not yet using the feature), distinct from one who
 * declared other weapons but not this one.
 */
export function weaponFit(
  weapons: readonly ParticipantWeapon[] | null | undefined,
  weaponKey: string | null | undefined,
): WeaponFit | null {
  if (!weaponKey) return null;
  const rows = weapons ?? [];
  const row = rows.find((candidate) => candidate.weapon_key === weaponKey);
  if (row?.locked) return 'locked';
  if (row?.proficiency) return row.proficiency;
  return rows.some((candidate) => candidate.proficiency) ? 'not_declared' : 'no_declarations';
}

/** Board warning for the member sitting on a seat: danger when locked, warning when not declared. */
export type SeatWeaponWarning = 'locked' | 'not_declared';

export function seatWeaponWarning(
  weapons: readonly ParticipantWeapon[] | null | undefined,
  weaponKey: string | null | undefined,
): SeatWeaponWarning | null {
  const fit = weaponFit(weapons, weaponKey);
  return fit === 'locked' || fit === 'not_declared' ? fit : null;
}

/**
 * Orders the waiting list for a seat: main, good, basic, no declarations, not declared, locked.
 * Stable, so members of the same fit keep their signup order. Without a seat weapon the list is
 * returned as-is.
 */
export function sortBenchForWeapon<T extends { weapons?: readonly ParticipantWeapon[] | null }>(
  bench: readonly T[],
  weaponKey: string | null | undefined,
): T[] {
  if (!weaponKey) return [...bench];
  const rank = (member: T) => WEAPON_FIT_RANK[weaponFit(member.weapons, weaponKey) ?? 'no_declarations'];
  return bench
    .map((member, index) => ({ member, index, rank: rank(member) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.member);
}

/** Builds sharing one weapon (or none, when `key` is `null`). */
export interface BuildWeaponGroup<T> {
  readonly key: string | null;
  readonly name: string | null;
  readonly builds: readonly T[];
}

/** Groups builds by weapon, alphabetically by weapon name; builds without a weapon come last. */
export function groupBuildsByWeapon<
  T extends { weapon_key?: string | null; weapon_name?: string | null },
>(builds: readonly T[]): BuildWeaponGroup<T>[] {
  const groups = new Map<string | null, { name: string | null; builds: T[] }>();
  for (const build of builds) {
    const key = build.weapon_key ?? null;
    const group = groups.get(key);
    if (group) {
      group.builds.push(build);
    } else {
      groups.set(key, { name: key ? (build.weapon_name ?? key) : null, builds: [build] });
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, name: group.name, builds: group.builds }))
    .sort((left, right) => {
      if (left.key === null) return 1;
      if (right.key === null) return -1;
      return (left.name ?? '').localeCompare(right.name ?? '');
    });
}
