import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IntelPeriodState } from './intel-period';

describe('IntelPeriodState', () => {
  let navigate: ReturnType<typeof vi.fn>;

  function create(params: Record<string, string> = {}): IntelPeriodState {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        IntelPeriodState,
        { provide: Router, useValue: { navigate } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(params) } },
        },
      ],
    });
    return TestBed.inject(IntelPeriodState);
  }

  beforeEach(() => {
    navigate = vi.fn().mockResolvedValue(true);
  });

  it('defaults to the last 30 days', () => {
    const state = create();
    expect(state.key()).toBe('30d');
    expect(state.query()).toEqual({ period: '30d' });
    expect(state.queryParams()).toEqual({ period: '30d' });
  });

  it('restores a preset from the URL', () => {
    const state = create({ period: '90d' });
    expect(state.query()).toEqual({ period: '90d' });
  });

  it('ignores an unknown period in the URL', () => {
    const state = create({ period: 'forever' });
    expect(state.key()).toBe('30d');
  });

  it('restores a custom range and sends whole-day RFC 3339 bounds', () => {
    const state = create({ from: '2026-01-01', to: '2026-01-31' });
    expect(state.key()).toBe('custom');
    expect(state.query()).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    });
    expect(state.queryParams()).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('rejects a reversed custom range from the URL', () => {
    const state = create({ from: '2026-02-01', to: '2026-01-01' });
    expect(state.key()).toBe('30d');
  });

  it('rejects a reversed or malformed range when applied', () => {
    const state = create();
    expect(state.applyCustom('2026-02-01', '2026-01-01')).toBe(false);
    expect(state.applyCustom('yesterday', '2026-01-01')).toBe(false);
    expect(state.key()).toBe('30d');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('writes a selected preset to the URL and clears the custom range', () => {
    const state = create({ from: '2026-01-01', to: '2026-01-31' });
    state.selectPreset('7d');
    expect(state.query()).toEqual({ period: '7d' });
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { period: '7d', from: null, to: null },
        queryParamsHandling: 'merge',
      }),
    );
  });

  it('applies a valid custom range', () => {
    const state = create();
    expect(state.applyCustom('2026-03-01', '2026-03-31')).toBe(true);
    expect(state.key()).toBe('custom');
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { period: null, from: '2026-03-01', to: '2026-03-31' },
      }),
    );
  });
});
