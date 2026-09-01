import { describe, expect, it } from 'vitest';

import type { BuildItemSlot, BuildLoadout } from '../../core/models/api.models';
import { itemsForLoadout } from './build-loadouts';

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

  it('returns an empty swap for a build that has none', () => {
    expect(itemsForLoadout([item('weapon', 'main', 'Polehammer')], 'swap')).toEqual([]);
  });
});
