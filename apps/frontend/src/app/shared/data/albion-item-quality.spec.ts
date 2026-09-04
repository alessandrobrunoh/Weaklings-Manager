import { describe, expect, it } from 'vitest';

import {
  albionIconUrlWithQuality,
  albionItemQualityLabel,
  normalizeAlbionItemQuality,
} from './albion-item-quality';

describe('Albion item quality', () => {
  it('defaults omitted and out-of-range values to Excellent', () => {
    expect(normalizeAlbionItemQuality(undefined)).toBe(4);
    expect(normalizeAlbionItemQuality(null)).toBe(4);
    expect(normalizeAlbionItemQuality(0)).toBe(4);
    expect(normalizeAlbionItemQuality(6)).toBe(4);
    expect(normalizeAlbionItemQuality(5)).toBe(5);
  });

  it('names each Albion grade', () => {
    expect(albionItemQualityLabel(1)).toBe('Normal');
    expect(albionItemQualityLabel(4)).toBe('Excellent');
    expect(albionItemQualityLabel(5)).toBe('Masterpiece');
  });

  it('rewrites a catalog icon so the CDN serves the chosen grade', () => {
    expect(
      albionIconUrlWithQuality(
        'https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=96',
        4,
      ),
    ).toBe('https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=4&size=96');
  });
});
