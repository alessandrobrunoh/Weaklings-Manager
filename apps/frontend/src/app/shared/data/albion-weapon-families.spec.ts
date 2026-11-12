import { describe, expect, it } from 'vitest';

import { classifyWeaponFamily, weaponFamilyOrder } from './albion-weapon-families';

describe('classifyWeaponFamily', () => {
  it('groups bow variants together and keeps crossbows separate', () => {
    expect(classifyWeaponFamily('2H_BOW')).toBe('bows');
    expect(classifyWeaponFamily('2H_WARBOW')).toBe('bows');
    expect(classifyWeaponFamily('2H_LONGBOW')).toBe('bows');
    expect(classifyWeaponFamily('2H_BOW_HELL')).toBe('bows');
    expect(classifyWeaponFamily('T8_2H_LONGBOW_UNDEAD')).toBe('bows');
    expect(classifyWeaponFamily('2H_CROSSBOW')).toBe('crossbows');
    expect(classifyWeaponFamily('MAIN_1HCROSSBOW')).toBe('crossbows');
  });

  it('groups swords, hammers, and axes, including Grovekeeper and Infernal Scythe', () => {
    expect(classifyWeaponFamily('MAIN_SWORD')).toBe('swords');
    expect(classifyWeaponFamily('2H_CLAYMORE')).toBe('swords');
    expect(classifyWeaponFamily('MAIN_HAMMER')).toBe('hammers');
    expect(classifyWeaponFamily('2H_RAM_KEEPER')).toBe('hammers');
    expect(classifyWeaponFamily('2H_SCYTHE_HELL')).toBe('axes');
    expect(classifyWeaponFamily('2H_TWINSCYTHE_HELL')).toBe('quarterstaffs');
  });

  it('falls back to other for an unknown weapon', () => {
    expect(classifyWeaponFamily('MAIN_UNKNOWN_WIDGET')).toBe('other');
  });
});

describe('weaponFamilyOrder', () => {
  it('ends with the catch-all family', () => {
    expect(weaponFamilyOrder().at(-1)).toBe('other');
  });
});
