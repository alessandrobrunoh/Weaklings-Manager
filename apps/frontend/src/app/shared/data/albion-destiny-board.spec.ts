import { describe, expect, it } from 'vitest';

import type { OpenAlbionItem, UserSpecialization } from '../../core/models/api.models';
import {
  buildDestinyBoardTree,
  classifyArmor,
  classifyWeaponFamily,
  collectLeaves,
  destinyHueForId,
  filterDestinyTree,
  isDestinyGroup,
  layoutDestinyRadial,
  matchingGroupIds,
  masteryFillPercent,
  masterySummary,
  mergeSpecializationNodes,
  setLevelsForKeys,
  type DestinyItemNode,
} from './albion-destiny-board';

function item(
  identifier: string,
  name: string,
  category: 'weapon' | 'armor',
  level = 0,
): DestinyItemNode {
  return {
    node_key: `${category}:${identifier}`,
    node_name: name,
    category,
    level,
    icon: null,
    identifier,
  };
}

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

describe('classifyArmor', () => {
  it('splits plate boots from leather helmets', () => {
    expect(classifyArmor('SHOES_PLATE_KEEPER')).toEqual({ material: 'plate', slot: 'boots' });
    expect(classifyArmor('SHOES_PLATE_SET1')).toEqual({ material: 'plate', slot: 'boots' });
    expect(classifyArmor('HEAD_LEATHER_SET2')).toEqual({ material: 'leather', slot: 'head' });
    expect(classifyArmor('ARMOR_CLOTH_SET1')).toEqual({ material: 'cloth', slot: 'chest' });
  });

  it('keeps gathering armor on its own material branch', () => {
    expect(classifyArmor('HEAD_GATHERER_ORE')).toEqual({ material: 'gathering', slot: 'head' });
  });
});

describe('buildDestinyBoardTree', () => {
  it('nests bows under weapons and plate boots under armor', () => {
    const tree = buildDestinyBoardTree([
      item('2H_BOW_HELL', 'Wailing Bow', 'weapon', 45),
      item('2H_BOW', 'Bow', 'weapon', 120),
      item('2H_WARBOW', 'Warbow', 'weapon', 80),
      item('2H_LONGBOW', 'Longbow', 'weapon', 12),
      item('SHOES_PLATE_KEEPER', 'Judicator Boots', 'armor', 30),
      item('SHOES_PLATE_SET1', 'Soldier Boots', 'armor', 10),
      item('HEAD_PLATE_SET1', 'Soldier Helmet', 'armor', 0),
    ]);

    expect(tree.map((branch) => branch.id)).toEqual(['weapon', 'armor']);

    const weapons = tree[0];
    expect(weapons.labelKey).toBe('destiny.branch.weapons');
    const bows = weapons.children.find(
      (child) => isDestinyGroup(child) && child.id === 'weapon:bows',
    );
    expect(bows && isDestinyGroup(bows)).toBe(true);
    if (!bows || !isDestinyGroup(bows)) return;
    expect(bows.children.map((leaf) => ('node_name' in leaf ? leaf.node_name : ''))).toEqual([
      'Bow',
      'Longbow',
      'Wailing Bow',
      'Warbow',
    ]);

    const armor = tree[1];
    const plate = armor.children.find(
      (child) => isDestinyGroup(child) && child.id === 'armor:plate',
    );
    expect(plate && isDestinyGroup(plate)).toBe(true);
    if (!plate || !isDestinyGroup(plate)) return;
    const boots = plate.children.find(
      (child) => isDestinyGroup(child) && child.id === 'armor:plate:boots',
    );
    expect(boots && isDestinyGroup(boots)).toBe(true);
    if (!boots || !isDestinyGroup(boots)) return;
    expect(boots.children.map((leaf) => ('node_name' in leaf ? leaf.node_name : ''))).toEqual([
      'Judicator Boots',
      'Soldier Boots',
    ]);
  });
});

describe('filterDestinyTree', () => {
  const tree = buildDestinyBoardTree([
    item('2H_BOW_HELL', 'Wailing Bow', 'weapon', 45),
    item('2H_BOW', 'Bow', 'weapon'),
    item('MAIN_SWORD', 'Broadsword', 'weapon'),
    item('SHOES_PLATE_KEEPER', 'Judicator Boots', 'armor'),
  ]);

  it('keeps the Armi → Archi → Wailing Bow path for a name search', () => {
    const filtered = filterDestinyTree(tree, 'wailing');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('weapon');
    expect(filtered[0].children).toHaveLength(1);
    const bows = filtered[0].children[0];
    expect(isDestinyGroup(bows) && bows.id).toBe('weapon:bows');
    if (!isDestinyGroup(bows)) return;
    expect(bows.children).toHaveLength(1);
    expect('node_name' in bows.children[0] && bows.children[0].node_name).toBe('Wailing Bow');
    expect([...matchingGroupIds(tree, 'wailing')].sort()).toEqual(['weapon', 'weapon:bows']);
  });

  it('hides armor when the category filter is weapons', () => {
    const filtered = filterDestinyTree(tree, '', 'weapon');
    expect(filtered.map((branch) => branch.id)).toEqual(['weapon']);
  });
});

