import { describe, expect, it } from 'vitest';

import type { OpenAlbionItem, ParticipantWeapon } from '../../core/models/api.models';
import {
  draftsFromWeapons,
  groupWeaponDrafts,
  groupBuildsByWeapon,
  manageUserWeaponsRequest,
  seatWeaponWarning,
  sortBenchForWeapon,
  summarizeWeaponDrafts,
  updateMyWeaponsRequest,
  weaponDraftsChanged,
  weaponFamilyOfKey,
  weaponFit,
  weaponKeyForIdentifier,
  weaponOptionsFromCatalog,
  type WeaponDraft,
} from './user-weapons';

const POLE = 'weapon:2H_POLEHAMMER';
const HOLY = 'weapon:MAIN_HOLYSTAFF';

function weapon(
  weapon_key: string,
  proficiency: ParticipantWeapon['proficiency'],
  locked = false,
): ParticipantWeapon {
  return { weapon_key, proficiency, locked };
}

describe('weaponKeyForIdentifier', () => {
  it('strips tier and enchantment', () => {
    expect(weaponKeyForIdentifier('T8_2H_POLEHAMMER@2')).toBe(POLE);
    expect(weaponKeyForIdentifier('main_holystaff')).toBe(HOLY);
  });
});

describe('weapon requests', () => {
  const drafts: WeaponDraft[] = [
    { weapon_key: POLE, weapon_name: 'Polehammer', proficiency: 'main', locked: false },
    { weapon_key: HOLY, weapon_name: 'Holy Staff', proficiency: 'good', locked: true },
    { weapon_key: 'weapon:2H_BOW', weapon_name: 'Bow', proficiency: null, locked: true },
    { weapon_key: 'weapon:2H_AXE', weapon_name: 'Greataxe', proficiency: null, locked: false },
  ];

  it('sends only declared, unlocked weapons for the member', () => {
    expect(updateMyWeaponsRequest(drafts)).toEqual({
      weapons: [{ weapon_key: POLE, proficiency: 'main' }],
    });
  });

  it('sends levels and locks for the officer and drops empty rows', () => {
    expect(manageUserWeaponsRequest(drafts).weapons).toEqual([
      { weapon_key: POLE, proficiency: 'main', locked: false },
      { weapon_key: HOLY, proficiency: 'good', locked: true },
      { weapon_key: 'weapon:2H_BOW', proficiency: null, locked: true },
    ]);
  });

  it('detects changes regardless of order', () => {
    expect(weaponDraftsChanged(drafts, [...drafts].reverse())).toBe(false);
    expect(
      weaponDraftsChanged(drafts, [{ ...drafts[0], proficiency: 'good' }, ...drafts.slice(1)]),
    ).toBe(true);
  });

  it('orders loaded rows main, good, basic, then lock-only', () => {
    const rows = draftsFromWeapons([
      { weapon_key: 'weapon:A', weapon_name: 'Zed', proficiency: null, locked: true, updated_at: '' },
      { weapon_key: 'weapon:B', weapon_name: 'Basic', proficiency: 'basic', locked: false, updated_at: '' },
      { weapon_key: 'weapon:C', weapon_name: 'Main', proficiency: 'main', locked: false, updated_at: '' },
    ]);
    expect(rows.map((row) => row.weapon_name)).toEqual(['Main', 'Basic', 'Zed']);
  });
});

describe('weaponOptionsFromCatalog', () => {
  const item = (id: number, identifier: string, name: string, type = 'weapon'): OpenAlbionItem => ({
    id,
    name,
    tier: 'T8',
    type,
    category_id: null,
    subcategory_id: null,
    identifier,
  });

  it('lists each weapon once without tiers, grouped by family', () => {
    const options = weaponOptionsFromCatalog([
      item(1, 'T8_MAIN_HOLYSTAFF', 'Holy Staff'),
      item(2, 'T4_MAIN_HOLYSTAFF', 'Holy Staff'),
      item(3, 'T8_2H_BOW', 'Bow'),
      item(4, 'T8_2H_POLEHAMMER', 'Polehammer'),
      item(5, 'T8_HEAD_PLATE_SET1', 'Soldier Helmet', 'armor'),
    ]);
    expect(options.map((option) => option.key)).toEqual([POLE, 'weapon:2H_BOW', HOLY]);
    expect(options.map((option) => option.family)).toEqual(['hammers', 'bows', 'holy_staffs']);
  });
});

