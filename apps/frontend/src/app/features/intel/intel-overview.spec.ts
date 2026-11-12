import { Component, provideZonelessChangeDetection, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntelOverview, IntelTotals } from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { Chart } from '../../shared/components/chart/chart';
import { IntelOverviewPage } from './intel-overview';
import { IntelPeriodState } from './intel-period';

/** The real chart pulls in ECharts; the page only needs to hand it an option. */
@Component({ selector: 'app-chart', template: '' })
class ChartStub {
  readonly option = input<unknown>();
  readonly height = input<string>();
  readonly stale = input<boolean>();
  readonly label = input<string>();
  readonly tableHead = input<readonly string[]>();
  readonly tableRows = input<readonly unknown[]>();
}

function totals(over: Partial<IntelTotals> = {}): IntelTotals {
  return {
    fights: 10,
    wins: 6,
    losses: 4,
    draws: 0,
    unknown: 0,
    decided: 10,
    win_rate: 60,
    fights_with_stats: 10,
    kills: 50,
    deaths: 40,
    kd_ratio: 1.25,
    kill_fame: 1_000_000,
    death_fame: 800_000,
    avg_players: 20,
    avg_item_power: 1400,
    enemy_avg_item_power: 1380,
    estimated_silver_lost: null,
    ...over,
  };
}

function overview(over: Partial<IntelOverview> = {}): IntelOverview {
  return {
    period: { key: '30d', from: '2026-10-13T00:00:00Z', to: '2026-11-12T00:00:00Z' },
    current: totals(),
    previous: totals({ win_rate: 40, wins: 4, losses: 6 }),
    weekly: [
      {
        week_start: '2026-11-02T00:00:00Z',
        fights: 4,
        wins: 3,
        losses: 1,
        draws: 0,
        win_rate: 75,
        kills: 20,
        deaths: 10,
        kill_fame: 400_000,
        avg_players: 20,
      },
    ],
    recent_fights: [
      {
        fight_id: 9,
        started_at: '2026-11-10T19:00:00Z',
        event_id: 3,
        event_title: 'ZvZ night',
        comp_id: 2,
        comp_name: 'Frontline',
        outcome: 'victory',
        opponent: 'Nemesis',
        segments: 1,
        our_players: 22,
        enemy_players: 30,
        kills: 12,
        deaths: 5,
        kd_ratio: 2.4,
        kill_fame: 300_000,
        death_fame: 100_000,
        avg_item_power: 1410,
        enemy_avg_item_power: 1390,
        estimated_silver_lost: null,
      },
    ],
    top_opponents: [{ opponent: 'Nemesis', fights: 4, wins: 3, losses: 1, draws: 0, win_rate: 75 }],
    data_quality: { fights_without_stats: 0, fights_unknown_outcome: 0, fights_without_comp: 0 },
    ...over,
  };
}

async function settle(fixture: ComponentFixture<IntelOverviewPage>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
  fixture.detectChanges();
}

describe('IntelOverviewPage', () => {
  let fixture: ComponentFixture<IntelOverviewPage>;
  let overviewCall: ReturnType<typeof vi.fn>;

  async function mount(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [IntelOverviewPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        IntelPeriodState,
        { provide: IntelService, useValue: { overview: overviewCall } },
      ],
    })
      .overrideComponent(IntelOverviewPage, {
        remove: { imports: [Chart] },
        add: { imports: [ChartStub] },
      })
      .compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(IntelOverviewPage);
  }

  beforeEach(() => {
    overviewCall = vi.fn().mockReturnValue(of(overview()));
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows a loading state before the overview resolves', async () => {
    overviewCall.mockReturnValue(NEVER);
    await mount();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading…');
  });

  it('requests the default 30-day period', async () => {
    await mount();
    await settle(fixture);
    expect(overviewCall).toHaveBeenCalledWith({ period: '30d' });
  });

  it('renders the headline figures, recent fights and opponents', async () => {
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Win rate');
    expect(text).toContain('60%');
    expect(text).toContain('1.25');
    expect(text).toContain('Nemesis');
    expect(text).toContain('Frontline');
    expect(text).toContain('Victory');
  });

  it('lists what moved against the previous period', async () => {
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('What changed');
    expect(text).toContain('40% → 60%');
    expect(text).toContain('+20 pts');
  });

  it('says there is nothing to compare with when the previous period is missing', async () => {
    overviewCall.mockReturnValue(of(overview({ previous: null })));
    await mount();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('There is no earlier period to compare with.');
  });

  it('shows an empty state, not 0%, when there are no fights', async () => {
    overviewCall.mockReturnValue(
      of(overview({ current: totals({ fights: 0, wins: 0, losses: 0, decided: 0, win_rate: null }), previous: null })),
    );
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No fights in this period');
    expect(text).not.toContain('0%');
  });

  it('shows no win rate figure when nothing was decided', async () => {
    overviewCall.mockReturnValue(
      of(overview({ current: totals({ decided: 0, wins: 0, losses: 0, unknown: 10, win_rate: null }), previous: null })),
    );
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('None decided');
    expect(text).not.toMatch(/\b0%/);
  });

  it('shows the silver lost KPI only when the backend sends it', async () => {
    await mount();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('Silver lost');
    fixture.destroy();

    TestBed.resetTestingModule();
    overviewCall.mockReturnValue(of(overview({ current: totals({ estimated_silver_lost: 2_500_000 }) })));
    await mount();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Silver lost');
  });

  it('reports data coverage gaps', async () => {
    overviewCall.mockReturnValue(
      of(overview({ data_quality: { fights_without_stats: 2, fights_unknown_outcome: 1, fights_without_comp: 0 } })),
    );
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('2 fights have no computed combat stats.');
    expect(text).toContain('1 fights have no recorded outcome');
  });

  it('shows an error state and retries', async () => {
    overviewCall.mockReturnValueOnce(throwError(() => new Error('offline')));
    await mount();
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong.');

    const page = fixture.componentInstance as unknown as { reload: () => void };
    page.reload();
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Nemesis');
  });
});
