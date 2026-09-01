import type {
  BuildItemSlot,
  BuildItemSpells,
  BuildSlot,
  OpenAlbionAbility,
  OpenAlbionItemAbilities,
} from '../../core/models/api.models';

/** One ability slot on an equipped item, ready to render as a picker or a read-only chip. */
export interface AbilitySlotView {
  kind: 'active' | 'passive';
  /** 1-based index within its kind. */
  index: number;
  /** The in-game key, or `Passive` for a passive slot. */
  label: string;
  /** Everything this slot accepts. */
  choices: readonly OpenAlbionAbility[];
  /** The currently chosen spell id, if any. */
  selected: string | null;
}

/**
 * The in-game key each equipment slot's active ability is bound to.
 *
 * A weapon fills Q, W and E; the armor pieces each contribute one, and off-hands, capes and the
 * rest contribute none. Slots absent from this map have no active abilities at all.
 */
const ACTIVE_KEYS: Partial<Record<BuildSlot, readonly string[]>> = {
  weapon: ['Q', 'W', 'E'],
  head: ['D'],
  armor: ['R'],
  shoes: ['F'],
};

/** Albion's public spell icon CDN — the same host already used for item icons. */
export function albionAbilityIconUrl(spellId: string): string {
  return `https://render.albiononline.com/v1/spell/${encodeURIComponent(spellId)}.png`;
}

/**
 * Strips the tier prefix and enchantment suffix from a catalog identifier.
 *
 * `T8_MAIN_SWORD@2` becomes `MAIN_SWORD`, which is how the ability catalog is keyed.
 */
export function abilityCatalogKey(identifier: string): string {
  return identifier
    .trim()
    .toUpperCase()
    .replace(/^T\d+_/, '')
    .replace(/@\d+$/, '');
}

/**
 * Recovers an equipped item's ability-catalog key.
 *
 * A build item stores the catalog's numeric id and the rendered icon URL rather than the identifier
 * itself, so the identifier is read back out of the icon URL — the one place it survives.
 * `https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1` yields `MAIN_SWORD`.
 */
export function abilityKeyForItem(item: Pick<BuildItemSlot, 'openalbion_item_icon'>): string | null {
  const icon = item.openalbion_item_icon;
  if (!icon) {
    return null;
  }
  const file = icon.split('/').pop();
  const stem = file?.split(/[.?]/)[0];
  return stem ? abilityCatalogKey(stem) : null;
}

/**
 * Builds one picker per ability slot the item actually has.
 *
 * Slot counts come from the catalog entry, never from the equipment slot, so an Albion patch that
 * changes a count needs only a dataset regeneration. Returns an empty list for anything that offers
 * no abilities — off-hands, capes, bags, consumables, mounts — so those render no picker at all.
 *
 * @example
 * ```ts
 * const slots = abilitySlotsFor('weapon', abilities['MAIN_SWORD'], item.spells);
 * // [{ kind: 'active', index: 1, label: 'Q', … }, …, { kind: 'passive', index: 1, label: 'Passive', … }]
 * ```
 */
export function abilitySlotsFor(
  slot: BuildSlot,
  abilities: OpenAlbionItemAbilities | undefined,
  chosen: BuildItemSpells | undefined,
  passiveLabel = 'Passive',
): AbilitySlotView[] {
  if (!abilities) {
    return [];
  }

  const keys = ACTIVE_KEYS[slot] ?? [];
  const views: AbilitySlotView[] = [];

  for (let index = 1; index <= abilities.active_slots; index += 1) {
    const choices = abilities.active[String(index)] ?? [];
    if (choices.length === 0) {
      continue;
    }
    views.push({
      kind: 'active',
      index,
      label: keys[index - 1] ?? String(index),
      choices,
      selected: chosen?.active?.[String(index)] ?? null,
    });
  }

  for (let index = 1; index <= abilities.passive_slots; index += 1) {
    const choices = abilities.passive[String(index)] ?? [];
    if (choices.length === 0) {
      continue;
    }
    views.push({
      kind: 'passive',
      index,
      label: abilities.passive_slots > 1 ? `${passiveLabel} ${index}` : passiveLabel,
      choices,
      selected: chosen?.passive?.[String(index)] ?? null,
    });
  }

  return views;
}

/** Applies one picker change to a selection, dropping the entry when the choice is cleared. */
export function withAbilityChoice(
  current: BuildItemSpells | undefined,
  kind: 'active' | 'passive',
  index: number,
  spellId: string | null,
): BuildItemSpells {
  const next: BuildItemSpells = {
    active: { ...(current?.active ?? {}) },
    passive: { ...(current?.passive ?? {}) },
  };
  if (spellId) {
    next[kind][String(index)] = spellId;
  } else {
    delete next[kind][String(index)];
  }
  return next;
}

/** Looks up a chosen spell's display name, falling back to its id when the dataset lacks it. */
export function abilityName(
  slots: readonly AbilitySlotView[],
  kind: 'active' | 'passive',
  index: number,
): string | null {
  const view = slots.find((entry) => entry.kind === kind && entry.index === index);
  if (!view?.selected) {
    return null;
  }
  return view.choices.find((choice) => choice.id === view.selected)?.name ?? view.selected;
}
