import type {
  BuildDetail,
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  CompDetail,
  OpenAlbionItemAbilities,
} from '../../core/models/api.models';
import { albionTierLabel } from '../../shared/data/albion-item-enchantment';
import {
  albionItemQualityLabel,
  DEFAULT_ALBION_ITEM_QUALITY,
  normalizeAlbionItemQuality,
} from '../../shared/data/albion-item-quality';
import { SLOT_ORDER, slotSupportsQuality } from './build-loadouts';

/** Maps a spell id to its player-facing name. */
export type AbilityNames = Readonly<Record<string, string>>;

/**
 * Flattens the ability catalog into an id → name lookup.
 *
 * The diff is read by a person deciding which version to run, so it has to say "Iron Breaker", not
 * `IRONBREAKER`. Ids the catalog does not know fall back to themselves rather than vanishing.
 */
export function abilityNameLookup(
  catalog: Readonly<Record<string, OpenAlbionItemAbilities>>,
): AbilityNames {
  const names: Record<string, string> = {};
  for (const entry of Object.values(catalog)) {
    for (const choices of [...Object.values(entry.active), ...Object.values(entry.passive)]) {
      for (const choice of choices) {
        names[choice.id] = choice.name;
      }
    }
  }
  return names;
}

/**
 * One thing that changed inside an entry: the item, one spell, a version or a quantity.
 *
 * A row of the diff shows only the tokens that differ, so a swapped Q reads as "Q: Heroic Strike
 * to Cleave" rather than as two long lines that differ in one word.
 */
export interface VersionDiffToken {
  readonly kind: 'item' | 'spell' | 'version' | 'quantity';
  /** Short name of what changed: "Item", a spell key (`Q`, `W`, `Passive`), "Version", "Players". */
  readonly label: string;
  /** What the older version has, or `null` when it has nothing. */
  readonly before: string | null;
  /** What the newer version has, or `null` when it has nothing. */
  readonly after: string | null;
}

/** One difference between two versions, as a line the reader can act on. */
export interface VersionDiffEntry {
  /** What the change is about: a slot name such as `Weapon`, or a build name. */
  subject: string;
  /** Section the entry belongs to (`Main` or `Swap` for a build); entries without one are flat. */
  group?: string;
  /** The older side as one line (item, tier, quality and abilities), or null when it has nothing. */
  before: string | null;
  /** The newer side as one line, or null when it has nothing. */
  after: string | null;
  /** Carries the meaning without relying on colour. */
  change: 'added' | 'removed' | 'changed';
  /** Only what differs, token by token. A renderer falls back to `before` / `after` without it. */
  tokens?: readonly VersionDiffToken[];
}

/** Player-facing words the build diff needs. The page passes translated ones. */
export interface BuildDiffLabels {
  readonly loadout: Readonly<Record<BuildLoadout, string>>;
  readonly slot: Readonly<Record<BuildSlot, string>>;
  readonly passive: string;
  readonly item: string;
  /** Name of a quality grade (1 to 5). */
  readonly quality: (quality: number) => string;
}

/** English words, used when the caller passes none (tests, and any non-UI use). */
export const DEFAULT_BUILD_DIFF_LABELS: BuildDiffLabels = {
  loadout: { main: 'Main', swap: 'Swap' },
  slot: {
    weapon: 'Weapon',
    off_hand: 'Off-hand',
    head: 'Head',
    armor: 'Armor',
    shoes: 'Shoes',
    cape: 'Cape',
    bag: 'Bag',
    food: 'Food',
    potion: 'Potion',
    mount: 'Mount',
  },
  passive: 'Passive',
  item: 'Item',
  quality: (quality) => albionItemQualityLabel(quality),
};

/** Words for the composition diff. */
export interface CompDiffLabels {
  readonly version: string;
  readonly players: string;
}

export const DEFAULT_COMP_DIFF_LABELS: CompDiffLabels = { version: 'Version', players: 'Players' };

/** The in-game key each slot's active spells are bound to. */
const ACTIVE_KEYS: Partial<Record<BuildSlot, readonly string[]>> = {
  weapon: ['Q', 'W', 'E'],
  head: ['D'],
  armor: ['R'],
  shoes: ['F'],
};

function classify(before: unknown, after: unknown): VersionDiffEntry['change'] {
  if (before === null || before === undefined) {
    return 'added';
  }
  if (after === null || after === undefined) {
    return 'removed';
  }
  return 'changed';
}

function itemKey(item: BuildItemSlot): string {
  return `${item.loadout ?? 'main'}::${item.slot}`;
}

function qualityOf(item: BuildItemSlot): number {
  return normalizeAlbionItemQuality(item.openalbion_item_quality);
}