describe('masterySummary', () => {
  it('counts trained leaves and fill against the 120 cap', () => {
    const tree = buildDestinyBoardTree([
      item('2H_BOW', 'Bow', 'weapon', 120),
      item('2H_WARBOW', 'Warbow', 'weapon', 0),
    ]);
    const summary = masterySummary(tree[0]);
    expect(summary).toEqual({ trained: 1, total: 2, sum: 120 });
    expect(masteryFillPercent(summary)).toBe(50);
  });
});

describe('layoutDestinyRadial', () => {
  it('places weapons on the left and armor on the right of the hub', () => {
    const tree = buildDestinyBoardTree([
      item('2H_BOW_HELL', 'Wailing Bow', 'weapon', 45),
      item('2H_BOW', 'Bow', 'weapon', 120),
      item('SHOES_PLATE_KEEPER', 'Judicator Boots', 'armor', 30),
    ]);
    const layout = layoutDestinyRadial(tree);
    const weapons = layout.nodes.find((node) => node.id === 'weapon');
    const armor = layout.nodes.find((node) => node.id === 'armor');
    const wailing = layout.nodes.find((node) => node.id === 'weapon:2H_BOW_HELL');
    expect(weapons && weapons.x < layout.cx).toBe(true);
    expect(armor && armor.x > layout.cx).toBe(true);
    expect(wailing && wailing.x < layout.cx).toBe(true);
    expect(layout.edges.some((edge) => edge.id.includes('weapon:bows->weapon:2H_BOW_HELL'))).toBe(
      true,
    );
    const bows = layout.nodes.find((node) => node.id === 'weapon:bows');
    expect(bows && wailing).toBeTruthy();
    if (!bows || !wailing) return;
    const familyR = Math.hypot(bows.x - layout.cx, bows.y - layout.cy);
    const leafR = Math.hypot(wailing.x - layout.cx, wailing.y - layout.cy);
    expect(leafR).toBeGreaterThan(familyR * 1.5);
  });

  it('copies a T8 leaf icon onto its family hub', () => {
    const bow = item('2H_BOW', 'Bow', 'weapon', 0);
    const layout = layoutDestinyRadial(buildDestinyBoardTree([bow]));
    expect(layout.nodes.find((node) => node.id === 'weapon:2H_BOW')?.icon).toContain('T8_2H_BOW');
    expect(layout.nodes.find((node) => node.id === 'weapon:bows')?.icon).toContain('T8_2H_BOW');
  });
});

describe('setLevelsForKeys', () => {
  it('sets every leaf in a family and can zero them out', () => {
    const items = [
      item('2H_BOW', 'Bow', 'weapon', 10),
      item('2H_WARBOW', 'Warbow', 'weapon', 20),
      item('MAIN_SWORD', 'Broadsword', 'weapon', 30),
    ];
    const tree = buildDestinyBoardTree(items);
    const bows = tree[0].children.find((child) => isDestinyGroup(child) && child.id === 'weapon:bows');
    expect(bows).toBeTruthy();
    if (!bows) return;
    const keys = new Set(collectLeaves(bows).map((leaf) => leaf.node_key));
    const raised = setLevelsForKeys(items, keys, 100);
    expect(raised.find((row) => row.identifier === '2H_BOW')?.level).toBe(100);
    expect(raised.find((row) => row.identifier === '2H_WARBOW')?.level).toBe(100);
    expect(raised.find((row) => row.identifier === 'MAIN_SWORD')?.level).toBe(30);
    const reset = setLevelsForKeys(raised, keys, 0);
    expect(reset.find((row) => row.identifier === '2H_BOW')?.level).toBe(0);
  });
});

describe('destinyHueForId', () => {
  it('colours bows as hunter and plate as warrior', () => {
    expect(destinyHueForId('weapon:bows')).toBe('hunter');
    expect(destinyHueForId('weapon:2H_BOW_HELL', '2H_BOW_HELL')).toBe('hunter');
    expect(destinyHueForId('armor:plate:boots')).toBe('warrior');
    expect(destinyHueForId('armor:cloth')).toBe('mage');
  });
});

describe('mergeSpecializationNodes', () => {
  it('applies saved levels onto catalog items and keeps a draft override', () => {
    const catalog: OpenAlbionItem[] = [
      {
        id: 1,
        name: 'Bow',
        tier: 'T8',
        type: 'weapon',
        category_id: null,
        subcategory_id: null,
        identifier: 'T8_2H_BOW',
        icon: 'bow.png',
      },
      {
        id: 2,
        name: 'Wailing Bow',
        tier: 'T4',
        type: 'weapon',
        category_id: null,
        subcategory_id: null,
        identifier: 'T4_2H_BOW_HELL',
        icon: 'wailing.png',
      },
    ];
    const saved: UserSpecialization[] = [
      {
        node_key: 'weapon:T8_2H_BOW',
        node_name: 'Bow',
        category: 'weapon',
        level: 40,
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    const previous = [item('2H_BOW', 'Bow', 'weapon', 80)];

    const nodes = mergeSpecializationNodes(saved, catalog, previous);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((node) => node.identifier === '2H_BOW')).toMatchObject({
      node_key: 'weapon:2H_BOW',
      level: 80,
    });
    expect(nodes.find((node) => node.identifier === '2H_BOW_HELL')).toMatchObject({
      level: 0,
      node_name: 'Wailing Bow',
    });
  });
});
