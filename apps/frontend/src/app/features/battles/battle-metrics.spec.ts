import { describe, expect, it } from 'vitest';

import {
  albionBattlesUrl,
  formatConfidence,
  undecidedFights,
  winRatePercent,
} from './battle-metrics';

describe('formatConfidence', () => {
  it('renders the 0..1 grouping confidence as a whole percentage', () => {
    expect(formatConfidence(0.93)).toBe('93%');
    expect(formatConfidence(1)).toBe('100%');
    expect(formatConfidence(0)).toBe('0%');
  });

  it('never rescales values that happen to be small or large', () => {
    expect(formatConfidence(0.009)).toBe('1%');
    expect(formatConfidence(2)).toBe('100%');
    expect(formatConfidence(-1)).toBe('0%');
  });

  it('shows a dash when there is no usable value', () => {
    expect(formatConfidence(null)).toBe('—');
    expect(formatConfidence(undefined)).toBe('—');
    expect(formatConfidence(Number.NaN)).toBe('—');
  });
});

describe('winRatePercent', () => {
  it('is wins / (wins + losses) on a 0..100 scale', () => {
    expect(winRatePercent(3, 1)).toBe(75);
    expect(winRatePercent(0, 2)).toBe(0);
    expect(winRatePercent(2, 0)).toBe(100);
  });

  it('is null when nothing was decided', () => {
    expect(winRatePercent(0, 0)).toBeNull();
  });
});

describe('undecidedFights', () => {
  it('counts draws and unknown outcomes', () => {
    expect(undecidedFights(10, 4, 3)).toBe(3);
    expect(undecidedFights(2, 2, 0)).toBe(0);
    expect(undecidedFights(1, 2, 2)).toBe(0);
  });
});

describe('albionBattlesUrl', () => {
  it('links to the AlbionBB battle page', () => {
    expect(albionBattlesUrl('123456')).toBe('https://albionbattles.com/battles/123456');
    expect(albionBattlesUrl(7)).toBe('https://albionbattles.com/battles/7');
  });
});
