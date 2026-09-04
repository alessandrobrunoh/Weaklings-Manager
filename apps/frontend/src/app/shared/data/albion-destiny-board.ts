import type {
  AlbionCombatCategory,
  OpenAlbionItem,
  UserSpecialization,
} from '../../core/models/api.models';
import {
  albionCombatIconUrl,
  albionSpecializationIdentifier,
  deduplicateAlbionCombatCatalog,
  normalizeAlbionEquipmentName,
  normalizeAlbionSpecializationKey,
} from './albion-equipment-catalog';

/** One Destiny Board leaf: a weapon or armor specialization the player can set. */
export interface DestinyItemNode {
  node_key: string;
  node_name: string;
  category: AlbionCombatCategory;
  level: number;
  icon: string | null;
  identifier: string;
}

/** Weapon family on the combat Destiny Board. */
export type DestinyWeaponFamilyId =
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

/** Armor material branch. Gathering gear is kept so catalog items are not dropped. */
export type DestinyArmorMaterialId = 'plate' | 'leather' | 'cloth' | 'gathering' | 'other';

/** Armor slot under a material. */
export type DestinyArmorSlotId = 'head' | 'chest' | 'boots';

/** i18n key for a Destiny Board group label. Kept as a string so this module
 * does not depend on the English dictionary's `TranslationKey` union. */
export type DestinyLabelKey = string;

/** A labelled group in the Destiny Board tree. */
export interface DestinyGroupNode {
  kind: 'group';
  id: string;
  branch: AlbionCombatCategory;
  labelKey: DestinyLabelKey;
  children: DestinyTreeNode[];
}

export type DestinyTreeNode = DestinyGroupNode | DestinyItemNode;

/** Mastery roll-up for a group or a filtered tree. */
export interface DestinyMasterySummary {
  trained: number;
  total: number;
  sum: number;
}