/** The item as one phrase: `Polehammer T8.1`, plus its quality when `withQuality` asks for it. */
function itemText(item: BuildItemSlot, labels: BuildDiffLabels, withQuality: boolean): string {
  const tier = albionTierLabel(item.openalbion_item_tier, item.openalbion_item_enchantment);
  const name = tier ? `${item.openalbion_item_name} ${tier}` : item.openalbion_item_name;
  return withQuality ? `${name} · ${labels.quality(qualityOf(item))}` : name;
}

interface SpellRef {
  readonly key: string;
  /** Sort position: actives first, then passives. */
  readonly order: number;
  readonly id: string;
}

/** Every chosen spell of an item, keyed by the in-game key it is bound to. */
function spellsOf(item: BuildItemSlot, labels: BuildDiffLabels): Map<string, SpellRef> {
  const keys = ACTIVE_KEYS[item.slot] ?? [];
  const passiveCount = Object.keys(item.spells?.passive ?? {}).length;
  const refs = new Map<string, SpellRef>();
  for (const [index, id] of Object.entries(item.spells?.active ?? {})) {
    const key = keys[Number(index) - 1] ?? index;
    refs.set(`active:${key}`, { key, order: Number(index), id });
  }
  for (const [index, id] of Object.entries(item.spells?.passive ?? {})) {
    const key = passiveCount > 1 ? `${labels.passive} ${index}` : labels.passive;
    refs.set(`passive:${key}`, { key, order: 100 + Number(index), id });
  }
  return refs;
}

/** A slot's contents as one readable line: the item, then the abilities slotted on it. */
function describeItem(
  item: BuildItemSlot,
  labels: BuildDiffLabels,
  names: AbilityNames,
  withQuality: boolean,
): string {
  const spells = [...spellsOf(item, labels).values()]
    .sort((left, right) => left.order - right.order)
    .map((spell) => `${spell.key} ${names[spell.id] ?? spell.id}`);
  const text = itemText(item, labels, withQuality);
  return spells.length > 0 ? `${text} — ${spells.join(', ')}` : text;
}

/** Quality is worth printing when it is not the guild default, or when it is what changed. */
function showsQuality(left: BuildItemSlot | undefined, right: BuildItemSlot | undefined): boolean {
  const relevant = [left, right].filter(
    (item): item is BuildItemSlot => item !== undefined && slotSupportsQuality(item.slot),
  );
  if (relevant.length === 0) {
    return false;
  }
  return relevant.some((item) => qualityOf(item) !== DEFAULT_ALBION_ITEM_QUALITY) ||
    (relevant.length === 2 && qualityOf(relevant[0]) !== qualityOf(relevant[1]));
}

function tokensFor(
  left: BuildItemSlot | undefined,
  right: BuildItemSlot | undefined,
  labels: BuildDiffLabels,
  names: AbilityNames,
  withQuality: boolean,
): VersionDiffToken[] {
  const tokens: VersionDiffToken[] = [];
  const sameItem =
    left !== undefined &&
    right !== undefined &&
    left.openalbion_item_id === right.openalbion_item_id &&
    left.openalbion_item_name === right.openalbion_item_name &&
    albionTierLabel(left.openalbion_item_tier, left.openalbion_item_enchantment) ===
      albionTierLabel(right.openalbion_item_tier, right.openalbion_item_enchantment) &&
    (!slotSupportsQuality(left.slot) || qualityOf(left) === qualityOf(right));
  if (!sameItem) {
    tokens.push({
      kind: 'item',
      label: labels.item,
      before: left ? itemText(left, labels, withQuality) : null,
      after: right ? itemText(right, labels, withQuality) : null,
    });
  }

  const before = left ? spellsOf(left, labels) : new Map<string, SpellRef>();
  const after = right ? spellsOf(right, labels) : new Map<string, SpellRef>();
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const spellTokens = keys
    .map((key) => ({ before: before.get(key), after: after.get(key) }))
    .filter(({ before: was, after: now }) => was?.id !== now?.id)
    .map(({ before: was, after: now }) => ({ was, now }))
    .sort((a, b) => (a.was ?? a.now)!.order - (b.was ?? b.now)!.order);
  for (const { was, now } of spellTokens) {
    tokens.push({
      kind: 'spell',
      label: (was ?? now)!.key,
      before: was ? (names[was.id] ?? was.id) : null,
      after: now ? (names[now.id] ?? now.id) : null,
    });
  }
  return tokens;
}

/**
 * Compares two build versions slot by slot, across both loadouts.
 *
 * `left` is the older version and `right` the newer one, so every entry reads old to new. Entries
 * come grouped by loadout (`Main`, then `Swap`) and ordered like the loadout view: weapon,
 * off-hand, head, armor, shoes, cape, bag, food, potion, mount. Each entry carries only the tokens
 * that changed: the item (with its tier and, when it matters, quality) and any spell whose choice
 * differs, by its key.
 *
 * The point of a comparison is to explain a win-rate gap, so it covers what was equipped *and*
 * which abilities were slotted on it: a version that only changed its Q reads as a change, not as
 * identical.
 *
 * Returns an empty list when the two versions are equivalent.
 *
 * @example
 * ```ts
 * const changes = diffBuildVersions(v1, v2, names, labels);
 * // [{ group: 'Main', subject: 'Weapon', change: 'changed',
 * //    tokens: [{ kind: 'item', label: 'Item', before: 'Polehammer T8', after: 'Realmbreaker T8' }] }]
 * ```
 */
