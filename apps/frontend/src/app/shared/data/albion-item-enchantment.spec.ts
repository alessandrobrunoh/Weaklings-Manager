import { describe, expect, it } from 'vitest';

import {
  albionTierLabel,
  DEFAULT_ALBION_ITEM_ENCHANTMENT,
  isAlbionItemEnchantment,
  normalizeAlbionItemEnchantment,
} from './albion-item-enchantment';

describe('albion item enchantment', () => {
  it('treats plain gear as the default', () => {
    expect(DEFAULT_ALBION_ITEM_ENCHANTMENT).toBe(0);
    expect(normalizeAlbionItemEnchantment(null)).toBe(0);
    expect(normalizeAlbionItemEnchantment(undefined)).toBe(0);
  });

  it('accepts the whole ladder and rejects anything outside it', () => {
    for (const level of [0, 1, 2, 3, 4]) {
      expect(isAlbionItemEnchantment(level)).toBe(true);
    }
    expect(isAlbionItemEnchantment(5)).toBe(false);
    expect(isAlbionItemEnchantment(-1)).toBe(false);
    expect(isAlbionItemEnchantment(1.5)).toBe(false);
  });

  it('coerces an out-of-range value back to plain', () => {
    expect(normalizeAlbionItemEnchantment(9)).toBe(0);
    expect(normalizeAlbionItemEnchantment(-2)).toBe(0);
  });

  it('writes a tier the way the game does', () => {
    expect(albionTierLabel('8', 2)).toBe('T8.2');
    expect(albionTierLabel('8', 0)).toBe('T8');
    expect(albionTierLabel('T8', 4)).toBe('T8.4');
  });

  it('drops a decimal the old catalog baked into the tier', () => {
    expect(albionTierLabel('4.1', 0)).toBe('T4');
    expect(albionTierLabel('4.1', 3)).toBe('T4.3');
  });

  it('renders nothing when the tier is missing', () => {
    expect(albionTierLabel(null, 2)).toBe('');
    expect(albionTierLabel('', 2)).toBe('');
  });
});
