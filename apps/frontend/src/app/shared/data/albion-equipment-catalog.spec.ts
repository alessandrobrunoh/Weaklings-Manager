import { describe, expect, it } from 'vitest';

import type { OpenAlbionItem } from '../../core/models/api.models';
import {
  albionCombatIconUrl,
  albionItemSupportsEnchantment,
  albionItemSupportsQuality,
  deduplicateAlbionCombatCatalog,
  filterAlbionEquipmentCatalog,
  isAlbionCatalogItemAvailable,
  isAlbionGatheringGear,
  normalizeAlbionEquipmentName,
} from './albion-equipment-catalog';

function item(identifier: string, tier: string): OpenAlbionItem {
  return {
    id: Number(`${tier.replace('T', '')}${identifier.length}`),
    name: identifier,
    tier,
    type: 'weapon',
    category_id: null,
    subcategory_id: null,
    identifier: `${tier}_${identifier}`,
    icon: null,
  };
}

describe('Albion equipment catalog names', () => {
  it('uses Albion weapon names instead of technical faction identifiers', () => {
    expect(normalizeAlbionEquipmentName('T8_MAIN_CURSEDSTAFF')).toBe('Cursed Staff');
    expect(normalizeAlbionEquipmentName('T8_2H_CURSEDSTAFF')).toBe('Great Cursed Staff');
    expect(normalizeAlbionEquipmentName('T8_MAIN_CURSEDSTAFF_UNDEAD')).toBe('Lifecurse Staff');
    expect(normalizeAlbionEquipmentName('T8_MAIN_CURSEDSTAFF_AVALON')).toBe('Shadowcaller');
    expect(normalizeAlbionEquipmentName('T8_MAIN_CURSEDSTAFF_CRYSTAL')).toBe('Rotcaller Staff');
    expect(normalizeAlbionEquipmentName('T8_MAIN_NATURESTAFF_CRYSTAL')).toBe('Forgebark Staff');
    expect(normalizeAlbionEquipmentName('T8_SHOES_PLATE_FEY')).toBe('Duskweaver Boots');
    expect(normalizeAlbionEquipmentName('T8_MEAL_PIE')).toBe('Pork Pie');
    expect(normalizeAlbionEquipmentName('T8_POTION_HEAL')).toBe('Healing Potion');
    expect(normalizeAlbionEquipmentName('T8_ARMOR_PLATE_SET1')).toBe('Soldier Armor');
    expect(normalizeAlbionEquipmentName('T8_UNKNOWN_THING', 'Friendly Name')).toBe('Friendly Name');
  });

  it('finds tiered catalog identifiers in their matching equipment slot', () => {
    const kingmaker = {
      ...item('2H_CLAYMORE_AVALON', 'T8'),
      name: 'Kingmaker',
    };

    expect(filterAlbionEquipmentCatalog([kingmaker], 'Kingmaker', 'weapon', 'T8')).toEqual([
      kingmaker,
    ]);
  });

  it('finds Rotcaller Staff when searched as Rootcaller', () => {
    const rotcaller = {
      ...item('MAIN_CURSEDSTAFF_CRYSTAL', 'T8'),
      name: 'Rotcaller Staff',
    };

    expect(filterAlbionEquipmentCatalog([rotcaller], 'Rootcaller', 'weapon', 'T8')).toEqual([
      rotcaller,
    ]);
  });

  it('only offers real consumable tiers', () => {
    expect(isAlbionCatalogItemAvailable('T2_POTION_HEAL')).toBe(true);
    expect(isAlbionCatalogItemAvailable('T3_POTION_HEAL')).toBe(false);
    expect(isAlbionCatalogItemAvailable('T3_MEAL_PIE')).toBe(true);
    expect(isAlbionCatalogItemAvailable('T4_MEAL_PIE')).toBe(false);
    expect(isAlbionCatalogItemAvailable('T8_MEAL_STEW')).toBe(true);
    expect(isAlbionCatalogItemAvailable('T7_MEAL_STEW')).toBe(false);
  });

  it('does not expose quality controls for consumables or mounts', () => {
    expect(albionItemSupportsQuality('T8_MAIN_SWORD')).toBe(true);
    expect(albionItemSupportsQuality('T4_POTION_HEAL')).toBe(false);
    expect(albionItemSupportsQuality('T8_MEAL_STEW')).toBe(false);
    expect(albionItemSupportsQuality('T8_MOUNT_HORSE')).toBe(false);
    expect(albionItemSupportsEnchantment('T8_MAIN_SWORD')).toBe(true);
    expect(albionItemSupportsEnchantment('T8_MOUNT_HORSE')).toBe(false);
  });

  it('keeps one specialization node per weapon family across all tiers', () => {
    const catalog = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].flatMap((tier) => [
      item('MAIN_CURSEDSTAFF', tier),
      item('2H_CURSEDSTAFF', tier),
    ]);

    const nodes = deduplicateAlbionCombatCatalog(catalog);

    expect(nodes).toHaveLength(2);
    expect(nodes.map(({ identifier, name }) => ({ identifier, name }))).toEqual([
      { identifier: 'MAIN_CURSEDSTAFF', name: 'Cursed Staff' },
      { identifier: '2H_CURSEDSTAFF', name: 'Great Cursed Staff' },
    ]);
    expect(nodes[0].icon).toBe(albionCombatIconUrl('MAIN_CURSEDSTAFF'));
    expect(nodes[0].icon).toContain('T8_MAIN_CURSEDSTAFF');
  });

  it('asks the render CDN for T8 unique names, not T1', () => {
    expect(albionCombatIconUrl('T1_2H_BOW')).toContain('T8_2H_BOW');
    expect(albionCombatIconUrl('2H_BOW_HELL')).toContain('T8_2H_BOW_HELL');
    expect(albionCombatIconUrl('2H_BOW')).toContain('size=96');
  });

  it('keeps gathering gear out of the combat catalog', () => {
    expect(isAlbionGatheringGear('HEAD_GATHERER_ORE')).toBe(true);
    expect(isAlbionGatheringGear('T8_SHOES_GATHERER_WOOD')).toBe(true);
    expect(isAlbionGatheringGear('HEAD_PLATE_SET1')).toBe(false);

    const catalog: OpenAlbionItem[] = [
      { ...item('2H_BOW', 'T8'), type: 'weapon' },
      {
        id: 99,
        name: 'Miner Cap',
        tier: 'T8',
        type: 'armor',
        category_id: null,
        subcategory_id: null,
        identifier: 'T8_HEAD_GATHERER_ORE',
        icon: null,
      },
    ];

    expect(deduplicateAlbionCombatCatalog(catalog).map((row) => row.identifier)).toEqual(['2H_BOW']);
  });
});
