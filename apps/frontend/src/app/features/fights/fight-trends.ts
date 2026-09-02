import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type { FightTrendPeriod, FightTrendView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface ComparisonMetric {
  readonly label: string;
  readonly current: number | null;
  readonly previous: number | null;
  readonly format: 'number' | 'percent' | 'ratio' | 'compact';
  readonly sample: string;
}

interface PlannedSelection {
  readonly name: string;
  readonly count: number;
}

/**
 * Rolling 30-day guild fight performance, including the evidence available
 * behind combat metrics and event-roster planning data.
 */
@Component({
  selector: 'app-fight-trends',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ErrorState, Loading, PageHeader, PageStack],
  styles: `
    .fight-trends { display: grid; gap: 1rem; }
    .fight-trends__period { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem 1rem; }
    .fight-trends__period-label { margin: 0; color: var(--color-text-secondary); font-size: 0.75rem; }
    .fight-trends__generated { margin: 0; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.6875rem; }
    .fight-trends__panel { min-inline-size: 0; border: 1px solid var(--color-border); border-radius: var(--radius-smallcards); background: var(--color-surface); }
    .fight-trends__panel-header { padding: 0.875rem 1rem; border-block-end: 1px solid var(--color-border); }
    .fight-trends__panel-title { margin: 0; color: var(--color-text); font-size: 0.875rem; font-weight: 600; }
    .fight-trends__panel-note { margin: 0.2rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; line-height: 1.4; }
    /* .fight-trends__metrics now rides on the shared .table class; these are
       just its differences from the default (top-positioned caption, and
       right-aligned value columns with a left-aligned row-label column). */
    .fight-trends__metrics caption { caption-side: top; padding: 0.75rem 1rem 0; color: var(--color-text-secondary); font-size: 0.6875rem; text-align: start; }
    .fight-trends__metrics th, .fight-trends__metrics td { text-align: end; }
    .fight-trends__metrics th[scope='row'] { text-align: start; }
    .fight-trends__value { color: var(--color-text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .fight-trends__sample { display: block; margin-block-start: 0.125rem; color: var(--color-text-tertiary); font-family: var(--font-sans); font-size: 0.625rem; font-weight: 400; white-space: normal; }
    .fight-trends__delta { color: var(--color-text-secondary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .fight-trends__chart { padding: 1rem; }
    .fight-trends__chart-caption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 1rem; margin-block-end: 1rem; }
    .fight-trends__chart-title { margin: 0; color: var(--color-text); font-size: 0.875rem; font-weight: 600; }
    .fight-trends__chart-note { margin: 0.2rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .fight-trends__scale { color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.6875rem; }
    .fight-trends__bars { display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); align-items: end; gap: 0.2rem; block-size: 9rem; padding-block: 0.5rem; border-block-end: 1px solid var(--color-border-strong); }
    .fight-trends__bar { display: block; min-block-size: 2px; border-radius: 2px 2px 0 0; background: var(--color-primary); opacity: 0.78; }
    .fight-trends__axis { display: flex; justify-content: space-between; margin-block-start: 0.45rem; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.625rem; }
    .fight-trends__data { margin-block-start: 0.875rem; color: var(--color-text-secondary); font-size: 0.75rem; }
    .fight-trends__data-summary { cursor: pointer; color: var(--color-text-secondary); }
    .fight-trends__daily-table { margin-block-start: 0.625rem; font-size: 0.6875rem; }
    .fight-trends__daily-table th, .fight-trends__daily-table td { text-align: end; }
    .fight-trends__daily-table th:first-child, .fight-trends__daily-table td:first-child { text-align: start; }
    .fight-trends__details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.875rem; }
    .fight-trends__detail-list { margin: 0; padding: 0; list-style: none; }
    .fight-trends__detail-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0.75rem; padding: 0.625rem 1rem; border-block-end: 1px solid var(--color-border); }
    .fight-trends__detail-list li:last-child { border-block-end: 0; }
    .fight-trends__detail-label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
    .fight-trends__detail-value { color: var(--color-text); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .fight-trends__empty { margin: 0; padding: 1rem; color: var(--color-text-tertiary); font-size: 0.75rem; }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
    @media (max-width: 52rem) { .fight-trends__details { grid-template-columns: 1fr; } }
    @media (max-width: 40rem) { .fight-trends__metrics th, .fight-trends__metrics td { padding-inline: 0.625rem; } .fight-trends__metrics th:nth-child(3), .fight-trends__metrics td:nth-child(3) { display: none; } }
  `,
  template: `
    <app-page-header title="Fight trends" subtitle="Rolling 30-day performance with transparent evidence coverage.">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="load()">Refresh</button>
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading label="Loading fight trends" />
      } @else if (errorMessage()) {
        <app-error-state [message]="errorMessage()!" retryLabel="Try again" (retry)="load()" />
      } @else if (trends(); as data) {
        <main class="fight-trends" id="fight-trends-content" tabindex="-1">
          <div class="fight-trends__period">
            <p class="fight-trends__period-label">Comparing {{ data.last_30_days.window_started_at | date: 'MMM d' }}–{{ data.last_30_days.window_ended_at | date: 'MMM d, y' }} with the preceding 30 days.</p>
            <p class="fight-trends__generated">Updated {{ data.generated_at | date: 'MMM d, HH:mm' }} UTC</p>
          </div>

          <section class="fight-trends__panel" aria-labelledby="fight-performance-heading">
            <header class="fight-trends__panel-header">
              <h2 class="fight-trends__panel-title" id="fight-performance-heading">Performance comparison</h2>
              <p class="fight-trends__panel-note">Combat totals use persisted snapshots. Win rate uses fights with a friendly winner record.</p>
            </header>
            <table class="table fight-trends__metrics">
              <caption>Current 30 days compared with the previous 30 days</caption>
              <thead><tr><th scope="col">Metric</th><th scope="col">Current</th><th scope="col">Previous</th><th scope="col">Change</th></tr></thead>
              <tbody>
                @for (metric of metrics(); track metric.label) {
                  <tr>
                    <th scope="row">{{ metric.label }}<span class="fight-trends__sample">{{ metric.sample }}</span></th>
                    <td class="fight-trends__value">{{ formatMetric(metric.current, metric.format) }}</td>
                    <td class="fight-trends__value">{{ formatMetric(metric.previous, metric.format) }}</td>
                    <td class="fight-trends__delta">{{ formatDelta(metric.current, metric.previous, metric.format) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <section class="fight-trends__panel" aria-labelledby="fight-volume-heading">
            <div class="fight-trends__chart">
              <div class="fight-trends__chart-caption">
                <div><h2 class="fight-trends__chart-title" id="fight-volume-heading">Daily fight volume</h2><p class="fight-trends__chart-note">Canonical fights beginning each UTC day, including quiet days.</p></div>
                <span class="fight-trends__scale">Peak: {{ maxDailyFights() }} fights/day</span>
              </div>
              <div class="fight-trends__bars" aria-hidden="true">
                @for (day of data.rolling_daily_fight_counts; track day.date) { <span class="fight-trends__bar" [style.height.%]="barHeight(day.fights)"></span> }
              </div>
              <div class="fight-trends__axis" aria-hidden="true"><span>{{ data.rolling_daily_fight_counts[0]?.date | date: 'MMM d' }}</span><span>{{ data.rolling_daily_fight_counts[data.rolling_daily_fight_counts.length - 1]?.date | date: 'MMM d' }}</span></div>
              <details class="fight-trends__data"><summary class="fight-trends__data-summary">View daily fight counts as a table</summary><table class="table fight-trends__daily-table"><thead><tr><th scope="col">UTC date</th><th scope="col">Fights</th></tr></thead><tbody>@for (day of data.rolling_daily_fight_counts; track day.date) { <tr><td>{{ day.date | date: 'MMM d, y' }}</td><td>{{ day.fights }}</td></tr> }</tbody></table></details>
            </div>
          </section>

          <section class="fight-trends__details" aria-label="Coverage and planned selections">
            <article class="fight-trends__panel"><header class="fight-trends__panel-header"><h2 class="fight-trends__panel-title">Current data coverage</h2><p class="fight-trends__panel-note">The sample behind the current-window metrics.</p></header><ul class="fight-trends__detail-list" role="list">@for (item of coverageDetails(); track item.label) { <li><span class="fight-trends__detail-label">{{ item.label }}</span><span class="fight-trends__detail-value">{{ item.value }}</span></li> }</ul></article>
            <article class="fight-trends__panel"><header class="fight-trends__panel-header"><h2 class="fight-trends__panel-title">Planned builds</h2><p class="fight-trends__panel-note">Primary and secondary selections across linked fights.</p></header><ul class="fight-trends__detail-list" role="list">@for (item of plannedBuilds(); track item.name) { <li><span class="fight-trends__detail-label">{{ item.name }}</span><span class="fight-trends__detail-value">{{ item.count }}</span></li> } @empty { <li class="fight-trends__empty">No planned build assignments in this window.</li> }</ul></article>
            <article class="fight-trends__panel"><header class="fight-trends__panel-header"><h2 class="fight-trends__panel-title">Planned compositions</h2><p class="fight-trends__panel-note">{{ data.last_30_days.planned_participation.planned_participant_assignments }} participant assignments across {{ data.last_30_days.planned_participation.linked_fights }} linked fights.</p></header><ul class="fight-trends__detail-list" role="list">@for (item of plannedComps(); track item.name) { <li><span class="fight-trends__detail-label">{{ item.name }}</span><span class="fight-trends__detail-value">{{ item.count }}</span></li> } @empty { <li class="fight-trends__empty">No planned composition assignments in this window.</li> }</ul></article>
          </section>
        </main>
      }
    </app-page-stack>
  `,
})
export class FightTrendsPage {
  private readonly api = inject(ApiService);

