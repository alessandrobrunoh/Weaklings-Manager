import type {
  BuildDetail,
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  CompDetail,
  OpenAlbionItemAbilities,
} from '../../core/models/api.models';
import { albionItemQualityLabel } from '../../shared/data/albion-item-quality';

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

/** One difference between two versions, as a line the reader can act on. */
export interface VersionDiffEntry {
  /** What the change is about, e.g. `Main · Weapon` or a build name. */
  subject: string;
  /** What the left-hand version has, or null when it has nothing. */
  before: string | null;
  /** What the right-hand version has, or null when it has nothing. */
  after: string | null;
  /** Carries the meaning without relying on colour. */
  change: 'added' | 'removed' | 'changed';
}

const LOADOUT_LABELS: Record<BuildLoadout, string> = { main: 'Main', swap: 'Swap' };

const SLOT_LABELS: Record<BuildSlot, string> = {
  weapon: 'Weapon',
  off_hand: 'Off-hand',
  head: 'Head',
  armor: 'Armor',
  shoes: 'Shoes',
  cape: 'Cape',
  bag: 'Bag',
  potion: 'Potion',
  food: 'Food',
  mount: 'Mount',
};

function classify(before: string | null, after: string | null): VersionDiffEntry['change'] {
  if (before === null) {
    return 'added';
  }
  if (after === null) {
    return 'removed';
  }
  return 'changed';
}

function itemKey(item: BuildItemSlot): string {
  return `${item.loadout ?? 'main'}::${item.slot}`;
}

/** A slot's contents as one readable line: the item, then the abilities slotted on it. */
function describeItem(item: BuildItemSlot, names: AbilityNames): string {
  const named = (id: string) => names[id] ?? id;
  const abilities = [
    ...Object.entries(item.spells?.active ?? {}).map(
      ([index, id]) => [Number(index), `${index}. ${named(id)}`] as const,
    ),
    ...Object.entries(item.spells?.passive ?? {}).map(
      ([index, id]) => [100 + Number(index), `Passive: ${named(id)}`] as const,
    ),
  ]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text);
  const tier = item.openalbion_item_tier ? `T${item.openalbion_item_tier}` : '';
  const quality = albionItemQualityLabel(item.openalbion_item_quality);
  const suffix = [tier, quality].filter(Boolean).join(' · ');
  const labeled = suffix ? `${item.openalbion_item_name} (${suffix})` : item.openalbion_item_name;
  return abilities.length > 0 ? `${labeled} — ${abilities.join(', ')}` : labeled;
}

/**
 * Compares two build versions slot by slot, across both loadouts.
 *
 * The point of a comparison is to explain a win-rate gap, so the diff covers what was equipped
 * *and* which abilities were slotted on it — a version that only changed its Q reads as a change,
 * not as identical.
 *
 * Returns an empty list when the two versions are equivalent.
 *
 * @example
 * ```ts
 * const changes = diffBuildVersions(v1, v2);
 * // [{ subject: 'Main · Weapon', before: 'Polehammer', after: 'Realmbreaker', change: 'changed' }]
 * ```
 */
export function diffBuildVersions(
  left: BuildDetail,
  right: BuildDetail,
  names: AbilityNames = {},
): VersionDiffEntry[] {
  const byKey = (detail: BuildDetail) =>
    new Map(detail.items.map((item) => [itemKey(item), item] as const));
  const before = byKey(left);
  const after = byKey(right);

  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: VersionDiffEntry[] = [];

  for (const key of keys) {
    const leftItem = before.get(key);
    const rightItem = after.get(key);
    const leftText = leftItem ? describeItem(leftItem, names) : null;
    const rightText = rightItem ? describeItem(rightItem, names) : null;
    if (leftText === rightText) {
      continue;
    }

    const [loadout, slot] = key.split('::') as [BuildLoadout, BuildSlot];
    entries.push({
      subject: `${LOADOUT_LABELS[loadout] ?? loadout} · ${SLOT_LABELS[slot] ?? slot}`,
      before: leftText,
      after: rightText,
      change: classify(leftText, rightText),
    });
  }

  return entries;
}

/**
 * Compares two comp versions by which builds they field and in what numbers.
 *
 * Entries are keyed by build name *and version*, not by name alone: a comp can field two versions
 * of the same build group at once — "Pole Hammer v1 x10 and Pole Hammer v2 x4" is a normal way to
 * trial a change — and keying by name would silently collapse them into one line.
 *
 * Not keyed by build id either, so a comp that swapped one build for another still reads as an
 * add and a remove rather than as two unrelated ids.
 */
export function diffCompVersions(left: CompDetail, right: CompDetail): VersionDiffEntry[] {
  const byName = (detail: CompDetail) =>
    new Map(
      detail.builds.map(
        (entry) => [`${entry.build.name} v${entry.build.version ?? 1}`, entry.quantity] as const,
      ),
    );
  const before = byName(left);
  const after = byName(right);

  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: VersionDiffEntry[] = [];

  for (const name of names) {
    const leftQuantity = before.get(name);
    const rightQuantity = after.get(name);
    if (leftQuantity === rightQuantity) {
      continue;
    }
    const leftText = leftQuantity === undefined ? null : `x${leftQuantity}`;
    const rightText = rightQuantity === undefined ? null : `x${rightQuantity}`;
    entries.push({
      subject: name,
      before: leftText,
      after: rightText,
      change: classify(leftText, rightText),
    });
  }

  return entries;
}
