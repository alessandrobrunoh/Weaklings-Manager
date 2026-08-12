import type { BuildSlot, OpenAlbionItem } from '../../core/models/api.models';

/**
 * Local Albion equipment catalogue used by build pickers.
 *
 * The OpenAlbion search endpoint is intentionally bypassed for build authoring
 * so officers only see the curated item families that the guild supports.
 * Entries are stored as item base identifiers; the picker expands them with
 * the selected tier at runtime to produce Albion render identifiers such as
 * `T8_2H_BOW`.
 *
 * @example
 * ```ts
 * const weapons = searchAlbionEquipmentCatalog('bow', 'weapon', 'T8');
 * console.log(weapons[0]?.identifier); // "T8_2H_BOW"
 * ```
 */
export const ALBION_EQUIPMENT_FILE_NAMES: readonly string[] = [
  'OFF_SHIELD',
  'OFF_TOWERSHIELD_UNDEAD',
  'OFF_SHIELD_HELL',
  'OFF_SPIKEDSHIELD_MORGANA',
  'OFF_SHIELD_AVALON',
  'OFF_SHIELD_CRYSTAL',
  'OFF_BOOK',
  'OFF_ORB_MORGANA',
  'OFF_DEMONSKULL_HELL',
  'OFF_TOTEM_KEEPER',
  'OFF_CENSER_AVALON',
  'OFF_TOME_CRYSTAL',
  'OFF_TORCH',
  'OFF_HORN_KEEPER',
  'OFF_TALISMAN_AVALON',
  'OFF_LAMP_UNDEAD',
  'OFF_JESTERCANE_HELL',
  'OFF_TORCH_CRYSTAL',
  'CAPE',
  'CAPEITEM_FW_BRIDGEWATCH',
  'CAPEITEM_FW_FORTSTERLING',
  'CAPEITEM_FW_LYMHURST',
  'CAPEITEM_FW_MARTLOCK',
  'CAPEITEM_FW_THETFORD',
  'CAPEITEM_FW_CAERLEON',
  'CAPEITEM_FW_BRECILIEN',
  'CAPEITEM_AVALON',
  'CAPEITEM_SMUGGLER',
  'CAPEITEM_HERETIC',
  'CAPEITEM_UNDEAD',
  'CAPEITEM_KEEPER',
  'CAPEITEM_MORGANA',
  'CAPEITEM_DEMON',
  'BAG',
  'BAG_INSIGHT',
  'HEAD_PLATE_SET1',
  'ARMOR_PLATE_SET1',
  'SHOES_PLATE_SET1',
  'HEAD_PLATE_SET2',
  'ARMOR_PLATE_SET2',
  'SHOES_PLATE_SET2',
  'HEAD_PLATE_SET3',
  'ARMOR_PLATE_SET3',
  'SHOES_PLATE_SET3',
  'HEAD_PLATE_UNDEAD',
  'ARMOR_PLATE_UNDEAD',
  'SHOES_PLATE_UNDEAD',
  'HEAD_PLATE_HELL',
  'ARMOR_PLATE_HELL',
  'SHOES_PLATE_HELL',
  'HEAD_PLATE_KEEPER',
  'ARMOR_PLATE_KEEPER',
  'SHOES_PLATE_KEEPER',
  'HEAD_PLATE_FEY',
  'ARMOR_PLATE_FEY',
  'SHOES_PLATE_FEY',
  'HEAD_PLATE_AVALON',
  'ARMOR_PLATE_AVALON',
  'SHOES_PLATE_AVALON',
  'HEAD_LEATHER_SET1',
  'ARMOR_LEATHER_SET1',
  'SHOES_LEATHER_SET1',
  'HEAD_LEATHER_SET2',
  'ARMOR_LEATHER_SET2',
  'SHOES_LEATHER_SET2',
  'HEAD_LEATHER_SET3',
  'ARMOR_LEATHER_SET3',
  'SHOES_LEATHER_SET3',
  'HEAD_LEATHER_MORGANA',
  'ARMOR_LEATHER_MORGANA',
  'SHOES_LEATHER_MORGANA',
  'HEAD_LEATHER_HELL',
  'ARMOR_LEATHER_HELL',
  'SHOES_LEATHER_HELL',
  'HEAD_LEATHER_UNDEAD',
  'ARMOR_LEATHER_UNDEAD',
  'SHOES_LEATHER_UNDEAD',
  'HEAD_LEATHER_FEY',
  'ARMOR_LEATHER_FEY',
  'SHOES_LEATHER_FEY',
  'HEAD_LEATHER_AVALON',
  'ARMOR_LEATHER_AVALON',
  'SHOES_LEATHER_AVALON',
  'HEAD_CLOTH_SET1',
  'ARMOR_CLOTH_SET1',
  'SHOES_CLOTH_SET1',
  'HEAD_CLOTH_SET2',
  'ARMOR_CLOTH_SET2',
  'SHOES_CLOTH_SET2',
  'HEAD_CLOTH_SET3',
  'ARMOR_CLOTH_SET3',
  'SHOES_CLOTH_SET3',
  'HEAD_CLOTH_KEEPER',
  'ARMOR_CLOTH_KEEPER',
  'SHOES_CLOTH_KEEPER',
  'HEAD_CLOTH_HELL',
  'ARMOR_CLOTH_HELL',
  'SHOES_CLOTH_HELL',
  'HEAD_CLOTH_MORGANA',
  'ARMOR_CLOTH_MORGANA',
  'SHOES_CLOTH_MORGANA',
  'HEAD_CLOTH_FEY',
  'ARMOR_CLOTH_FEY',
  'SHOES_CLOTH_FEY',
  'HEAD_CLOTH_AVALON',
  'ARMOR_CLOTH_AVALON',
  'SHOES_CLOTH_AVALON',
  'HEAD_CLOTH_ROYAL',
  'ARMOR_CLOTH_ROYAL',
  'SHOES_CLOTH_ROYAL',
  'HEAD_LEATHER_ROYAL',
  'ARMOR_LEATHER_ROYAL',
  'SHOES_LEATHER_ROYAL',
  'HEAD_PLATE_ROYAL',
  'ARMOR_PLATE_ROYAL',
  'SHOES_PLATE_ROYAL',
  'HEAD_GATHERER_FIBER',
  'ARMOR_GATHERER_FIBER',
  'SHOES_GATHERER_FIBER',
  'BACKPACK_GATHERER_FIBER',
  'HEAD_GATHERER_HIDE',
  'ARMOR_GATHERER_HIDE',
  'SHOES_GATHERER_HIDE',
  'BACKPACK_GATHERER_HIDE',
  'HEAD_GATHERER_ORE',
  'ARMOR_GATHERER_ORE',
  'SHOES_GATHERER_ORE',
  'BACKPACK_GATHERER_ORE',
  'HEAD_GATHERER_ROCK',
  'ARMOR_GATHERER_ROCK',
  'SHOES_GATHERER_ROCK',
  'BACKPACK_GATHERER_ROCK',
  'HEAD_GATHERER_WOOD',
  'ARMOR_GATHERER_WOOD',
  'SHOES_GATHERER_WOOD',
  'BACKPACK_GATHERER_WOOD',
  'HEAD_GATHERER_FISH',
  'ARMOR_GATHERER_FISH',
  'SHOES_GATHERER_FISH',
  'BACKPACK_GATHERER_FISH',
  '2H_BOW',
  '2H_WARBOW',
  '2H_LONGBOW',
  '2H_LONGBOW_UNDEAD',
  '2H_BOW_HELL',
  '2H_BOW_KEEPER',
  '2H_BOW_AVALON',
  '2H_BOW_CRYSTAL',
  '2H_CROSSBOW',
  '2H_CROSSBOWLARGE',
  'MAIN_1HCROSSBOW',
  '2H_REPEATINGCROSSBOW_UNDEAD',
  '2H_DUALCROSSBOW_HELL',
  '2H_CROSSBOWLARGE_MORGANA',
  '2H_CROSSBOW_CANNON_AVALON',
  '2H_DUALCROSSBOW_CRYSTAL',
  'MAIN_CURSEDSTAFF',
  '2H_CURSEDSTAFF',
  '2H_DEMONICSTAFF',
  'MAIN_CURSEDSTAFF_UNDEAD',
  '2H_SKULLORB_HELL',
  '2H_CURSEDSTAFF_MORGANA',
  'MAIN_CURSEDSTAFF_AVALON',
  'MAIN_CURSEDSTAFF_CRYSTAL',
  'MAIN_FIRESTAFF',
  '2H_FIRESTAFF',
  '2H_INFERNOSTAFF',
  'MAIN_FIRESTAFF_KEEPER',
  '2H_FIRESTAFF_HELL',
  '2H_INFERNOSTAFF_MORGANA',
  '2H_FIRE_RINGPAIR_AVALON',
  'MAIN_FIRESTAFF_CRYSTAL',
  'MAIN_FROSTSTAFF',
  '2H_FROSTSTAFF',
  '2H_GLACIALSTAFF',
  'MAIN_FROSTSTAFF_KEEPER',
  '2H_ICEGAUNTLETS_HELL',
  '2H_ICECRYSTAL_UNDEAD',
  'MAIN_FROSTSTAFF_AVALON',
  '2H_FROSTSTAFF_CRYSTAL',
  'MAIN_ARCANESTAFF',
  '2H_ARCANESTAFF',
  '2H_ENIGMATICSTAFF',
  'MAIN_ARCANESTAFF_UNDEAD',
  '2H_ARCANESTAFF_HELL',
  '2H_ENIGMATICORB_MORGANA',
  '2H_ARCANE_RINGPAIR_AVALON',
  '2H_ARCANESTAFF_CRYSTAL',
  'MAIN_HOLYSTAFF',
  '2H_HOLYSTAFF',
  '2H_DIVINESTAFF',
  'MAIN_HOLYSTAFF_MORGANA',
  '2H_HOLYSTAFF_HELL',
  '2H_HOLYSTAFF_UNDEAD',
  'MAIN_HOLYSTAFF_AVALON',
  '2H_HOLYSTAFF_CRYSTAL',
  'MAIN_NATURESTAFF',
  '2H_NATURESTAFF',
  '2H_WILDSTAFF',
  'MAIN_NATURESTAFF_KEEPER',
  '2H_NATURESTAFF_HELL',
  '2H_NATURESTAFF_KEEPER',
  'MAIN_NATURESTAFF_AVALON',
  'MAIN_NATURESTAFF_CRYSTAL',
  'MAIN_DAGGER',
  '2H_DAGGERPAIR',
  '2H_CLAWPAIR',
  'MAIN_RAPIER_MORGANA',
  'MAIN_RAPIER_MORGANA',
  'MAIN_DAGGER_HELL',
  '2H_DUALSICKLE_UNDEAD',
  '2H_DAGGER_KATAR_AVALON',
  '2H_DAGGERPAIR_CRYSTAL',
  'MAIN_SPEAR',
  '2H_SPEAR',
  '2H_GLAIVE',
  'MAIN_SPEAR_KEEPER',
  '2H_HARPOON_HELL',
  '2H_TRIDENT_UNDEAD',
  'MAIN_SPEAR_LANCE_AVALON',
  '2H_GLAIVE_CRYSTAL',
  'MAIN_AXE',
  '2H_AXE',
  '2H_HALBERD',
  '2H_HALBERD_MORGANA',
  '2H_SCYTHE_HELL',
  '2H_DUALAXE_KEEPER',
  '2H_AXE_AVALON',
  '2H_SCYTHE_CRYSTAL',
  'MAIN_SWORD',
  '2H_CLAYMORE',
  '2H_DUALSWORD',
  'MAIN_SCIMITAR_MORGANA',
  '2H_CLEAVER_HELL',
  '2H_DUALSCIMITAR_UNDEAD',
  '2H_CLAYMORE_AVALON',
  'MAIN_SWORD_CRYSTAL',
  '2H_QUARTERSTAFF',
  '2H_IRONCLADEDSTAFF',
  '2H_DOUBLEBLADEDSTAFF',
  '2H_COMBATSTAFF_MORGANA',
  '2H_TWINSCYTHE_HELL',
  '2H_ROCKSTAFF_KEEPER',
  '2H_QUARTERSTAFF_AVALON',
  '2H_DOUBLEBLADEDSTAFF_CRYSTAL',
  'MAIN_HAMMER',
  '2H_POLEHAMMER',
  '2H_HAMMER',
  '2H_HAMMER_UNDEAD',
  '2H_DUALHAMMER_HELL',
  '2H_RAM_KEEPER',
  '2H_HAMMER_AVALON',
  '2H_HAMMER_CRYSTAL',
  'MAIN_MACE',
  '2H_MACE',
  '2H_FLAIL',
  'MAIN_ROCKMACE_KEEPER',
  'MAIN_MACE_HELL',
  '2H_MACE_MORGANA',
  '2H_DUALMACE_AVALON',
  'MAIN_MACE_CRYSTAL',
  '2H_KNUCKLES_SET1',
  '2H_KNUCKLES_SET2',
  '2H_KNUCKLES_SET3',
  '2H_KNUCKLES_KEEPER',
  '2H_KNUCKLES_HELL',
  '2H_KNUCKLES_MORGANA',
  '2H_KNUCKLES_AVALON',
  '2H_KNUCKLES_CRYSTAL',
  '2H_SHAPESHIFTER_SET1',
  '2H_SHAPESHIFTER_SET2',
  '2H_SHAPESHIFTER_SET3',
  '2H_SHAPESHIFTER_MORGANA',
  '2H_SHAPESHIFTER_HELL',
  '2H_SHAPESHIFTER_KEEPER',
  '2H_SHAPESHIFTER_AVALON',
  '2H_SHAPESHIFTER_CRYSTAL',
  'MEAL_PIE',
  'MEAL_PIE_FISH',
  'MEAL_OMELETTE',
  'MEAL_OMELETTE_FISH',
  'MEAL_OMELETTE_AVALON',
  'MEAL_STEW',
  'MEAL_STEW_FISH',
  'MEAL_STEW_AVALON',
  'MEAL_SANDWICH',
  'MEAL_SANDWICH_FISH',
  'MEAL_SANDWICH_AVALON',
  'MEAL_ROAST',
  'MEAL_ROAST_FISH',
  'POTION_HEAL',
  'POTION_ENERGY',
  'POTION_REVIVE',
  'POTION_STONESKIN',
  'POTION_SLOWFIELD',
  'POTION_MOB_RESET',
  'POTION_CLEANSE2',
  'POTION_ACID',
  'POTION_BERSERK',
  'POTION_LAVA',
  'POTION_GATHER',
  'POTION_TORNADO',
];

