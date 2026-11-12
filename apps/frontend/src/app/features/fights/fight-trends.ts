import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { FightTrendPeriod, FightTrendView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type MetricFormat = 'number' | 'percent' | 'ratio' | 'compact';
type Period = 'current' | 'previous';

interface HeadlineMetric {
  readonly id: string;
  readonly labelKey: TranslationKey;
  readonly value: string;
  readonly hint: string;
  readonly delta: string;
  readonly direction: 'up' | 'down' | 'neutral';
}

interface CoverageItem {
  readonly labelKey: TranslationKey;
  readonly value: string;
}

interface PlannedSelection {
  readonly name: string;
  readonly count: number;
}

/**
 * Rolling 30-day guild fight performance against the preceding 30 days.
 *
 * The headline band always compares the two windows. The breakdown (coverage and planned
 * builds / compositions) follows the segmented period control, so an officer can see the
 * evidence behind either window without a second page.
 */
@Component({
  selector: 'app-fight-trends',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorState, Loading, PageHeader, PageStack, Stat, SummaryBand, Tabs],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    .fight-trends { display: grid; gap: var(--page-gap); }
    .fight-trends__meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1rem; color: var(--color-text-secondary); font-size: var(--ui-text-sm); }
    .fight-trends__updated { font-family: var(--font-mono); font-size: var(--ui-text-xs); color: var(--color-text-tertiary); }
    .fight-trends__note { margin: 0; color: var(--color-text-tertiary); font-size: var(--ui-text-xs); }
    .fight-trends__card { padding: var(--card-padding); min-inline-size: 0; }
    .fight-trends__head,
    .fight-trends__breakdown-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.5rem 1rem; }
    .fight-trends__breakdown-head { align-items: center; }
    .fight-trends__title { margin: 0; color: var(--color-text); font-size: var(--ui-text-md); font-weight: 600; }
    .fight-trends__hint { margin: 0.2rem 0 0; color: var(--color-text-tertiary); font-size: var(--ui-text-xs); line-height: 1.4; }
    .fight-trends__scale { color: var(--color-text-secondary); font-family: var(--font-mono); font-size: var(--ui-text-xs); font-variant-numeric: tabular-nums; }
    .fight-trends__bars-scroll { margin-block-start: 1rem; overflow-x: auto; }
    .fight-trends__bars { display: grid; grid-template-columns: repeat(30, minmax(0.4rem, 1fr)); align-items: end; gap: 0.2rem; block-size: 9rem; padding-block: 0.5rem; border-block-end: 1px solid var(--color-border-strong); }
    .fight-trends__bar { display: block; min-block-size: 2px; border-radius: var(--radius-xs) var(--radius-xs) 0 0; background: var(--color-primary); }
    .fight-trends__axis { display: flex; justify-content: space-between; margin-block-start: 0.45rem; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: var(--ui-text-xs); }
    .fight-trends__data { margin-block-start: 0.875rem; color: var(--color-text-secondary); font-size: var(--ui-text-sm); }
    .fight-trends__data summary { cursor: pointer; }
    .fight-trends__table { margin-block-start: 0.5rem; }
    .fight-trends__breakdown { display: grid; gap: 0.875rem; }
    .fight-trends__details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--page-gap); align-items: start; }
    .fight-trends__list { margin: 0.75rem 0 0; padding: 0; list-style: none; }
    .fight-trends__list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0.75rem; padding-block: 0.5rem; border-block-end: 1px solid var(--color-border); font-size: var(--ui-text-sm); }
    .fight-trends__list li:last-child { border-block-end: 0; }
    .fight-trends__label { overflow: hidden; color: var(--color-text-secondary); text-overflow: ellipsis; white-space: nowrap; }
    .fight-trends__value { color: var(--color-text); font-family: var(--font-mono); font-weight: 600; font-variant-numeric: tabular-nums; }
    .fight-trends__empty { color: var(--color-text-tertiary); font-size: var(--ui-text-sm); }
    @media (max-width: 52rem) { .fight-trends__details { grid-template-columns: 1fr; } }
  `,
  template: `
    <app-page-header [title]="t('fights.trends.title')" [subtitle]="t('fights.trends.subtitle')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="load()">{{ t('common.refresh') }}</button>
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="summary" [label]="t('common.loading')" />
      } @else if (failed()) {
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
      } @else if (trends(); as data) {
        <main class="fight-trends" id="fight-trends-content" tabindex="-1">
          <div class="fight-trends__meta">
            <p class="m-0">{{ windowText() }}</p>
            <p class="fight-trends__updated m-0">{{ updatedText() }}</p>
          </div>

          <app-summary-band [ariaLabel]="t('fights.trends.summaryAria')">
            @for (metric of metrics(); track metric.id) {
              <app-stat
                [label]="t(metric.labelKey)"
                [value]="metric.value"
                [hint]="metric.hint"
                [delta]="metric.delta"
                [deltaDirection]="metric.direction"
              />
            }
          </app-summary-band>
          <p class="fight-trends__note">{{ t('fights.trends.measureNote') }}</p>

          <section class="card fight-trends__card" aria-labelledby="fight-volume-heading">
            <div class="fight-trends__head">
              <div>
                <h2 class="fight-trends__title" id="fight-volume-heading">{{ t('fights.trends.volumeTitle') }}</h2>
                <p class="fight-trends__hint">{{ t('fights.trends.volumeNote') }}</p>
              </div>
              <span class="fight-trends__scale">{{ t('fights.trends.peak', { count: maxDailyFights() }) }}</span>
            </div>
            <div class="fight-trends__bars-scroll">
              <div class="fight-trends__bars" aria-hidden="true">
                @for (day of data.rolling_daily_fight_counts; track day.date) {
                  <span class="fight-trends__bar" [style.height.%]="barHeight(day.fights)"></span>
                }
              </div>
            </div>
            <div class="fight-trends__axis" aria-hidden="true">
              <span>{{ shortDate(data.rolling_daily_fight_counts[0]?.date) }}</span>
              <span>{{ shortDate(data.rolling_daily_fight_counts[data.rolling_daily_fight_counts.length - 1]?.date) }}</span>
            </div>
            <details class="fight-trends__data">
              <summary>{{ t('fights.trends.volumeTable') }}</summary>
              <div class="table-scroll">
                <table class="table fight-trends__table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('fights.trends.colDate') }}</th>
                      <th scope="col" class="num">{{ t('fights.trends.colFights') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (day of data.rolling_daily_fight_counts; track day.date) {
                      <tr>
                        <td>{{ longDate(day.date) }}</td>
                        <td class="num">{{ day.fights }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          @if (selectedPeriod(); as selected) {
            <section class="fight-trends__breakdown" aria-labelledby="fight-breakdown-heading">
              <div class="fight-trends__breakdown-head">
                <h2 class="fight-trends__title" id="fight-breakdown-heading">{{ t('fights.trends.breakdownTitle') }}</h2>
                <app-tabs
                  variant="segmented"
                  [ariaLabel]="t('fights.trends.periodAria')"
                  [options]="periodOptions()"
                  [active]="period()"
                  (activeChange)="selectPeriod($event)"
                />
              </div>

              <div class="fight-trends__details">
                <section class="card fight-trends__card" aria-labelledby="fight-coverage-heading">
                  <h3 class="fight-trends__title" id="fight-coverage-heading">{{ t('fights.trends.coverageTitle') }}</h3>
                  <p class="fight-trends__hint">{{ t('fights.trends.coverageNote') }}</p>
                  <ul class="fight-trends__list">
                    @for (item of coverageDetails(); track item.labelKey) {
                      <li>
                        <span class="fight-trends__label">{{ t(item.labelKey) }}</span>
                        <span class="fight-trends__value">{{ item.value }}</span>
                      </li>
                    }
                  </ul>
                </section>

                <section class="card fight-trends__card" aria-labelledby="fight-builds-heading">
                  <h3 class="fight-trends__title" id="fight-builds-heading">{{ t('fights.trends.buildsTitle') }}</h3>
                  <p class="fight-trends__hint">{{ t('fights.trends.buildsNote') }}</p>
                  <ul class="fight-trends__list">
                    @for (item of plannedBuilds(); track item.name) {
                      <li>
                        <span class="fight-trends__label">{{ item.name }}</span>
                        <span class="fight-trends__value">{{ item.count }}</span>
                      </li>
                    } @empty {
                      <li class="fight-trends__empty">{{ t('fights.trends.noBuilds') }}</li>
                    }
                  </ul>
                </section>

                <section class="card fight-trends__card" aria-labelledby="fight-comps-heading">
                  <h3 class="fight-trends__title" id="fight-comps-heading">{{ t('fights.trends.compsTitle') }}</h3>
                  <p class="fight-trends__hint">
                    {{ t('fights.trends.compsNote', { assignments: selected.planned_participation.planned_participant_assignments, fights: selected.planned_participation.linked_fights }) }}
                  </p>
                  <ul class="fight-trends__list">
                    @for (item of plannedComps(); track item.name) {
                      <li>
                        <span class="fight-trends__label">{{ item.name }}</span>
                        <span class="fight-trends__value">{{ item.count }}</span>
                      </li>
                    } @empty {
                      <li class="fight-trends__empty">{{ t('fights.trends.noComps') }}</li>
                    }
                  </ul>
                </section>
              </div>
            </section>
          }
        </main>
      }
    </app-page-stack>
  `,
})
export class FightTrendsPage {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly trends = signal<FightTrendView | null>(null);
  protected readonly period = signal<Period>('current');

  protected readonly periodOptions = computed<TabOption[]>(() => [
    { id: 'current', label: this.t('fights.trends.periodCurrent') },
    { id: 'previous', label: this.t('fights.trends.periodPrevious') },
  ]);

  protected readonly selectedPeriod = computed<FightTrendPeriod | null>(() => {
    const data = this.trends();
    if (!data) return null;
    return this.period() === 'current' ? data.last_30_days : data.previous_30_days;
  });

  protected readonly windowText = computed(() => {
    const period = this.trends()?.last_30_days;
    if (!period) return '';
    return this.t('fights.trends.window', {
      from: this.dateRange(period.window_started_at),
      to: this.dateRange(period.window_ended_at),
    });
  });

  protected readonly updatedText = computed(() => {
    const data = this.trends();
    if (!data) return '';
    return this.t('fights.trends.updated', { time: this.stamp(data.generated_at) });
  });

  protected readonly maxDailyFights = computed(() =>
    Math.max(1, ...(this.trends()?.rolling_daily_fight_counts.map((day) => day.fights) ?? [0])),
  );

  protected readonly metrics = computed<HeadlineMetric[]>(() => {
    const current = this.trends()?.last_30_days;
    const previous = this.trends()?.previous_30_days;
    if (!current || !previous) return [];
    const definitions: { id: string; labelKey: TranslationKey; format: MetricFormat; current: number | null; previous: number | null }[] = [
      { id: 'fights', labelKey: 'fights.trends.metric.fights', format: 'number', current: current.fight_sample_size, previous: previous.fight_sample_size },
      { id: 'winRate', labelKey: 'fights.trends.metric.winRate', format: 'percent', current: current.win_rate, previous: previous.win_rate },
      { id: 'kd', labelKey: 'fights.trends.metric.kdRatio', format: 'ratio', current: current.kd_ratio, previous: previous.kd_ratio },
      { id: 'kills', labelKey: 'fights.trends.metric.kills', format: 'number', current: current.kills, previous: previous.kills },
      { id: 'deaths', labelKey: 'fights.trends.metric.deaths', format: 'number', current: current.deaths, previous: previous.deaths },
      { id: 'killFame', labelKey: 'fights.trends.metric.killFame', format: 'compact', current: current.kill_fame, previous: previous.kill_fame },
    ];
    return definitions.map((metric) => {
      const delta = this.deltaOf(metric.current, metric.previous, metric.format);
      return {
        id: metric.id,
        labelKey: metric.labelKey,
        value: this.formatMetric(metric.current, metric.format),
        hint: metric.previous === null
          ? this.t('fights.trends.noComparison')
          : this.t('fights.trends.previousValue', { value: this.formatMetric(metric.previous, metric.format) }),
        delta: delta.text,
        direction: delta.direction,
      };
    });
  });

  protected readonly coverageDetails = computed<CoverageItem[]>(() => {
    const period = this.selectedPeriod();
    if (!period) return [];
    const coverage = period.coverage;
    return [
      { labelKey: 'fights.trends.cov.canonical', value: this.formatNumber(period.fight_sample_size) },
      { labelKey: 'fights.trends.cov.snapshots', value: this.formatNumber(coverage.fights_with_snapshots) },
      {
        labelKey: 'fights.trends.cov.segments',
        value: this.t('fights.trends.segmentsValue', {
          persisted: this.formatNumber(coverage.persisted_segments),
          total: this.formatNumber(coverage.total_segments),
        }),
      },
      { labelKey: 'fights.trends.cov.winner', value: this.formatNumber(coverage.fights_with_winner_data) },
      {
        labelKey: 'fights.trends.cov.events',
        value: this.t('fights.trends.eventsValue', {
          events: this.formatNumber(coverage.linked_events),
          fights: this.formatNumber(coverage.linked_event_fights),
        }),
      },
    ];
  });

  protected readonly plannedBuilds = computed<PlannedSelection[]>(() => this.combineBuilds(this.selectedPeriod()));
  protected readonly plannedComps = computed<PlannedSelection[]>(() => this.combineComps(this.selectedPeriod()));

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      this.trends.set(await firstValueFrom(this.api.get<FightTrendView>('api/fights/trends')));
    } catch {
      this.trends.set(null);
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected selectPeriod(id: string): void {
    this.period.set(id === 'previous' ? 'previous' : 'current');
  }

  protected barHeight(fights: number): number { return (fights / this.maxDailyFights()) * 100; }

  protected shortDate(value: string | undefined): string {
    return value ? this.formatDate(value, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  }

  protected longDate(value: string): string {
    return this.formatDate(value, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  private formatMetric(value: number | null, format: MetricFormat): string {
    if (value === null) return '—';
    if (format === 'percent') return `${this.formatNumber(value, 1)}%`;
    if (format === 'ratio') return this.formatNumber(value, 2);
    if (format === 'compact') return this.formatCompact(value);
    return this.formatNumber(value);
  }

  private deltaOf(current: number | null, previous: number | null, format: MetricFormat): { text: string; direction: 'up' | 'down' | 'neutral' } {
    if (current === null || previous === null) return { text: '', direction: 'neutral' };
    const difference = current - previous;
    const direction = difference > 0 ? 'up' : difference < 0 ? 'down' : 'neutral';
    const prefix = difference > 0 ? '+' : '';
    if (format === 'percent') return { text: this.t('fights.trends.pointsDelta', { value: `${prefix}${this.formatNumber(difference, 1)}` }), direction };
    if (format === 'ratio') return { text: `${prefix}${this.formatNumber(difference, 2)}`, direction };
    if (format === 'compact') return { text: `${prefix}${this.formatCompact(difference)}`, direction };
    return { text: `${prefix}${this.formatNumber(difference)}`, direction };
  }

  private combineBuilds(period: FightTrendPeriod | null): PlannedSelection[] {
    if (!period) return [];
    // Primary and secondary build assignments can name the same build; merge by
    // id instead of concatenating so it isn't double-listed.
    const merged = new Map<number, PlannedSelection>();
    for (const selection of [...period.planned_participation.primary_build_assignments, ...period.planned_participation.secondary_build_assignments]) {
      const existing = merged.get(selection.id);
      const name = selection.name ?? this.t('fights.trends.unknownBuild', { id: selection.id });
      merged.set(selection.id, { name, count: (existing?.count ?? 0) + selection.count });
    }
    return [...merged.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private combineComps(period: FightTrendPeriod | null): PlannedSelection[] {
    if (!period) return [];
    return period.planned_participation.comp_assignments
      .map((selection) => ({ name: selection.name ?? this.t('fights.trends.unknownComp', { id: selection.id }), count: selection.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private dateRange(iso: string): string {
    return this.formatDate(iso, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  private stamp(iso: string): string {
    return this.formatDate(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  }

  private formatDate(value: string, options: Intl.DateTimeFormatOptions): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, options).format(date);
  }

  private formatCompact(value: number): string {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  private formatNumber(value: number, maximumFractionDigits = 0): string {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
  }
}
