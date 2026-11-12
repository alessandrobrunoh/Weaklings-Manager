import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { FightTrendPeriod, FightTrendView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import { FightTrendsPage } from './fight-trends';

function period(overrides: Partial<FightTrendPeriod>, buildName: string): FightTrendPeriod {
  return {
    window_started_at: '2026-10-13T00:00:00Z',
    window_ended_at: '2026-11-12T00:00:00Z',
    fight_sample_size: 12,
    combat_sample_size: 10,
    win_sample_size: 9,
    wins: 6,
    losses: 3,
    win_rate: 66.7,
    kills: 40,
    deaths: 25,
    kd_ratio: 1.6,
    kill_fame: 2500000,
    coverage: {
      fights_with_snapshots: 10,
      persisted_segments: 18,
      total_segments: 20,
      fights_with_winner_data: 9,
      linked_event_fights: 4,
      linked_events: 2,
    },
    planned_participation: {
      linked_fights: 4,
      linked_events: 2,
      planned_participant_assignments: 30,
      primary_build_assignments: [{ id: 7, name: buildName, count: 5 }],
      secondary_build_assignments: [{ id: 7, name: buildName, count: 2 }, { id: 8, name: null, count: 1 }],
      comp_assignments: [{ id: 3, name: 'Tank core', count: 6 }],
    },
    ...overrides,
  };
}

function trends(): FightTrendView {
  return {
    generated_at: '2026-11-12T10:30:00Z',
    last_30_days: period({}, 'Hammer'),
    previous_30_days: period({ fight_sample_size: 8, win_rate: null, kd_ratio: 0.9, kills: 20, deaths: 22 }, 'Bow'),
    rolling_daily_fight_counts: Array.from({ length: 30 }, (_, index) => ({
      date: `2026-10-${String(13 + index).padStart(2, '0')}`,
      fights: index % 4,
    })),
  };
}

async function render(api: { get: ReturnType<typeof vi.fn> }) {
  await TestBed.configureTestingModule({
    imports: [FightTrendsPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: api },
      TranslateService,
    ],
  }).compileComponents();
  const translations = TestBed.inject(TranslateService);
  translations.use('en');
  const fixture = TestBed.createComponent(FightTrendsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, translations };
}

describe('FightTrendsPage', () => {
  it('shows the headline band with six figures and a period switch', async () => {
    const api = { get: vi.fn().mockReturnValue(of(trends())) };
    const { fixture, translations } = await render(api);
    try {
      const stats = fixture.nativeElement.querySelectorAll('app-stat');
      expect(stats.length).toBe(6);
      expect(fixture.nativeElement.querySelector('app-summary-band [role="group"]')).toBeTruthy();
      expect(fixture.nativeElement.textContent).toContain(translations.t('fights.trends.metric.winRate'));

      const tabs = [...fixture.nativeElement.querySelectorAll('[role="tab"]')] as HTMLElement[];
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
        translations.t('fights.trends.periodCurrent'),
        translations.t('fights.trends.periodPrevious'),
      ]);
    } finally {
      fixture.destroy();
    }
  });

  it('switches the breakdown between the current and previous windows', async () => {
    const api = { get: vi.fn().mockReturnValue(of(trends())) };
    const { fixture, translations } = await render(api);
    try {
      expect(fixture.nativeElement.textContent).toContain('Hammer');
      expect(fixture.nativeElement.textContent).not.toContain('Bow');

      const previous = [...fixture.nativeElement.querySelectorAll('[role="tab"]')]
        .find((tab) => (tab as HTMLElement).textContent?.includes(translations.t('fights.trends.periodPrevious'))) as HTMLButtonElement;
      previous.click();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Bow');
      expect(fixture.nativeElement.textContent).not.toContain('Hammer');
    } finally {
      fixture.destroy();
    }
  });

  it('shows a translated error instead of raw API text when loading fails', async () => {
    const api = { get: vi.fn().mockReturnValue(throwError(() => new Error('db connection refused'))) };
    const { fixture, translations } = await render(api);
    try {
      expect(fixture.nativeElement.textContent).toContain(translations.t('common.error'));
      expect(fixture.nativeElement.textContent).not.toContain('db connection refused');
      expect(fixture.nativeElement.querySelector('app-stat')).toBeNull();
    } finally {
      fixture.destroy();
    }
  });
});
