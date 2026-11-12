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
