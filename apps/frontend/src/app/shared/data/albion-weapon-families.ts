import { albionBaseIdentifier } from './albion-equipment-catalog';

/** Weapon family used to group weapons in "My weapons" and the weapon picker. */
export type WeaponFamilyId =
  | 'swords'
  | 'axes'
  | 'maces'
  | 'hammers'
  | 'crossbows'
  | 'bows'
  | 'spears'
  | 'nature_staffs'
  | 'daggers'
  | 'quarterstaffs'
  | 'war_gloves'
  | 'shapeshifter_staffs'
  | 'fire_staffs'
  | 'holy_staffs'
  | 'arcane_staffs'
  | 'frost_staffs'
  | 'cursed_staffs'
  | 'other';

/** Weapon families in display order. */
const WEAPON_FAMILY_ORDER: readonly WeaponFamilyId[] = [
  'swords',
  'axes',
  'maces',
  'hammers',
  'crossbows',
  'bows',
  'spears',
  'nature_staffs',
  'daggers',
  'quarterstaffs',
  'war_gloves',
  'shapeshifter_staffs',
  'fire_staffs',
  'holy_staffs',
  'arcane_staffs',
  'frost_staffs',
  'cursed_staffs',
  'other',
];

const WEAPON_FAMILY_LABEL: Readonly<Record<WeaponFamilyId, string>> = {
  swords: 'weapons.family.swords',
  axes: 'weapons.family.axes',
  maces: 'weapons.family.maces',
  hammers: 'weapons.family.hammers',
  crossbows: 'weapons.family.crossbows',
  bows: 'weapons.family.bows',
  spears: 'weapons.family.spears',
  nature_staffs: 'weapons.family.natureStaffs',
  daggers: 'weapons.family.daggers',
  quarterstaffs: 'weapons.family.quarterstaffs',
  war_gloves: 'weapons.family.warGloves',
  shapeshifter_staffs: 'weapons.family.shapeshifterStaffs',
  fire_staffs: 'weapons.family.fireStaffs',
  holy_staffs: 'weapons.family.holyStaffs',
  arcane_staffs: 'weapons.family.arcaneStaffs',
  frost_staffs: 'weapons.family.frostStaffs',
  cursed_staffs: 'weapons.family.cursedStaffs',
  other: 'weapons.family.other',
};

export function weaponFamilyOrder(): readonly WeaponFamilyId[] {
  return WEAPON_FAMILY_ORDER;
}

/** i18n key of a weapon family's label. */
export function weaponFamilyLabelKey(family: WeaponFamilyId): string {
  return WEAPON_FAMILY_LABEL[family];
}

/**
 * Classifies a weapon identifier into its family.
 *
 * Matching is first-hit on the tier-stripped base (`2H_BOW_HELL` → `BOW_HELL`).
 * Crossbows are checked before bows because `CROSSBOW` contains `BOW`.
 * `TWINSCYTHE` is a quarterstaff; the remaining `SCYTHE` weapons are axes.
 */
export function classifyWeaponFamily(identifier: string): WeaponFamilyId {
  const id = stripHandPrefix(albionBaseIdentifier(identifier));

  if (id.includes('CROSSBOW') || id.includes('1HCROSSBOW')) return 'crossbows';
  if (id.includes('WARBOW') || id.includes('LONGBOW') || /(^|_)BOW(_|$)/.test(id)) return 'bows';

  if (id.includes('TWINSCYTHE')) return 'quarterstaffs';
  if (id.includes('SCYTHE')) return 'axes';

  if (id.includes('KNUCKLES')) return 'war_gloves';
  if (id.includes('SHAPESHIFTER')) return 'shapeshifter_staffs';

  if (id.includes('CURSEDSTAFF') || id.includes('DEMONICSTAFF') || id.includes('SKULLORB')) {
    return 'cursed_staffs';
  }
  if (id.includes('FIRESTAFF') || id.includes('INFERNOSTAFF') || id.includes('FIRE_RINGPAIR')) {
    return 'fire_staffs';
  }
  if (
    id.includes('FROSTSTAFF') ||
    id.includes('GLACIALSTAFF') ||
    id.includes('ICEGAUNTLETS') ||
    id.includes('ICECRYSTAL')
  ) {
    return 'frost_staffs';
  }
  if (id.includes('ARCANESTAFF') || id.includes('ENIGMATIC') || id.includes('ARCANE_RINGPAIR')) {
    return 'arcane_staffs';
  }
  if (id.includes('HOLYSTAFF') || id.includes('DIVINESTAFF')) return 'holy_staffs';
  if (id.includes('NATURESTAFF') || id.includes('WILDSTAFF')) return 'nature_staffs';

  if (
    id.includes('QUARTERSTAFF') ||
    id.includes('IRONCLADEDSTAFF') ||
    id.includes('DOUBLEBLADEDSTAFF') ||
    id.includes('COMBATSTAFF') ||
    id.includes('ROCKSTAFF')
  ) {
    return 'quarterstaffs';
  }

  if (
    id.includes('DAGGER') ||
    id.includes('CLAWPAIR') ||
    id.includes('RAPIER') ||
    id.includes('DUALSICKLE') ||
    id.includes('KATAR')
  ) {
    return 'daggers';
  }

  if (
    id.includes('SPEAR') ||
    id.includes('GLAIVE') ||
    id.includes('HARPOON') ||
    id.includes('TRIDENT') ||
    id.includes('LANCE')
  ) {
    return 'spears';
  }

  if (id.includes('HAMMER') || id.includes('POLEHAMMER') || /^RAM(_|$)/.test(id)) return 'hammers';
  if (id.includes('MACE') || id.includes('FLAIL')) return 'maces';
  if (id.includes('AXE') || id.includes('HALBERD')) return 'axes';
  if (id.includes('SWORD') || id.includes('CLAYMORE') || id.includes('SCIMITAR') || id.includes('CLEAVER')) {
    return 'swords';
  }

  return 'other';
}

function stripHandPrefix(identifier: string): string {
  return identifier.replace(/^(?:MAIN|2H|OFF)_/, '');
}
