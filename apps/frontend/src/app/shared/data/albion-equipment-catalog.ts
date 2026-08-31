import type { BuildSlot, OpenAlbionItem } from '../../core/models/api.models';

/**
 * Legacy Albion equipment catalogue and identifier utilities.
 *
 * Build pickers now receive their catalog from `GET /api/openalbion/catalog`; this data remains
 * available as a compatibility fallback and as the canonical identifier/rendering utility. Entries
 * are stored as item base identifiers; the picker expands them with the selected tier at runtime
 * to produce Albion render identifiers such as `T8_2H_BOW`.
 *
 * @example
 * ```ts
 * const weapons = searchAlbionEquipmentCatalog('bow', 'weapon', 'T8');
 * console.log(weapons[0]?.identifier); // "T8_2H_BOW"
 * ```
 */
/** Friendly names for the weapon families used in build authoring. The renderer identifier remains
 * the canonical persisted value, while this map keeps the picker readable for players. */
const ALBION_ITEM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  MAIN_SWORD: 'Broadsword',
  '2H_CLAYMORE': 'Claymore',
  '2H_DUALSWORD': 'Dual Swords',
  MAIN_SCIMITAR_MORGANA: 'Clarent Blade',
  '2H_CLEAVER_HELL': 'Carving Sword',
  '2H_DUALSCIMITAR_UNDEAD': 'Galatine Pair',
  '2H_CLAYMORE_AVALON': 'Kingmaker',
  '2H_DUALSWORD_CRYSTAL': 'Infinity Blade',
  MAIN_AXE: 'Battleaxe',
  '2H_AXE': 'Greataxe',
  '2H_HALBERD': 'Halberd',
  '2H_HALBERD_MORGANA': 'Carrioncaller',
  '2H_SCYTHE_HELL': 'Infernal Scythe',
  '2H_DUALAXE_KEEPER': 'Bear Paws',
  '2H_AXE_AVALON': 'Realmbreaker',
  '2H_SCYTHE_CRYSTAL': 'Crystal Reaper',
  MAIN_MACE: 'Mace',
  '2H_MACE': 'Heavy Mace',
  '2H_FLAIL': 'Morning Star',
  MAIN_ROCKMACE_KEEPER: 'Bedrock Mace',
  MAIN_MACE_HELL: 'Incubus Mace',
  '2H_MACE_MORGANA': 'Camlann Mace',
  '2H_DUALMACE_AVALON': 'Oathkeepers',
  MAIN_MACE_CRYSTAL: 'Dreadstorm Monarch',
  MAIN_HAMMER: 'Hammer',
  '2H_POLEHAMMER': 'Polehammer',
  '2H_HAMMER': 'Great Hammer',
  '2H_HAMMER_UNDEAD': 'Tombhammer',
  '2H_DUALHAMMER_HELL': 'Forge Hammers',
  '2H_RAM_KEEPER': 'Grovekeeper',
  '2H_HAMMER_AVALON': 'Hand of Justice',
  '2H_HAMMER_CRYSTAL': 'Truebolt Hammer',
  '2H_BOW': 'Bow',
  '2H_WARBOW': 'Warbow',
  '2H_LONGBOW': 'Longbow',
  '2H_LONGBOW_UNDEAD': 'Whispering Bow',
  '2H_BOW_HELL': 'Wailing Bow',
  '2H_BOW_KEEPER': 'Bow of Badon',
  '2H_BOW_AVALON': 'Mistpiercer',
  '2H_BOW_CRYSTAL': 'Skystrider Bow',
  '2H_CROSSBOW': 'Crossbow',
  MAIN_1HCROSSBOW: 'Light Crossbow',
  '2H_CROSSBOWLARGE': 'Heavy Crossbow',
  '2H_REPEATINGCROSSBOW_UNDEAD': 'Weeping Repeater',
  '2H_DUALCROSSBOW_HELL': 'Boltcasters',
  '2H_CROSSBOWLARGE_MORGANA': 'Siegebow',
  '2H_CROSSBOW_CANNON_AVALON': 'Energy Shaper',
  '2H_DUALCROSSBOW_CRYSTAL': 'Arclight Blasters',
  MAIN_SPEAR: 'Spear',
  '2H_SPEAR': 'Pike',
  '2H_GLAIVE': 'Glaive',

  MAIN_NATURESTAFF: 'Nature Staff',
  '2H_NATURESTAFF': 'Great Nature Staff',
  '2H_WILDSTAFF': 'Wild Staff',
  MAIN_NATURESTAFF_KEEPER: 'Druidic Staff',
  '2H_NATURESTAFF_HELL': 'Blight Staff',
  '2H_NATURESTAFF_KEEPER': 'Rampant Staff',
  MAIN_NATURESTAFF_AVALON: 'Ironroot Staff',
  MAIN_NATURESTAFF_CRYSTAL: 'Dawnsong',
  MAIN_SPEAR_KEEPER: 'Heron Spear',
  '2H_HARPOON_HELL': 'Spirithunter',
  '2H_TRIDENT_UNDEAD': 'Trinity Spear',
  MAIN_SPEAR_LANCE_AVALON: 'Daybreaker',
  '2H_GLAIVE_CRYSTAL': 'Rift Glaive',
  MAIN_DAGGER: 'Dagger',
  OFF_TORCH: 'Torch',
  OFF_HORN_KEEPER: 'Mistcaller',
  OFF_LAMP_UNDEAD: 'Leering Cane',
  OFF_TORCH_CRYSTAL: 'Sacred Scepter',
  OFF_BOOK: 'Tome of Spells',
  OFF_ORB_MORGANA: 'Eye of Secrets',
  OFF_DEMONSKULL_HELL: 'Muisak',
  OFF_TOTEM_KEEPER: 'Taproot',
  OFF_CENSER_AVALON: 'Celestial Censer',
  OFF_TOWERSHIELD_UNDEAD: 'Sarcophagus',
  OFF_SHIELD_HELL: 'Caitiff Shield',
  OFF_SPIKEDSHIELD_MORGANA: 'Facebreaker',
  OFF_SHIELD_AVALON: 'Astral Aegis',
  OFF_SHIELD_CRYSTAL: 'Unbreakable Ward',
  MOUNT_MULE: 'Mule',
  MOUNT_HORSE: 'Riding Horse',
  MOUNT_ARMORED_HORSE: 'Armored Horse',
  MOUNT_OX: 'Transport Ox',
  MOUNT_DIREWOLF: 'Direwolf',
  MOUNT_SWIFTCLAW: 'Swiftclaw',
  MOUNT_COUGAR_KEEPER: 'Rageclaw',
  MOUNT_PANTHER: 'Black Panther',
  MOUNT_BOAR: 'Saddled Wild Boar',
  MOUNT_DIREBOAR: 'Saddled Direboar',
  MOUNT_DIREBOAR_UNDEAD: 'Spectral Direboar',
  MOUNT_DIREBEAR: 'Saddled Direbear',
  MOUNT_BEAR: 'Saddled Winter Bear',
  MOUNT_GIANTBEAR: 'Grizzly Bear',
  MOUNT_GIANTSTAG: 'Giant Stag',
  MOUNT_MOOSE: 'Moose',
  MOUNT_RAM: 'Bighorn Ram',
  MOUNT_RAM_XMAS: 'Frost Ram',
  MOUNT_TERRORBIRD: 'Saddled Terrorbird',
  MOUNT_RAVEN: 'Morgana Raven',
  MOUNT_OWL: 'Divine Owl',
  MOUNT_MYSTICOWL: 'Saddled Mystic Owl',
  MOUNT_SWAMPDRAGON: 'Saddled Swamp Dragon',
  MOUNT_PESTLIZARD: 'Pest Lizard',
  MOUNT_BASILISK_AVALON: 'Avalonian Basilisk',
  MOUNT_BASILISK_FIRE: 'Flame Basilisk',
  MOUNT_BASILISK_POISON: 'Venom Basilisk',
  MOUNT_FIREWING_DRAKE: 'Firewing Drake',
  MOUNT_NIGHTMARE: 'Morgana Nightmare',
  MOUNT_SPECTRALHORSE: 'Spectral Bonehorse',
  MOUNT_SPECTRALBAT: 'Spectral Bat',
  MOUNT_HUSKY: 'Snow Husky',
  MOUNT_RABBIT: 'Spring Cottontail',
  MOUNT_HELLSPIDER: 'Hellspinner',
  MOUNT_SOULSPIDER: 'Soulspinner',
  MOUNT_MAMMOTH_TRANSPORT: 'Transport Mammoth',
  MOUNT_MAMMOTH_COMMAND: 'Command Mammoth',
  '2H_DAGGERPAIR': 'Dagger Pair',
  '2H_CLAWPAIR': 'Claws',
  MAIN_RAPIER_MORGANA: 'Bloodletter',
  MAIN_DAGGER_HELL: 'Demonfang',
  '2H_DUALSICKLE_UNDEAD': 'Deathgivers',
  '2H_DAGGER_KATAR_AVALON': 'Bridled Fury',
  '2H_DAGGERPAIR_CRYSTAL': 'Twin Slayers',
};

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
  'MOUNT_MULE',
  'MOUNT_HORSE',
  'MOUNT_ARMORED_HORSE',
  'MOUNT_OX',
  'MOUNT_DIREWOLF',
  'MOUNT_SWIFTCLAW',
  'MOUNT_COUGAR_KEEPER',
  'MOUNT_PANTHER',
  'MOUNT_BOAR',
  'MOUNT_DIREBOAR',
  'MOUNT_DIREBOAR_UNDEAD',
  'MOUNT_DIREBEAR',
  'MOUNT_BEAR',
  'MOUNT_GIANTBEAR',
  'MOUNT_GIANTSTAG',
  'MOUNT_MOOSE',
  'MOUNT_RAM',
  'MOUNT_RAM_XMAS',
  'MOUNT_TERRORBIRD',
  'MOUNT_RAVEN',
  'MOUNT_OWL',
  'MOUNT_MYSTICOWL',
  'MOUNT_SWAMPDRAGON',
  'MOUNT_PESTLIZARD',
  'MOUNT_BASILISK_AVALON',
  'MOUNT_BASILISK_FIRE',
  'MOUNT_BASILISK_POISON',
  'MOUNT_FIREWING_DRAKE',
  'MOUNT_NIGHTMARE',
  'MOUNT_SPECTRALHORSE',
  'MOUNT_SPECTRALBAT',
  'MOUNT_HUSKY',
  'MOUNT_RABBIT',
  'MOUNT_HELLSPIDER',
  'MOUNT_SOULSPIDER',
  'MOUNT_MAMMOTH_TRANSPORT',
  'MOUNT_MAMMOTH_COMMAND',
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
  return filterAlbionEquipmentCatalog(
    ALBION_EQUIPMENT_FILE_NAMES.map((fileName) => toOpenAlbionItem(fileName, tier)),
    query,
    slot,
    tier,
  );
}

