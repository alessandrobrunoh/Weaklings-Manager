import type { BuildItemSlot, BuildLoadout, BuildSlot } from '../../core/models/api.models';

/**
 * Sorted slot order used for rendering the equipment grid consistently
 * across the detail page and the create form on the parent comps page.
 */
export const SLOT_ORDER: readonly BuildSlot[] = [
  'weapon',
  'off_hand',
  'head',
  'armor',
  'shoes',
  'cape',
  'bag',
  'potion',
  'food',
  'mount',
];

/** Compares two build items by their canonical slot order for stable rendering. */
export function sortBySlotOrder(left: BuildItemSlot, right: BuildItemSlot): number {
  return SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot);
}

/**
 * Splits a build's items into one loadout, in canonical slot order.
 *
 * A build carries its main set and, optionally, one swap — the alternative gear a player brings
 * for a specific matchup. Items stored before swaps existed have no `loadout`, so they read as
 * part of the main set rather than disappearing from both grids.
 *
 * @example
 * ```ts
 * const swap = itemsForLoadout(build.items, 'swap');
 * ```
 */
export function itemsForLoadout(
  items: readonly BuildItemSlot[],
  loadout: BuildLoadout,
): BuildItemSlot[] {
  return items
    .filter((item) => (item.loadout ?? 'main') === loadout)
    .sort(sortBySlotOrder);
}

/**
 * Tiers an item can be picked at, lowest first. One list for every surface that edits a loadout
 * (the build page and the create flow), so a build cannot be made at a tier the other cannot edit.
 */
export const ITEM_TIERS: readonly string[] = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

/**
 * Whether a weapon key (`weapon:2H_BOW`) names a two-handed weapon.
 *
 * Albion prefixes two-handed weapon identifiers with `2H_`; the key is the tier-less identifier, so
 * the prefix survives. Without a weapon the answer is `false`.
 */
export function isTwoHandedWeaponKey(weaponKey: string | null | undefined): boolean {
  return !!weaponKey && /^weapon:2H_/.test(weaponKey);
}

/** How many main-loadout slots a build with this weapon can fill: a two-handed weapon takes the off-hand. */
export function mainSlotCapacity(weaponKey: string | null | undefined): number {
  return SLOT_ORDER.length - (isTwoHandedWeaponKey(weaponKey) ? 1 : 0);
}

/** Filled and applicable main-loadout slots of a build summary: a full two-hander reads 9 of 9, not 9 of 10. */
export function mainSlotProgress(build: {
  readonly main_item_count: number;
  readonly weapon_key?: string | null;
}): { readonly filled: number; readonly total: number } {
  const total = mainSlotCapacity(build.weapon_key);
  return { filled: Math.min(Math.max(build.main_item_count, 0), total), total };
}

/**
 * Weapon key (`weapon:2H_BOW`) of the main-hand weapon in a loadout, read from its render URL.
 *
 * A draft item carries its icon (`.../item/T8_2H_BOW@1.png`) rather than its catalog identifier, and
 * the icon is enough to tell a two-handed weapon from a one-handed one. `null` when the loadout has
 * no weapon or its icon is not a render URL.
 */
export function weaponKeyOfItems(items: readonly BuildItemSlot[]): string | null {
  const weapon = items.find((item) => item.slot === 'weapon' && (item.loadout ?? 'main') === 'main');
  const match = weapon?.openalbion_item_icon?.match(/\/item\/(?:T\d+_)?([A-Za-z0-9_]+?)(?:%40\d+|@\d+)?\.png/);
  return match ? `weapon:${match[1].toUpperCase()}` : null;
}
