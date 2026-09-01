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