/** Filters the catalog returned by the backend for one build slot. */
export function filterAlbionEquipmentCatalog(
  catalog: readonly OpenAlbionItem[],
  query: string,
  slot: BuildSlot,
  tier: string,
): OpenAlbionItem[] {
  const normalizedQuery = normalizeSearchText(query);
  return catalog
    .filter(
      (item) =>
        (item.identifier ?? '').toUpperCase().startsWith(`${tier.toUpperCase()}_`) &&
        belongsToSlot(item.identifier ?? '', slot),
    )
    .filter(
      (item) =>
        normalizedQuery.length === 0 || normalizeSearchText(item.name).includes(normalizedQuery),
    )
    .slice(0, 100);
}

/** Removes the tier prefix so all eight tiers share one specialization node. */
export function albionSpecializationIdentifier(identifier: string): string {
   return identifier.trim().toUpperCase().replace(/^T\d+_/, '');
 }

/** Returns the stable key shared by profile and event specialization views. */
export function albionSpecializationKey(item: Pick<OpenAlbionItem, 'type' | 'identifier' | 'id'>): string {
   const category = item.type === 'armor' ? 'armor' : 'weapon';
   const identifier = albionSpecializationIdentifier(item.identifier ?? String(item.id));
   return `${category}:${identifier}`;
 }