export function diffBuildVersions(
  left: BuildDetail,
  right: BuildDetail,
  names: AbilityNames = {},
  labels: BuildDiffLabels = DEFAULT_BUILD_DIFF_LABELS,
): VersionDiffEntry[] {
  const byKey = (detail: BuildDetail) =>
    new Map(detail.items.map((item) => [itemKey(item), item] as const));
  const before = byKey(left);
  const after = byKey(right);

  const entries: VersionDiffEntry[] = [];
  for (const loadout of ['main', 'swap'] as const) {
    for (const slot of SLOT_ORDER) {
      const key = `${loadout}::${slot}`;
      const was = before.get(key);
      const now = after.get(key);
      if (!was && !now) {
        continue;
      }
      const withQuality = showsQuality(was, now);
      const tokens = tokensFor(was, now, labels, names, withQuality);
      if (tokens.length === 0) {
        continue;
      }
      entries.push({
        group: labels.loadout[loadout],
        subject: labels.slot[slot],
        before: was ? describeItem(was, labels, names, withQuality) : null,
        after: now ? describeItem(now, labels, names, withQuality) : null,
        change: classify(was, now),
        tokens,
      });
    }
  }
  return entries;
}

/**
 * Compares two comp versions by which builds they field and in what numbers.
 *
 * Builds are matched by lineage (name and category), so a comp that moved from "Pole Hammer v1" to
 * "Pole Hammer v3" reads as one changed line with the version and the player count, not as a
 * removed build and an added one. When a lineage is fielded in several versions at once, or on one
 * side only, the lines are per version instead: "Pole Hammer v1 x10 and Pole Hammer v2 x4" is a
 * normal way to trial a change, and collapsing it would hide one of the two.
 *
 * `left` is the older comp version and `right` the newer one.
 */
export function diffCompVersions(
  left: CompDetail,
  right: CompDetail,
  labels: CompDiffLabels = DEFAULT_COMP_DIFF_LABELS,
): VersionDiffEntry[] {
  const lineages = (detail: CompDetail) => {
    const map = new Map<string, { name: string; versions: Map<number, number> }>();
    for (const entry of detail.builds) {
      const key = `${entry.build.name}|${entry.build.category_id}`;
      const lineage = map.get(key) ?? { name: entry.build.name, versions: new Map<number, number>() };
      const version = entry.build.version ?? 1;
      lineage.versions.set(version, (lineage.versions.get(version) ?? 0) + entry.quantity);
      map.set(key, lineage);
    }
    return map;
  };
  const before = lineages(left);
  const after = lineages(right);

  const entries: VersionDiffEntry[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    const name = (was ?? now)!.name;
    const oldVersions = was?.versions ?? new Map<number, number>();
    const newVersions = now?.versions ?? new Map<number, number>();

    if (oldVersions.size === 1 && newVersions.size === 1) {
      const [[oldVersion, oldQuantity]] = [...oldVersions];
      const [[newVersion, newQuantity]] = [...newVersions];
      if (oldVersion !== newVersion) {
        const tokens: VersionDiffToken[] = [
          { kind: 'version', label: labels.version, before: `v${oldVersion}`, after: `v${newVersion}` },
        ];
        if (oldQuantity !== newQuantity) {
          tokens.push({
            kind: 'quantity',
            label: labels.players,
            before: `x${oldQuantity}`,
            after: `x${newQuantity}`,
          });
        }
        entries.push({
          subject: name,
          before: `v${oldVersion} x${oldQuantity}`,
          after: `v${newVersion} x${newQuantity}`,
          change: 'changed',
          tokens,
        });
        continue;
      }
    }

    for (const version of new Set([...oldVersions.keys(), ...newVersions.keys()])) {
      const oldQuantity = oldVersions.get(version);
      const newQuantity = newVersions.get(version);
      if (oldQuantity === newQuantity) {
        continue;
      }
      const beforeText = oldQuantity === undefined ? null : `x${oldQuantity}`;
      const afterText = newQuantity === undefined ? null : `x${newQuantity}`;
      entries.push({
        subject: `${name} v${version}`,
        before: beforeText,
        after: afterText,
        change: classify(beforeText, afterText),
        tokens: [{ kind: 'quantity', label: labels.players, before: beforeText, after: afterText }],
      });
    }
  }

  return entries.sort(
    (a, b) => a.subject.localeCompare(b.subject) || (a.before ?? '').localeCompare(b.before ?? ''),
  );
}