const WEAPON_FAMILY_ORDER: readonly DestinyWeaponFamilyId[] = [
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

const ARMOR_MATERIAL_ORDER: readonly DestinyArmorMaterialId[] = [
  'plate',
  'leather',
  'cloth',
  'gathering',
  'other',
];

const ARMOR_SLOT_ORDER: readonly DestinyArmorSlotId[] = ['head', 'chest', 'boots'];

const WEAPON_FAMILY_LABEL: Record<DestinyWeaponFamilyId, DestinyLabelKey> = {
  swords: 'destiny.family.swords',
  axes: 'destiny.family.axes',
  maces: 'destiny.family.maces',
  hammers: 'destiny.family.hammers',
  crossbows: 'destiny.family.crossbows',
  bows: 'destiny.family.bows',
  spears: 'destiny.family.spears',
  nature_staffs: 'destiny.family.natureStaffs',
  daggers: 'destiny.family.daggers',
  quarterstaffs: 'destiny.family.quarterstaffs',
  war_gloves: 'destiny.family.warGloves',
  shapeshifter_staffs: 'destiny.family.shapeshifterStaffs',
  fire_staffs: 'destiny.family.fireStaffs',
  holy_staffs: 'destiny.family.holyStaffs',
  arcane_staffs: 'destiny.family.arcaneStaffs',
  frost_staffs: 'destiny.family.frostStaffs',
  cursed_staffs: 'destiny.family.cursedStaffs',
  other: 'destiny.family.other',
};

const ARMOR_MATERIAL_LABEL: Record<DestinyArmorMaterialId, DestinyLabelKey> = {
  plate: 'destiny.material.plate',
  leather: 'destiny.material.leather',
  cloth: 'destiny.material.cloth',
  gathering: 'destiny.material.gathering',
  other: 'destiny.material.other',
};

const ARMOR_SLOT_LABEL: Record<DestinyArmorSlotId, DestinyLabelKey> = {
  head: 'destiny.slot.head',
  chest: 'destiny.slot.chest',
  boots: 'destiny.slot.boots',
};

/** True when the node is a group rather than a leaf item. */
export function isDestinyGroup(node: DestinyTreeNode): node is DestinyGroupNode {
  return 'kind' in node && node.kind === 'group';
}

/**
 * Classifies a weapon identifier into its Destiny Board family.
 *
 * Matching is first-hit on the tier-stripped base (`2H_BOW_HELL` → `BOW_HELL`).
 * Crossbows are checked before bows because `CROSSBOW` contains `BOW`.
 * `TWINSCYTHE` is a quarterstaff; the remaining `SCYTHE` weapons are axes.
 */
export function classifyWeaponFamily(identifier: string): DestinyWeaponFamilyId {
  const id = stripHandPrefix(albionSpecializationIdentifier(identifier));

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

/** Classifies an armor identifier into material + slot. */
export function classifyArmor(identifier: string): {
  material: DestinyArmorMaterialId;
  slot: DestinyArmorSlotId;
} {
  const id = albionSpecializationIdentifier(identifier);

  let slot: DestinyArmorSlotId = 'chest';
  if (id.startsWith('HEAD_')) slot = 'head';
  else if (id.startsWith('SHOES_')) slot = 'boots';
  else if (id.startsWith('ARMOR_')) slot = 'chest';

  let material: DestinyArmorMaterialId = 'other';
  if (id.includes('_PLATE')) material = 'plate';
  else if (id.includes('_LEATHER')) material = 'leather';
  else if (id.includes('_CLOTH')) material = 'cloth';
  else if (id.includes('_GATHERER')) material = 'gathering';

  return { material, slot };
}

/**
 * Merges saved specialization rows onto the combat catalog.
 *
 * One node per base identifier. A draft `previous` row wins over the saved
 * value so an in-progress edit survives a catalog refresh. Saved keys that
 * the catalog no longer lists are appended so historical data is not dropped.
 */
export function mergeSpecializationNodes(
  saved: readonly UserSpecialization[],
  catalog: readonly OpenAlbionItem[],
  previous: readonly DestinyItemNode[] = [],
): DestinyItemNode[] {
  const savedByKey = new Map<string, UserSpecialization>();
  for (const row of saved) {
    const nodeKey = normalizeAlbionSpecializationKey(row.node_key);
    if (!nodeKey.includes(':')) continue;
    const identifier = nodeKey.split(':').slice(1).join(':');
    const normalizedRow: UserSpecialization = {
      ...row,
      node_key: nodeKey,
      node_name: normalizeAlbionEquipmentName(identifier, row.node_name),
    };
    const current = savedByKey.get(nodeKey);
    if (!current || normalizedRow.level > current.level) {
      savedByKey.set(nodeKey, normalizedRow);
    }
  }

  const previousByKey = new Map(previous.map((row) => [row.node_key, row]));
  const nodes: DestinyItemNode[] = deduplicateAlbionCombatCatalog(catalog).flatMap((item) => {
    const category = item.type === 'armor' || item.type === 'weapon' ? item.type : null;
    const identifier = item.identifier?.trim();
    if (!category || !identifier) return [];
    const nodeKey = `${category}:${identifier}`;
    const stored = savedByKey.get(nodeKey);
    const draft = previousByKey.get(nodeKey);
    return [
      {
        node_key: nodeKey,
        node_name: normalizeAlbionEquipmentName(identifier, item.name),
        category,
        level: draft?.level ?? stored?.level ?? 0,
        icon: albionCombatIconUrl(identifier),
        identifier,
      },
    ];
  });

  const known = new Set(nodes.map((node) => node.node_key));
  for (const row of savedByKey.values()) {
    if (!known.has(row.node_key) && (row.category === 'weapon' || row.category === 'armor')) {
      nodes.push({
        node_key: row.node_key,
        node_name: row.node_name,
        category: row.category,
        level: previousByKey.get(row.node_key)?.level ?? row.level,
        icon: albionCombatIconUrl(row.node_key.split(':').slice(1).join(':')),
        identifier: row.node_key.split(':').slice(1).join(':'),
      });
    }
  }

  return nodes;
}

/**
 * Builds the Destiny Board forest from a flat specialization list.
 *
 * Weapons: branch → family → items.
 * Armor: branch → material → slot → items.
 */
export function buildDestinyBoardTree(items: readonly DestinyItemNode[]): DestinyGroupNode[] {
  const weapons = items.filter((item) => item.category === 'weapon');
  const armor = items.filter((item) => item.category === 'armor');
  const tree: DestinyGroupNode[] = [];

  const weaponFamilies = groupBy(weapons, (item) => classifyWeaponFamily(item.identifier));
  const weaponChildren = WEAPON_FAMILY_ORDER.flatMap((family) => {
    const familyItems = sortItems(weaponFamilies.get(family) ?? []);
    if (familyItems.length === 0) return [];
    return [
      {
        kind: 'group' as const,
        id: `weapon:${family}`,
        branch: 'weapon' as const,
        labelKey: WEAPON_FAMILY_LABEL[family],
        children: familyItems,
      },
    ];
  });
  if (weaponChildren.length > 0) {
    tree.push({
      kind: 'group',
      id: 'weapon',
      branch: 'weapon',
      labelKey: 'destiny.branch.weapons',
      children: weaponChildren,
    });
  }

  const byMaterial = groupBy(armor, (item) => classifyArmor(item.identifier).material);
  const armorChildren = ARMOR_MATERIAL_ORDER.flatMap((material) => {
    const materialItems = byMaterial.get(material) ?? [];
    if (materialItems.length === 0) return [];
    const bySlot = groupBy(materialItems, (item) => classifyArmor(item.identifier).slot);
    const slots = ARMOR_SLOT_ORDER.flatMap((slot) => {
      const slotItems = sortItems(bySlot.get(slot) ?? []);
      if (slotItems.length === 0) return [];
      return [
        {
          kind: 'group' as const,
          id: `armor:${material}:${slot}`,
          branch: 'armor' as const,
          labelKey: ARMOR_SLOT_LABEL[slot],
          children: slotItems,
        },
      ];
    });
    if (slots.length === 0) return [];
    return [
      {
        kind: 'group' as const,
        id: `armor:${material}`,
        branch: 'armor' as const,
        labelKey: ARMOR_MATERIAL_LABEL[material],
        children: slots,
      },
    ];
  });
  if (armorChildren.length > 0) {
    tree.push({
      kind: 'group',
      id: 'armor',
      branch: 'armor',
      labelKey: 'destiny.branch.armor',
      children: armorChildren,
    });
  }

  return tree;
}

/**
 * Filters the tree by combat branch and a free-text query.
 *
 * A query match on a leaf keeps the whole ancestor path. Empty groups drop out.
 */
export function filterDestinyTree(
  tree: readonly DestinyGroupNode[],
  query: string,
  category: AlbionCombatCategory | 'all' = 'all',
): DestinyGroupNode[] {
  const normalized = query.trim().toLowerCase();
  return tree.flatMap((branch) => {
    if (category !== 'all' && branch.branch !== category) return [];
    const filtered = filterNode(branch, normalized);
    return filtered && isDestinyGroup(filtered) ? [filtered] : [];
  });
}

/** IDs of groups that contain a query match, used to auto-expand search hits. */
export function matchingGroupIds(tree: readonly DestinyGroupNode[], query: string): Set<string> {
  const normalized = query.trim().toLowerCase();
  const ids = new Set<string>();
  if (!normalized) return ids;
  const visit = (node: DestinyTreeNode): boolean => {
    if (!isDestinyGroup(node)) return itemMatches(node, normalized);
    const childHit = node.children.some((child) => visit(child));
    if (childHit) ids.add(node.id);
    return childHit;
  };
  for (const branch of tree) visit(branch);
  return ids;
}

/** Trained count, leaf count, and level sum under a node. */
export function masterySummary(node: DestinyTreeNode): DestinyMasterySummary {
  if (!isDestinyGroup(node)) {
    return { trained: node.level > 0 ? 1 : 0, total: 1, sum: node.level };
  }
  return node.children.reduce<DestinyMasterySummary>(
    (acc, child) => {
      const next = masterySummary(child);
      return {
        trained: acc.trained + next.trained,
        total: acc.total + next.total,
        sum: acc.sum + next.sum,
      };
    },
    { trained: 0, total: 0, sum: 0 },
  );
}

/** Fill percent for a mastery bar: total levels earned over the 120 cap. */
export function masteryFillPercent(summary: DestinyMasterySummary): number {
  if (summary.total <= 0) return 0;
  return Math.min(100, Math.max(0, (summary.sum / (summary.total * 120)) * 100));
}

/** Combat-tree colour used by the radial Destiny Board. */
export type DestinyHue = 'warrior' | 'hunter' | 'mage' | 'gathering' | 'neutral';

const WARRIOR_FAMILIES: ReadonlySet<DestinyWeaponFamilyId> = new Set([
  'swords',
  'axes',
  'maces',
  'hammers',
  'crossbows',
]);
const HUNTER_FAMILIES: ReadonlySet<DestinyWeaponFamilyId> = new Set([
  'bows',
  'spears',
  'nature_staffs',
  'daggers',
  'quarterstaffs',
  'war_gloves',
  'shapeshifter_staffs',
]);
const MAGE_FAMILIES: ReadonlySet<DestinyWeaponFamilyId> = new Set([
  'fire_staffs',
  'holy_staffs',
  'arcane_staffs',
  'frost_staffs',
  'cursed_staffs',
]);

/** Stable id for a tree node, used by the radial layout and click targets. */
export function destinyNodeId(node: DestinyTreeNode): string {
  return isDestinyGroup(node) ? node.id : node.node_key;
}

/** Every specialization leaf under a node, including the node itself when it is a leaf. */
export function collectLeaves(node: DestinyTreeNode): DestinyItemNode[] {
  if (!isDestinyGroup(node)) return [node];
  return node.children.flatMap((child) => collectLeaves(child));
}

/** Finds a node by id (`weapon:bows`, `weapon:2H_BOW`, or `root`). */
export function findDestinyNode(
  tree: readonly DestinyGroupNode[],
  id: string,
): DestinyTreeNode | null {
  if (id === 'root') return null;
  const visit = (node: DestinyTreeNode): DestinyTreeNode | null => {
    if (destinyNodeId(node) === id) return node;
    if (!isDestinyGroup(node)) return null;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  for (const branch of tree) {
    const found = visit(branch);
    if (found) return found;
  }
  return null;
}

/** Clamps a mastery value to the inclusive 0–120 Albion range. */
export function clampMasteryLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(120, Math.max(0, Math.round(level)));
}

/** Returns a copy of `items` with the given keys set to `level`. */
export function setLevelsForKeys(
  items: readonly DestinyItemNode[],
  keys: ReadonlySet<string>,
  level: number,
): DestinyItemNode[] {
  const next = clampMasteryLevel(level);
  return items.map((item) => (keys.has(item.node_key) ? { ...item, level: next } : item));
}

/** Hue for a weapon family or armor material, matching Albion's combat tree colours. */
export function destinyHueForId(id: string, identifier = ''): DestinyHue {
  if (id === 'root') return 'neutral';
  if (id === 'weapon' || id.startsWith('weapon:')) {
    const family = id.slice('weapon:'.length) as DestinyWeaponFamilyId;
    if (WARRIOR_FAMILIES.has(family)) return 'warrior';
    if (HUNTER_FAMILIES.has(family)) return 'hunter';
    if (MAGE_FAMILIES.has(family)) return 'mage';
    if (identifier) {
      const classified = classifyWeaponFamily(identifier);
      if (WARRIOR_FAMILIES.has(classified)) return 'warrior';
      if (HUNTER_FAMILIES.has(classified)) return 'hunter';
      if (MAGE_FAMILIES.has(classified)) return 'mage';
    }
    return 'warrior';
  }
  if (id === 'armor' || id.startsWith('armor:')) {
    if (id.includes('leather')) return 'hunter';
    if (id.includes('cloth')) return 'mage';
    if (id.includes('gathering')) return 'gathering';
    if (id.includes('plate')) return 'warrior';
    if (identifier) {
      const { material } = classifyArmor(identifier);
      if (material === 'leather') return 'hunter';
      if (material === 'cloth') return 'mage';
      if (material === 'gathering') return 'gathering';
      if (material === 'plate') return 'warrior';
    }
    return 'warrior';
  }
  if (identifier) return destinyHueForId(`weapon:${classifyWeaponFamily(identifier)}`, identifier);
  return 'neutral';
}

/** One positioned node in the radial Destiny Board. */
export interface DestinyRadialNode {
  id: string;
  parentId: string | null;
  x: number;
  y: number;
  depth: number;
  hue: DestinyHue;
  labelKey: DestinyLabelKey | null;
  item: DestinyItemNode | null;
  icon: string | null;
  leafCount: number;
  sum: number;
}

/** Straight spoke from a parent hub to a child. */
export interface DestinyRadialEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hue: DestinyHue;
  fill: number;
}

export interface DestinyRadialLayout {
  width: number;
  height: number;
  cx: number;
  cy: number;
  nodes: DestinyRadialNode[];
  edges: DestinyRadialEdge[];
}

const RADIAL_SIZE = 1600;
/** Concentric rings: hub, branch, family/material, slot or item, armor item. */
const RADIAL_RADIUS = [0, 140, 320, 560, 780] as const;
/** Fraction of a parent's angle reserved as gutters between sibling fans. */
const SIBLING_GAP = 0.18;

/**
 * Lays the Destiny Board out as a radial fan: weapons on the left, armor on the
 * right, children spreading on concentric rings — the same geometry as Albion's
 * combat tree.
 */
export function layoutDestinyRadial(tree: readonly DestinyGroupNode[]): DestinyRadialLayout {
  const cx = RADIAL_SIZE / 2;
  const cy = RADIAL_SIZE / 2;
  const nodes: DestinyRadialNode[] = [];
  const edges: DestinyRadialEdge[] = [];

  const weapons = tree.find((branch) => branch.id === 'weapon') ?? null;
  const armor = tree.find((branch) => branch.id === 'armor') ?? null;
  const weaponLeaves = weapons ? collectLeaves(weapons).length : 0;
  const armorLeaves = armor ? collectLeaves(armor).length : 0;
  const totalLeaves = Math.max(1, weaponLeaves + armorLeaves);

  const rootSummary = tree.reduce(
    (acc, branch) => {
      const next = masterySummary(branch);
      return { trained: acc.trained + next.trained, total: acc.total + next.total, sum: acc.sum + next.sum };
    },
    { trained: 0, total: 0, sum: 0 },
  );

  nodes.push({
    id: 'root',
    parentId: null,
    x: cx,
    y: cy,
    depth: 0,
    hue: 'neutral',
    labelKey: 'destiny.board',
    item: null,
    icon: (weapons && firstNodeIcon(weapons)) || (armor && firstNodeIcon(armor)) || null,
    leafCount: rootSummary.total,
    sum: rootSummary.sum,
  });

  const place = (
    node: DestinyTreeNode,
    startAngle: number,
    endAngle: number,
    depth: number,
    parentId: string,
    parentHue: DestinyHue,
  ): void => {
    const id = destinyNodeId(node);
    const mid = (startAngle + endAngle) / 2;
    const radius = RADIAL_RADIUS[Math.min(depth, RADIAL_RADIUS.length - 1)] ?? RADIAL_RADIUS[RADIAL_RADIUS.length - 1];
    const x = cx + radius * Math.cos(mid);
    const y = cy + radius * Math.sin(mid);
    const summary = masterySummary(node);
    const item = isDestinyGroup(node) ? null : node;
    const hue = destinyHueForId(id, item?.identifier ?? '');
    nodes.push({
      id,
      parentId,
      x,
      y,
      depth,
      hue,
      labelKey: isDestinyGroup(node) ? node.labelKey : null,
      item,
      icon: firstNodeIcon(node),
      leafCount: summary.total,
      sum: summary.sum,
    });
    const parent = nodes.find((entry) => entry.id === parentId);
    if (parent) {
      edges.push({
        id: `${parentId}->${id}`,
        x1: parent.x,
        y1: parent.y,
        x2: x,
        y2: y,
        hue: parentHue === 'neutral' ? hue : parentHue,
        fill: masteryFillPercent(summary) / 100,
      });
    }
    if (!isDestinyGroup(node) || node.children.length === 0) return;
    const weights = node.children.map((child) => Math.max(1, collectLeaves(child).length));
    const weightSum = weights.reduce((acc, value) => acc + value, 0);
    const parentSpan = endAngle - startAngle;
    const gapCount = Math.max(0, node.children.length - 1);
    const gapSpan = parentSpan * SIBLING_GAP;
    const usable = parentSpan - gapSpan;
    const gapEach = gapCount > 0 ? gapSpan / gapCount : 0;
    let cursor = startAngle;
    node.children.forEach((child, index) => {
      const span = usable * (weights[index] / weightSum);
      place(child, cursor, cursor + span, depth + 1, id, hue);
      cursor += span + (index < gapCount ? gapEach : 0);
    });
  };

  // Left hemisphere = weapons, right hemisphere = armor, sized by leaf count.
  const weaponSpan = (Math.PI * weaponLeaves) / totalLeaves || Math.PI;
  const armorSpan = (Math.PI * armorLeaves) / totalLeaves || Math.PI;
  if (weapons) {
    place(weapons, Math.PI - weaponSpan, Math.PI + weaponSpan, 1, 'root', 'neutral');
  }
  if (armor) {
    const start = -armorSpan;
    place(armor, start, start + 2 * armorSpan, 1, 'root', 'neutral');
  }

  return { width: RADIAL_SIZE, height: RADIAL_SIZE, cx, cy, nodes, edges };
}

function firstNodeIcon(node: DestinyTreeNode): string | null {
  if (!isDestinyGroup(node)) return albionCombatIconUrl(node.identifier);
  const leaf = collectLeaves(node)[0];
  return leaf ? albionCombatIconUrl(leaf.identifier) : null;
}

function filterNode(node: DestinyTreeNode, query: string): DestinyTreeNode | null {
  if (!isDestinyGroup(node)) {
    return !query || itemMatches(node, query) ? node : null;
  }
  const children = node.children.flatMap((child) => {
    const filtered = filterNode(child, query);
    return filtered ? [filtered] : [];
  });
  if (children.length === 0) return null;
  return { ...node, children };
}

function itemMatches(item: DestinyItemNode, query: string): boolean {
  return (
    item.node_name.toLowerCase().includes(query) || item.identifier.toLowerCase().includes(query)
  );
}

function sortItems(items: readonly DestinyItemNode[]): DestinyItemNode[] {
  return [...items].sort(
    (left, right) =>
      left.node_name.localeCompare(right.node_name) || left.node_key.localeCompare(right.node_key),
  );
}

function groupBy<K, T>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function stripHandPrefix(identifier: string): string {
  return identifier.replace(/^(?:MAIN|2H|OFF)_/, '');
}