  protected readonly loading = signal(true);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly trends = signal<FightTrendView | null>(null);

  protected readonly maxDailyFights = computed(() => Math.max(1, ...this.trends()?.rolling_daily_fight_counts.map((day) => day.fights) ?? [0]));
  protected readonly metrics = computed<ComparisonMetric[]>(() => {
    const current = this.trends()?.last_30_days;
    const previous = this.trends()?.previous_30_days;
    if (!current || !previous) return [];
    return [
      { label: 'Fights', current: current.fight_sample_size, previous: previous.fight_sample_size, format: 'number', sample: `${current.fight_sample_size} canonical fights` },
      { label: 'Win rate', current: current.win_rate, previous: previous.win_rate, format: 'percent', sample: `${current.win_sample_size} fights with winner data` },
      { label: 'K/D ratio', current: current.kd_ratio, previous: previous.kd_ratio, format: 'ratio', sample: `${current.combat_sample_size} fights with snapshots` },
      { label: 'Kills', current: current.kills, previous: previous.kills, format: 'number', sample: `${current.combat_sample_size} combat sample` },
      { label: 'Deaths', current: current.deaths, previous: previous.deaths, format: 'number', sample: `${current.combat_sample_size} combat sample` },
      { label: 'Kill fame', current: current.kill_fame, previous: previous.kill_fame, format: 'compact', sample: `${current.combat_sample_size} combat sample` },
    ];
  });
  protected readonly coverageDetails = computed(() => {
    const period = this.trends()?.last_30_days;
    if (!period) return [];
    return [
      { label: 'Canonical fights', value: this.formatNumber(period.fight_sample_size) },
      { label: 'Fights with snapshots', value: this.formatNumber(period.coverage.fights_with_snapshots) },
      { label: 'Persisted segments', value: `${this.formatNumber(period.coverage.persisted_segments)} / ${this.formatNumber(period.coverage.total_segments)}` },
      { label: 'Fights with winner data', value: this.formatNumber(period.coverage.fights_with_winner_data) },
      { label: 'Linked events', value: `${this.formatNumber(period.coverage.linked_events)} (${this.formatNumber(period.coverage.linked_event_fights)} fights)` },
    ];
  });
  protected readonly plannedBuilds = computed<PlannedSelection[]>(() => this.combineSelections(this.trends()?.last_30_days, 'build'));
  protected readonly plannedComps = computed<PlannedSelection[]>(() => this.combineSelections(this.trends()?.last_30_days, 'comp'));

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      this.trends.set(await firstValueFrom(this.api.get<FightTrendView>('api/fights/trends')));
    } catch (error: unknown) {
      this.trends.set(null);
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load fight trends.');
    } finally {
      this.loading.set(false);
    }
  }

  protected barHeight(fights: number): number { return (fights / this.maxDailyFights()) * 100; }
  protected formatMetric(value: number | null, format: ComparisonMetric['format']): string {
    if (value === null) return '—';
    if (format === 'percent') return `${this.formatNumber(value, 1)}%`;
    if (format === 'ratio') return this.formatNumber(value, 2);
    if (format === 'compact') return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    return this.formatNumber(value);
  }
  protected formatDelta(current: number | null, previous: number | null, format: ComparisonMetric['format']): string {
    if (current === null || previous === null) return 'No comparison';
    const difference = current - previous;
    const prefix = difference > 0 ? '+' : '';
    if (format === 'percent') return `${prefix}${this.formatNumber(difference, 1)} pp`;
    if (format === 'ratio') return `${prefix}${this.formatNumber(difference, 2)}`;
    if (format === 'compact') return `${prefix}${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(difference)}`;
    return `${prefix}${this.formatNumber(difference)}`;
  }

  private combineSelections(period: FightTrendPeriod | undefined, type: 'build' | 'comp'): PlannedSelection[] {
    if (!period) return [];
    const selections = type === 'comp'
      ? period.planned_participation.comp_assignments
      : [...period.planned_participation.primary_build_assignments, ...period.planned_participation.secondary_build_assignments];
    return selections.map((selection) => ({ name: selection.name ?? `Unknown ${type} #${selection.id}`, count: selection.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  private formatNumber(value: number, maximumFractionDigits = 0): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value); }
}
