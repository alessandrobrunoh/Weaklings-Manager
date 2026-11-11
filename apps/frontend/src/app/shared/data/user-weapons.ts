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
  destinyWeaponFamilyOrder,
  type DestinyItemNode,
  type DestinyWeaponFamilyId,
} from './albion-destiny-board';
import {
  albionSpecializationIdentifier,
  deduplicateAlbionCombatCatalog,
} from './albion-equipment-catalog';

/**
 * "My weapons": the weapons a member declares they can play, each with a level. Pure helpers shared
 * by the profile, the admin member view, the event signup dialog, the Parties board and the builds
 * page. A weapon key is `weapon:{BASE}` (tier-less base identifier), the Destiny Board node key.
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
  return `weapon:${albionSpecializationIdentifier(identifier).split('@')[0]}`;
}

/** Destiny Board level to proficiency used by "Import from Destiny Board": 100+ main, 50+ good, 1+ basic. */
export function proficiencyFromSpecLevel(level: number): WeaponProficiency | null {
  if (!Number.isFinite(level) || level < 1) return null;
  if (level >= 100) return 'main';
  if (level >= 50) return 'good';
  return 'basic';
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

/**
 * Pre-fills drafts from the Destiny Board without saving anything.
 *
 * Weapons the member has not declared yet are added at the level their spec implies. Anything
 * already declared keeps its level (an explicit choice beats an inferred one) and a locked weapon
 * is never touched.
 */
export function importDraftsFromSpecs(
  drafts: readonly WeaponDraft[],
  nodes: readonly DestinyItemNode[],
): { drafts: WeaponDraft[]; added: number } {
  const byKey = new Map(drafts.map((draft) => [draft.weapon_key, draft]));
  let added = 0;
  for (const node of nodes) {
    if (node.category !== 'weapon') continue;
    const proficiency = proficiencyFromSpecLevel(node.level);
    if (proficiency === null) continue;
    const existing = byKey.get(node.node_key);
    if (existing?.locked || existing?.proficiency) continue;
    byKey.set(node.node_key, {
      weapon_key: node.node_key,
      weapon_name: existing?.weapon_name ?? node.node_name,
      proficiency,
      locked: false,
    });
    added += 1;
  }
  return { drafts: sortWeaponDrafts([...byKey.values()]), added };
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

/** A weapon the picker can add. */
export interface WeaponOption {
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly family: DestinyWeaponFamilyId;
}

/** Tier-less catalog weapons, grouped by family in Destiny Board order and alphabetical inside. */
export function weaponOptionsFromCatalog(catalog: readonly OpenAlbionItem[]): WeaponOption[] {
  const familyOrder = destinyWeaponFamilyOrder();
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