describe('weapon fit on a seat', () => {
  it('has no fit when the seat has no weapon', () => {
    expect(weaponFit([weapon(POLE, 'main')], null)).toBeNull();
    expect(seatWeaponWarning([weapon(POLE, 'main', true)], null)).toBeNull();
  });

  it('reads the declared level', () => {
    expect(weaponFit([weapon(POLE, 'good')], POLE)).toBe('good');
  });

  it('distinguishes no declarations from a weapon that was not declared', () => {
    expect(weaponFit([], POLE)).toBe('no_declarations');
    expect(weaponFit(undefined, POLE)).toBe('no_declarations');
    expect(weaponFit([weapon(HOLY, 'main')], POLE)).toBe('not_declared');
  });

  it('treats a lock-only row as no declaration but a lock as the worst fit', () => {
    expect(weaponFit([weapon(HOLY, null, true)], POLE)).toBe('no_declarations');
    expect(weaponFit([weapon(POLE, null, true)], POLE)).toBe('locked');
    expect(weaponFit([weapon(POLE, 'main', true)], POLE)).toBe('locked');
  });

  it('warns only for a locked weapon (danger) or an undeclared one (warning)', () => {
    expect(seatWeaponWarning([weapon(POLE, 'main', true)], POLE)).toBe('locked');
    expect(seatWeaponWarning([weapon(HOLY, 'main')], POLE)).toBe('not_declared');
    expect(seatWeaponWarning([], POLE)).toBeNull();
    expect(seatWeaponWarning([weapon(POLE, 'basic')], POLE)).toBeNull();
  });
});

describe('sortBenchForWeapon', () => {
  const member = (name: string, weapons: ParticipantWeapon[]) => ({ name, weapons });
  const bench = [
    member('locked', [weapon(POLE, 'main', true)]),
    member('not-declared', [weapon(HOLY, 'main')]),
    member('none', []),
    member('basic', [weapon(POLE, 'basic')]),
    member('main', [weapon(POLE, 'main')]),
    member('good-a', [weapon(POLE, 'good')]),
    member('good-b', [weapon(POLE, 'good')]),
  ];

  it('puts main, good, basic, no declarations, not declared, locked last', () => {
    expect(sortBenchForWeapon(bench, POLE).map((entry) => entry.name)).toEqual([
      'main',
      'good-a',
      'good-b',
      'basic',
      'none',
      'not-declared',
      'locked',
    ]);
  });

  it('keeps the original order when the seat has no weapon', () => {
    expect(sortBenchForWeapon(bench, null).map((entry) => entry.name)).toEqual(
      bench.map((entry) => entry.name),
    );
  });

  it('does not mutate its input', () => {
    const copy = [...bench];
    sortBenchForWeapon(bench, POLE);
    expect(bench).toEqual(copy);
  });
});

describe('groupBuildsByWeapon', () => {
  const build = (id: number, weapon_key: string | null, weapon_name: string | null) => ({
    id,
    weapon_key,
    weapon_name,
  });

  it('groups by weapon, sorted by name, with weaponless builds last', () => {
    const groups = groupBuildsByWeapon([
      build(1, null, null),
      build(2, POLE, 'Polehammer'),
      build(3, HOLY, 'Holy Staff'),
      build(4, POLE, 'Polehammer'),
    ]);
    expect(groups.map((group) => [group.name, group.builds.map((entry) => entry.id)])).toEqual([
      ['Holy Staff', [3]],
      ['Polehammer', [2, 4]],
      [null, [1]],
    ]);
  });

  it('returns nothing for no builds', () => {
    expect(groupBuildsByWeapon([])).toEqual([]);
  });
});

describe('groupWeaponDrafts', () => {
  const draft = (
    weapon_key: string,
    weapon_name: string,
    proficiency: WeaponDraft['proficiency'] = 'good',
    locked = false,
  ): WeaponDraft => ({ weapon_key, weapon_name, proficiency, locked });

  it('classifies a weapon key into its family', () => {
    expect(weaponFamilyOfKey(POLE)).toBe('hammers');
    expect(weaponFamilyOfKey(HOLY)).toBe('holy_staffs');
    expect(weaponFamilyOfKey('weapon:MAIN_UNKNOWN_WIDGET')).toBe('other');
  });

  it('groups by family in display order and sorts by name so a level change never moves a row', () => {
    const groups = groupWeaponDrafts([
      draft(HOLY, 'Holy Staff', 'main'),
      draft('weapon:2H_BOW', 'Bow', 'basic'),
      draft('weapon:2H_LONGBOW', 'Longbow', 'main'),
      draft('weapon:2H_WARBOW', 'Warbow', 'good'),
    ]);
    expect(groups.map((group) => group.family)).toEqual(['bows', 'holy_staffs']);
    expect(groups[0].drafts.map((entry) => entry.weapon_name)).toEqual(['Bow', 'Longbow', 'Warbow']);
  });

  it('counts levels and locks', () => {
    expect(
      summarizeWeaponDrafts([
        draft(POLE, 'Polehammer', 'main'),
        draft(HOLY, 'Holy Staff', 'main', true),
        draft('weapon:2H_BOW', 'Bow', null, true),
        draft('weapon:2H_AXE', 'Greataxe', 'basic'),
      ]),
    ).toEqual({ main: 2, good: 0, basic: 1, locked: 2 });
  });
});
