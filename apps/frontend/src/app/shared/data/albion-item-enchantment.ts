/**
 * Albion enchantment levels, 0 (plain) through 4.
 *
 * Enchantment is independent of quality and of the item's identifier: a build records it as its
 * own column, because tier and enchantment together are what fix an item's Item Power — a T8.0
 * weapon is 1100 and a T8.2 is 1300, and quality moves that by a further +0 to +100.
 */
export const ALBION_ITEM_ENCHANTMENTS = [0, 1, 2, 3, 4] as const;

export type AlbionItemEnchantment = (typeof ALBION_ITEM_ENCHANTMENTS)[number];

/** Plain gear — the value every build item saved before enchantment existed carries. */
export const DEFAULT_ALBION_ITEM_ENCHANTMENT: AlbionItemEnchantment = 0;

/** True when `value` is a real Albion enchantment level. */
export function isAlbionItemEnchantment(value: number): value is AlbionItemEnchantment {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

/** Coerces an API/UI value to a valid enchantment, defaulting to plain. */
export function normalizeAlbionItemEnchantment(
  value: number | null | undefined,
): AlbionItemEnchantment {
  const level = value ?? DEFAULT_ALBION_ITEM_ENCHANTMENT;
  return isAlbionItemEnchantment(level) ? level : DEFAULT_ALBION_ITEM_ENCHANTMENT;
}

/**
 * The in-game way of writing a tier and enchantment together: `T8.2`, or plain `T8` at level 0.
 *
 * `tier` arrives from the API either bare (`"8"`) or already prefixed (`"T8"`), and occasionally
 * with a decimal the old catalog baked in (`"4.1"`); everything after the dot is dropped, because
 * the enchantment column is now the single source for it.
 */
export function albionTierLabel(
  tier: string | null | undefined,
  enchantment: number | null | undefined,
): string {
  const digits = (tier ?? '').trim().replace(/^T/i, '').split('.')[0];
  if (!digits) {
    return '';
  }
  const level = normalizeAlbionItemEnchantment(enchantment);
  return level > 0 ? `T${digits}.${level}` : `T${digits}`;
}
