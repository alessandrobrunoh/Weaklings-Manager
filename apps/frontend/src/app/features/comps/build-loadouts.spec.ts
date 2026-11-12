import { describe, expect, it } from 'vitest';

import type { BuildItemSlot, BuildLoadout } from '../../core/models/api.models';
import {
  BUILD_ITEM_TIERS,
  CORE_SLOTS,
  DEFAULT_BUILD_ITEM_TIER,
  SLOT_LABEL_KEYS,
  SLOT_ORDER,
  itemsForLoadout,
  slotSupportsEnchantment,
  slotSupportsQuality,
  sortBySlotOrder,
} from './build-loadouts';

function item(
  slot: BuildItemSlot['slot'],
  loadout: BuildLoadout,
  name: string,
): BuildItemSlot {
  return {
    loadout,
    slot,
    openalbion_item_type: 'weapon',
    openalbion_item_id: 1,
    openalbion_item_name: name,
  };
}

describe('build loadouts', () => {
  it('splits a build into its main set and its swap', () => {
    const items = [
      item('weapon', 'main', 'Polehammer'),
      item('weapon', 'swap', 'Realmbreaker'),
      item('head', 'main', 'Knight Helmet'),
    ];

    expect(itemsForLoadout(items, 'main').map((entry) => entry.openalbion_item_name)).toEqual([
      'Polehammer',
      'Knight Helmet',
    ]);
    expect(itemsForLoadout(items, 'swap').map((entry) => entry.openalbion_item_name)).toEqual([
      'Realmbreaker',
    ]);
  });

  it('reads an item saved before swaps existed as part of the main set', () => {
    // Rows written before the `loadout` column existed arrive without the field at all.
    const { loadout: _dropped, ...withoutLoadout } = item('weapon', 'main', 'Polehammer');
    const legacy = withoutLoadout as BuildItemSlot;

    expect(itemsForLoadout([legacy], 'main')).toHaveLength(1);
    expect(itemsForLoadout([legacy], 'swap')).toHaveLength(0);
  });

  it('orders each loadout by the canonical slot order, not by insertion', () => {
    const items = [
      item('mount', 'main', 'Direwolf'),
      item('weapon', 'main', 'Polehammer'),
      item('head', 'main', 'Knight Helmet'),
    ];

    expect(itemsForLoadout(items, 'main').map((entry) => entry.slot)).toEqual([
      'weapon',
      'head',
      'mount',
    ]);
  });

  it('keeps one canonical slot order, weapon first and mount last', () => {
    expect(SLOT_ORDER).toEqual([
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
    ]);
    expect(Object.keys(SLOT_LABEL_KEYS).sort()).toEqual([...SLOT_ORDER].sort());
    expect(CORE_SLOTS.every((slot) => SLOT_ORDER.includes(slot))).toBe(true);
  });

  it('offers T4 to T8 for build items, with T8 as the default', () => {
    expect(BUILD_ITEM_TIERS).toEqual(['T4', 'T5', 'T6', 'T7', 'T8']);
    expect(BUILD_ITEM_TIERS).toContain(DEFAULT_BUILD_ITEM_TIER);
    expect(DEFAULT_BUILD_ITEM_TIER).toBe('T8');
  });

  it('knows which slots carry a quality and an enchantment', () => {
    expect(slotSupportsQuality('weapon')).toBe(true);
    expect(slotSupportsQuality('food')).toBe(false);
    expect(slotSupportsEnchantment('head')).toBe(true);
    expect(slotSupportsEnchantment('mount')).toBe(false);
  });

  it('compares two items by slot order so any list can be sorted with it', () => {
    const items = [item('mount', 'main', 'Horse'), item('weapon', 'main', 'Bow')];

    expect([...items].sort(sortBySlotOrder).map((entry) => entry.slot)).toEqual(['weapon', 'mount']);
    expect(items.map((entry) => entry.slot)).toEqual(['mount', 'weapon']);
  });

  it('returns an empty swap for a build that has none', () => {
    expect(itemsForLoadout([item('weapon', 'main', 'Polehammer')], 'swap')).toEqual([]);
  });
});