/**
 * Filters the local equipment catalogue by slot, tier and text query.
 *
 * IDs are deterministic hashes of `tier + fileName` so drafts can continue
 * using the existing numeric `openalbion_item_id` field without requiring a
 * backend schema change. Side effect free and safe to call on each keystroke.
 *
 * @example
 * ```ts
 * const helmets = searchAlbionEquipmentCatalog('', 'head', 'T8');
 * ```
 */
export function searchAlbionEquipmentCatalog(
  query: string,
  slot: BuildSlot,
  tier: string,
): OpenAlbionItem[] {
  const normalizedQuery = normalizeSearchText(query);
  const matchingFileNames = ALBION_EQUIPMENT_FILE_NAMES.filter((fileName) =>
    belongsToSlot(fileName, slot),
  ).filter(
    (fileName) =>
      normalizedQuery.length === 0 || normalizeSearchText(fileName).includes(normalizedQuery),
  );

  return Array.from(new Set(matchingFileNames))
    .map((fileName) => toOpenAlbionItem(fileName, tier))
    .slice(0, 100);
}

/**
 * Builds a render URL matching Albion's public item image CDN.
 *
 * The CDN expects tier-prefixed identifiers for equipment, e.g.
 * `T8_MAIN_SWORD`. Consumables use the same convention in the renderer, so
 * keeping one path avoids slot-specific icon branches.
 */
