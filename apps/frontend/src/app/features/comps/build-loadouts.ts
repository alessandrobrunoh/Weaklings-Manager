import type { BuildItemSlot, BuildLoadout, BuildSlot } from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';

/**
 * Reading order of a build, and the single list of slots a loadout has.
 *
 * Weapons first, then armour, then what the player carries. The build page, the loadout view, the
 * loadout editor, the version diff and the create flows all take their slot set and order from
 * here, so a slot can never exist in one place and not in another (the bag used to be counted by
 * one page and missing from the other).
 */
export const SLOT_ORDER: readonly BuildSlot[] = [
  'weapon',
  'off_hand',
  'head',
  'armor',
  'shoes',
  'cape',
  'bag',
  'food',
  'potion',
  'mount',
];

/** Slots a main loadout is expected to fill; an empty one is shown as "not set" rather than hidden. */
export const CORE_SLOTS: ReadonlySet<BuildSlot> = new Set<BuildSlot>([
  'weapon',
  'head',
  'armor',
  'shoes',
]);

/** Translation key of each slot's player-facing name. */
export const SLOT_LABEL_KEYS: Readonly<Record<BuildSlot, TranslationKey>> = {
  weapon: 'equipment.slot.weapon',
  off_hand: 'equipment.slot.offHand',
  head: 'equipment.slot.head',
  armor: 'equipment.slot.armor',
  shoes: 'equipment.slot.shoes',
  cape: 'equipment.slot.cape',
  bag: 'equipment.slot.bag',
  food: 'equipment.slot.food',
  potion: 'equipment.slot.potion',
  mount: 'equipment.slot.mount',
};

/** Tiers a build item can be picked at. Guild builds are T4 to T8 gear. */
export const BUILD_ITEM_TIERS: readonly string[] = ['T4', 'T5', 'T6', 'T7', 'T8'];

/** Tier a slot starts at when it is filled for the first time. */
export const DEFAULT_BUILD_ITEM_TIER = 'T8';

/** Food, potions and mounts have no quality grade. */
export function slotSupportsQuality(slot: BuildSlot): boolean {
  return slot !== 'potion' && slot !== 'food' && slot !== 'mount';
}

/** Mounts are plain tiered items; everything else can be enchanted. */
export function slotSupportsEnchantment(slot: BuildSlot): boolean {
  return slot !== 'mount';
}

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