/** Canonicalizes keys saved by older versions that included the tier. */
export function normalizeAlbionSpecializationKey(nodeKey: string): string {
   const separator = nodeKey.indexOf(':');
   if (separator < 0) return nodeKey.trim();
   const category = nodeKey.slice(0, separator).trim().toLowerCase();
   const identifier = albionSpecializationIdentifier(nodeKey.slice(separator + 1));
   return `${category}:${identifier}`;
 }

/** Converts catalog identifiers such as `MAIN_NATURESTAFF` to player-facing names. */
export function normalizeAlbionEquipmentName(identifier: string, fallback = identifier): string {
   const baseIdentifier = albionSpecializationIdentifier(identifier);
   const mapped = ALBION_ITEM_DISPLAY_NAMES[baseIdentifier];
   if (mapped) return mapped;

   const withoutHand = baseIdentifier.replace(/^(?:MAIN|2H)_/, '');
   const spaced = withoutHand
     .replace(/(DAGGERPAIR|CLAWPAIR|RINGPAIR)/g, ' $1')
     .replace(/([A-Z]+?)(CROSSBOW|QUARTERSTAFF|NATURESTAFF|FIRESTAFF|FROSTSTAFF|HOLYSTAFF|CURSEDSTAFF|ARCANESTAFF|DEMONICSTAFF|WILDSTAFF|DIVINESTAFF|GLACIALSTAFF|ENIGMATICSTAFF|STAFF|SWORD|AXE|MACE|HAMMER|BOW|SPEAR|DAGGER|SCYTHE|GAUNTLETS|SHIELD|TORCH|BOOK|ORB|TOME)/g, '$1 $2')
     .replace(/_/g, ' ')
     .trim();
   if (!spaced) return fallback.trim();
   return spaced.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
 }

