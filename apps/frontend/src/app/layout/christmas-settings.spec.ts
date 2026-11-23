import { describe, expect, it } from 'vitest';
import { defaultLayers } from './christmas-settings';

describe('platform Christmas mix', () => {
  const defaults = { enabled: true, preset: 2, intensity: 1 };

  it('preserves existing preset-only settings', () => {
    expect(defaultLayers({ ...defaults, layers: null })).toEqual(['lights']);
  });

  it('combines snow on cards with lights independently of the preset', () => {
    expect(defaultLayers({ ...defaults, layers: 0b110 })).toEqual(['caps', 'lights']);
  });

  it('keeps an explicitly empty mix empty', () => {
    expect(defaultLayers({ ...defaults, layers: 0 })).toEqual([]);
  });
});
