import { describe, expect, it } from 'vitest';

import type { OpenAlbionItemAbilities } from '../../core/models/api.models';
import {
  abilityCatalogKey,
  abilityKeyForItem,
  abilityName,
  abilitySlotsFor,
  albionAbilityIconUrl,
  withAbilityChoice,
} from './albion-abilities';

const SWORD: OpenAlbionItemAbilities = {
  label: 'Broadsword',
  slot_type: 'mainhand',
  two_handed: false,
  active_slots: 3,
  passive_slots: 1,
  active: {
    '1': [{ id: 'HEROICSTRIKE2', name: 'Heroic Strike' }],
    '2': [{ id: 'SWORD_SPIN', name: 'Blade Cyclone' }],
    '3': [{ id: 'MIGHTYBLOW', name: 'Mighty Blow' }],
  },
  passive: { '1': [{ id: 'PASSIVE_BLEEDCHANCE', name: 'Deep Cuts' }] },
};

const CHEST: OpenAlbionItemAbilities = {
  label: 'Soldier Armor',
  slot_type: 'armor',
  two_handed: false,
  active_slots: 1,
  passive_slots: 2,
  active: { '1': [{ id: 'TAUNT', name: 'Taunt' }] },
  passive: {
    '1': [{ id: 'PASSIVE_ARMOR_MR_AR', name: 'Toughness' }],
    '2': [{ id: 'PASSIVE_PLATEARMOR_THREATGENERATION', name: 'Protective Instinct' }],
  },
};

const OFF_HAND: OpenAlbionItemAbilities = {
  label: 'Shield',
  slot_type: 'offhand',
  two_handed: false,
  active_slots: 0,
  passive_slots: 0,
  active: {},
  passive: {},
};

describe('albion abilities', () => {
  it('labels a weapon’s active slots with the keys players actually press', () => {
    const slots = abilitySlotsFor('weapon', SWORD, undefined);

    expect(slots.filter((slot) => slot.kind === 'active').map((slot) => slot.label)).toEqual([
      'Q',
      'W',
      'E',
    ]);
  });

  it('binds each armor piece to its own key', () => {
    expect(abilitySlotsFor('head', CHEST, undefined)[0].label).toBe('D');
    expect(abilitySlotsFor('armor', CHEST, undefined)[0].label).toBe('R');
    expect(abilitySlotsFor('shoes', CHEST, undefined)[0].label).toBe('F');
  });

  it('numbers the passive slots only when the item has more than one', () => {
    expect(
      abilitySlotsFor('weapon', SWORD, undefined)
        .filter((slot) => slot.kind === 'passive')
        .map((slot) => slot.label),
    ).toEqual(['Passive']);

    expect(
      abilitySlotsFor('armor', CHEST, undefined)
        .filter((slot) => slot.kind === 'passive')
        .map((slot) => slot.label),
    ).toEqual(['Passive 1', 'Passive 2']);
  });

  it('gives chest armor one active and two passive pickers', () => {
    const slots = abilitySlotsFor('armor', CHEST, undefined);

    expect(slots.filter((slot) => slot.kind === 'active')).toHaveLength(1);
    expect(slots.filter((slot) => slot.kind === 'passive')).toHaveLength(2);
  });

  it('offers no picker at all for a slot with no abilities', () => {
    expect(abilitySlotsFor('off_hand', OFF_HAND, undefined)).toEqual([]);
    expect(abilitySlotsFor('cape', undefined, undefined)).toEqual([]);
  });

  it('marks the currently chosen ability in its slot', () => {
    const slots = abilitySlotsFor('weapon', SWORD, {
      active: { '1': 'HEROICSTRIKE2' },
      passive: {},
    });

    expect(slots[0].selected).toBe('HEROICSTRIKE2');
    expect(slots[1].selected).toBeNull();
  });

  it('reads back the chosen ability’s name', () => {
    const slots = abilitySlotsFor('weapon', SWORD, {
      active: { '3': 'MIGHTYBLOW' },
      passive: {},
    });

    expect(abilityName(slots, 'active', 3)).toBe('Mighty Blow');
    expect(abilityName(slots, 'active', 1)).toBeNull();
  });

  it('adds and clears one choice without disturbing the others', () => {
    const start = { active: { '1': 'HEROICSTRIKE2', '2': 'SWORD_SPIN' }, passive: {} };

    expect(withAbilityChoice(start, 'active', 3, 'MIGHTYBLOW').active).toEqual({
      '1': 'HEROICSTRIKE2',
      '2': 'SWORD_SPIN',
      '3': 'MIGHTYBLOW',
    });
    expect(withAbilityChoice(start, 'active', 2, null).active).toEqual({
      '1': 'HEROICSTRIKE2',
    });
    expect(start.active, 'the original selection must not be mutated').toEqual({
      '1': 'HEROICSTRIKE2',
      '2': 'SWORD_SPIN',
    });
  });

  it('recovers the catalog key from an item’s icon URL', () => {
    expect(
      abilityKeyForItem({
        openalbion_item_icon:
          'https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64',
      }),
    ).toBe('MAIN_SWORD');
    expect(
      abilityKeyForItem({
        openalbion_item_icon: 'https://render.albiononline.com/v1/item/T4_MAIN_SWORD@2.png',
      }),
    ).toBe('MAIN_SWORD');
    expect(abilityKeyForItem({ openalbion_item_icon: null })).toBeNull();
  });

  it('strips tier and enchantment from an identifier', () => {
    expect(abilityCatalogKey('T8_2H_HOLYSTAFF')).toBe('2H_HOLYSTAFF');
    expect(abilityCatalogKey('t4_main_sword@3')).toBe('MAIN_SWORD');
    expect(abilityCatalogKey('MAIN_SWORD')).toBe('MAIN_SWORD');
  });

  it('builds the spell icon URL on the CDN the app already uses', () => {
    expect(albionAbilityIconUrl('HEROICSTRIKE2')).toBe(
      'https://render.albiononline.com/v1/spell/HEROICSTRIKE2.png',
    );
  });
});