/** Returns one specialization item per base weapon/armor identifier. */
export function deduplicateAlbionCombatCatalog(catalog: readonly OpenAlbionItem[]): OpenAlbionItem[] {
   const seen = new Set<string>();
   return catalog.flatMap((item) => {
     if (item.type !== 'weapon' && item.type !== 'armor') return [];
     const identifier = item.identifier?.trim();
     if (!identifier) return [];
     const key = albionSpecializationKey(item);
     if (seen.has(key)) return [];
     seen.add(key);
     return [{
       ...item,
       identifier: albionSpecializationIdentifier(identifier),
       name: normalizeAlbionEquipmentName(identifier, item.name),
     }];
   });
 }

/** Builds a render URL matching Albion's public item image CDN.
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
    name: ALBION_ITEM_DISPLAY_NAMES[fileName] ?? fileName.replace(/_/g, ' '),
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
      return fileName.startsWith('MOUNT_');
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
  if (fileName.startsWith('MOUNT_')) {
    return 'mount';
  }
  if (fileName === 'CAPE' || fileName.startsWith('CAPEITEM_')) {
    return 'cape';
  }
  if (fileName === 'BAG' || fileName.startsWith('BAG_') || fileName.startsWith('BACKPACK_')) {
    return 'bag';
  }
  return 'armor';
}