export function albionEquipmentIconUrl(identifier: string): string {
  return `https://render.albiononline.com/v1/item/${encodeURIComponent(identifier)}.png?quality=1&size=96`;
}

function toOpenAlbionItem(fileName: string, tier: string): OpenAlbionItem {
  const identifier = `${tier}_${fileName}`;
  return {
    id: deterministicItemId(identifier),
    name: fileName,
    tier,
    type: itemTypeForFileName(fileName),
    category_id: null,
    subcategory_id: null,
    identifier,
    icon: albionEquipmentIconUrl(identifier),
  };
}

function deterministicItemId(identifier: string): number {
  let hash = 0;
  for (let index = 0; index < identifier.length; index += 1) {
    hash = (hash * 31 + identifier.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function normalizeSearchText(value: string): string {
  return value.trim().replace(/_/g, ' ').toLowerCase();
}

function belongsToSlot(fileName: string, slot: BuildSlot): boolean {
  switch (slot) {
    case 'weapon':
      return fileName.startsWith('MAIN_') || fileName.startsWith('2H_');
    case 'off_hand':
      return fileName.startsWith('OFF_');
    case 'head':
      return fileName.startsWith('HEAD_');
    case 'armor':
      return fileName.startsWith('ARMOR_');
    case 'shoes':
      return fileName.startsWith('SHOES_');
    case 'cape':
      return fileName === 'CAPE' || fileName.startsWith('CAPEITEM_');
    case 'bag':
      return fileName === 'BAG' || fileName.startsWith('BAG_') || fileName.startsWith('BACKPACK_');
    case 'potion':
      return fileName.startsWith('POTION_');
    case 'food':
      return fileName.startsWith('MEAL_');
    case 'mount':
      return false;
  }
}

function itemTypeForFileName(fileName: string): string {
  if (fileName.startsWith('OFF_')) {
    return 'offhand';
  }
  if (fileName.startsWith('MAIN_') || fileName.startsWith('2H_')) {
    return 'weapon';
  }
  if (fileName.startsWith('MEAL_') || fileName.startsWith('POTION_')) {
    return 'consumable';
  }
  if (fileName === 'CAPE' || fileName.startsWith('CAPEITEM_')) {
    return 'cape';
  }
  if (fileName === 'BAG' || fileName.startsWith('BAG_') || fileName.startsWith('BACKPACK_')) {
    return 'bag';
  }
  return 'armor';
}
