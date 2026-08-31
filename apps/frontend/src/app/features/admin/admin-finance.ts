import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BankAnalyticsSummary, BankBreakdown, GuildReport, TrendBucket } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface FinanceBar {
  readonly label: string;
  readonly value: number;
  readonly width: number;
  readonly tone: 'primary' | 'success' | 'warning' | 'neutral';
}

interface FinanceTrendPoint {
  readonly label: string;
  readonly x: number;
  readonly lootY: number;
  readonly outflowY: number;
  readonly fightsHeight: number;
  readonly eventsHeight: number;
}

/** Whole-ledger finance workspace for officers with bank reporting access. */
@Component({
  selector: 'app-admin-finance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack],
  styles: `
    .finance-overview, .finance-analytics { display: grid; gap: 0.75rem; }
    .finance-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 8px; overflow: clip; background: var(--color-surface); }
    .finance-metric { min-inline-size: 0; padding: 0.875rem 1rem; border-inline-end: 1px solid var(--color-border); }
    .finance-metric:last-child { border-inline-end: 0; }
    .finance-metric__label, .finance-section-label { margin: 0; color: var(--color-text-tertiary); font-size: 0.6875rem; font-weight: 510; letter-spacing: 0.035em; text-transform: uppercase; }
    .finance-metric__value { margin: 0.5rem 0 0; color: var(--color-text); font-family: var(--font-mono); font-size: 1.25rem; letter-spacing: -0.02em; }
    .finance-metric__detail { margin: 0.25rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-chart-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
    .finance-chart { min-inline-size: 0; padding: 0.875rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .finance-chart--wide { grid-column: span 2; }
    .finance-chart__header { display: flex; align-items: safe center; justify-content: space-between; gap: 0.75rem; margin-block-end: 0.875rem; }
    .finance-chart__title { margin: 0; color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 510; }
    .finance-chart__sub { margin: 0.125rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-bars { display: grid; gap: 0.625rem; margin: 0; padding: 0; list-style: none; }
    .finance-bar { display: grid; grid-template-columns: minmax(5rem, 1fr) 4rem; align-items: safe center; gap: 0.5rem; }
    .finance-bar__label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.6875rem; text-overflow: ellipsis; white-space: nowrap; }
    .finance-bar__amount { color: var(--color-text); font-family: var(--font-mono); font-size: 0.6875rem; text-align: end; }
    .finance-bar__track { grid-column: 1 / -1; block-size: 0.3125rem; overflow: hidden; border-radius: 999px; background: var(--color-surface-2); }
    .finance-bar__fill { display: block; block-size: 100%; min-inline-size: 2px; border-radius: inherit; }
    .finance-bar__fill--primary { background: var(--color-primary); }
    .finance-bar__fill--success { background: var(--color-success); }
    .finance-bar__fill--warning { background: var(--color-warning); }
    .finance-bar__fill--neutral { background: var(--color-text-tertiary); }
    .finance-donut { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); align-items: center; gap: 0.75rem; }
    .finance-donut svg { inline-size: 7.5rem; block-size: 7.5rem; overflow: visible; }
    .finance-donut__ring { fill: none; stroke: var(--color-surface-2); stroke-width: 11; }
    .finance-donut__segment { fill: none; stroke-width: 11; transform: rotate(-90deg); transform-origin: 50% 50%; }
    .finance-donut__segment--primary { stroke: var(--color-primary); }
    .finance-donut__segment--success { stroke: var(--color-success); }
    .finance-donut__segment--warning { stroke: var(--color-warning); }
    .finance-donut__segment--neutral { stroke: var(--color-text-tertiary); }
    .finance-donut__value { fill: var(--color-text); font-family: var(--font-mono); font-size: 0.625rem; font-weight: 510; text-anchor: middle; }
    .finance-legend { display: grid; gap: 0.375rem; margin: 0; padding: 0; list-style: none; }
    .finance-legend__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.375rem; color: var(--color-text-secondary); font-size: 0.6875rem; }
    .finance-legend__dot { inline-size: 0.5rem; block-size: 0.5rem; border-radius: 50%; }
    .finance-legend__dot--primary { background: var(--color-primary); }
    .finance-legend__dot--success { background: var(--color-success); }
    .finance-legend__dot--warning { background: var(--color-warning); }
    .finance-legend__dot--neutral { background: var(--color-text-tertiary); }
    .finance-legend__amount { color: var(--color-text); font-family: var(--font-mono); }
    .finance-svg { display: block; inline-size: 100%; block-size: 11rem; overflow: visible; }
    .finance-svg__grid { stroke: var(--color-border); stroke-width: 0.65; }
    .finance-svg__loot { fill: none; stroke: var(--color-success); stroke-width: 2.25; vector-effect: non-scaling-stroke; }
    .finance-svg__outflow { fill: none; stroke: var(--color-primary); stroke-width: 2.25; vector-effect: non-scaling-stroke; }
    .finance-svg__fight { fill: var(--color-info); }
    .finance-svg__event { fill: var(--color-warning); }
    .finance-svg__label { fill: var(--color-text-tertiary); font-size: 4px; text-anchor: middle; }
    .finance-svg__legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.5rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-svg__legend span { display: inline-flex; align-items: center; gap: 0.3125rem; }
    .finance-svg__key { inline-size: 0.625rem; block-size: 0.125rem; }
    .finance-svg__key--loot { background: var(--color-success); }
    .finance-svg__key--outflow { background: var(--color-primary); }
    .finance-svg__key--fights { background: var(--color-info); }
    .finance-svg__key--events { background: var(--color-warning); }
    .finance-panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
    .finance-panel { min-inline-size: 0; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .finance-panel__header { display: flex; align-items: safe center; justify-content: space-between; gap: 0.5rem; padding: 0.75rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-panel__title { margin: 0; color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 510; }
    .finance-list { margin: 0; padding: 0; list-style: none; }
    .finance-list__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: safe center; gap: 0.75rem; padding: 0.625rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-list__row:last-child { border-block-end: 0; }
    .finance-list__label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
    .finance-list__meta { display: block; margin-block-start: 0.125rem; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-list__amount { color: var(--color-text); font-family: var(--font-mono); font-size: 0.75rem; }
    .finance-note, .finance-empty { margin: 0; padding: 0.75rem 0.875rem; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-tertiary); font-size: 0.75rem; line-height: 1.5; }
    .finance-empty { padding: 1.25rem 0; border: 0; text-align: center; }
    @media (max-width: 72rem) { .finance-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .finance-metric:nth-child(2) { border-inline-end: 0; } .finance-metric:nth-child(-n + 2) { border-block-end: 1px solid var(--color-border); } .finance-chart-grid, .finance-panels { grid-template-columns: repeat(2, minmax(0, 1fr)); } .finance-chart--wide { grid-column: span 2; } }
    @media (max-width: 48rem) { .finance-chart-grid, .finance-panels { grid-template-columns: 1fr; } .finance-chart--wide { grid-column: auto; } }
    @media (max-width: 40rem) { .finance-metrics { grid-template-columns: 1fr; } .finance-metric, .finance-metric:nth-child(2) { border-inline-end: 0; border-block-end: 1px solid var(--color-border); } .finance-metric:last-child { border-block-end: 0; } .finance-donut { grid-template-columns: 1fr; justify-items: center; } .finance-donut__legend { inline-size: 100%; } }
  `,
  template: `
    <app-page-header [title]="t('bank.finance.heading')" [subtitle]="t('bank.finance.description')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="loadFinance()">
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="finance-overview" [attr.aria-label]="t('bank.finance.ariaLabel')">
        @if (summary(); as bank) {
          <div class="finance-metrics">
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.openLiability') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.outstanding_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.creditsOwed', { count: bank.outstanding_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.awaitingApproval') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.requested_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.requestedWithdrawals', { count: bank.requested_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.paidOut') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.paid_out_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.settledPayouts', { count: bank.paid_out_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.donatedBack') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.donated_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.memberDonations', { count: bank.donated_count }) }}</p>
            </div>
          </div>

          <section class="finance-analytics" [attr.aria-label]="t('bank.finance.analytics')">
            <h2 class="finance-section-label">{{ t('bank.finance.analytics') }}</h2>
            <div class="finance-chart-grid">
              <section class="finance-chart" aria-labelledby="finance-liability-chart">
                <header class="finance-chart__header">
                  <div><h3 id="finance-liability-chart" class="finance-chart__title">{{ t('bank.finance.liabilityMix') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.currentLedger') }}</p></div>
                </header>
                @if (liabilityBars().length) {
                  <div class="finance-donut">
                    <svg viewBox="0 0 100 100" role="img" [attr.aria-label]="t('bank.finance.liabilityMix')">
                      <circle class="finance-donut__ring" cx="50" cy="50" r="36" />
                      @for (segment of donutSegments(); track segment.label) {
                        <circle class="finance-donut__segment" [class]="'finance-donut__segment--' + segment.tone" cx="50" cy="50" r="36" [attr.stroke-dasharray]="segment.dasharray" [attr.stroke-dashoffset]="segment.dashoffset" />
                      }
                      <text class="finance-donut__value" x="50" y="52">{{ formatCompact(donutTotal()) }}</text>
                    </svg>
                    <ul class="finance-legend finance-donut__legend" role="list">
                      @for (bar of liabilityBars(); track bar.label) {
                        <li class="finance-legend__row"><span class="finance-legend__dot" [class]="'finance-legend__dot--' + bar.tone"></span><span>{{ bar.label }}</span><span class="finance-legend__amount">{{ formatAmount(bar.value) }}</span></li>
                      }
                    </ul>
                  </div>
                } @else { <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p> }
              </section>

              <section class="finance-chart" aria-labelledby="finance-outflow-chart">
                <header class="finance-chart__header"><div><h3 id="finance-outflow-chart" class="finance-chart__title">{{ t('bank.finance.outflowAllocation') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.lastThirtyDays') }}</p></div></header>
                @if (outflowBars().length) {
                  <ul class="finance-bars" role="list">@for (bar of outflowBars(); track bar.label) { <li class="finance-bar"><span class="finance-bar__label">{{ bar.label }}</span><span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span><span class="finance-bar__track"><span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span></span></li> }</ul>
                } @else { <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p> }
              </section>

              <section class="finance-chart" aria-labelledby="finance-type-chart">
                <header class="finance-chart__header"><div><h3 id="finance-type-chart" class="finance-chart__title">{{ t('bank.finance.ledgerMix') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.byTransactionType') }}</p></div></header>
                <ul class="finance-bars" role="list">@for (bar of transactionTypeBars(); track bar.label) { <li class="finance-bar"><span class="finance-bar__label">{{ bar.label }}</span><span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span><span class="finance-bar__track"><span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span></span></li> }</ul>
              </section>

              <section class="finance-chart finance-chart--wide" aria-labelledby="finance-trend-chart">
                <header class="finance-chart__header"><div><h3 id="finance-trend-chart" class="finance-chart__title">{{ t('bank.finance.weeklyFlow') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.weeklyFlowDescription') }}</p></div></header>
                @if (trendPoints().length) {
                  <figure style="margin: 0">
                    <svg class="finance-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" [attr.aria-label]="t('bank.finance.weeklyFlow')">
                      <path class="finance-svg__grid" d="M 5 18 H 95 M 5 53 H 95 M 5 88 H 95" />
                      <polyline class="finance-svg__loot" [attr.points]="lootTrendPolyline()" />
                      <polyline class="finance-svg__outflow" [attr.points]="outflowTrendPolyline()" />
                      @for (point of trendPoints(); track point.label) { <text class="finance-svg__label" [attr.x]="point.x" y="98">{{ point.label }}</text> }
                    </svg>
                    <figcaption class="finance-svg__legend"><span><i class="finance-svg__key finance-svg__key--loot"></i>{{ t('bank.finance.lootCreated') }}</span><span><i class="finance-svg__key finance-svg__key--outflow"></i>{{ t('bank.finance.memberOutflow') }}</span></figcaption>
                  </figure>
                } @else { <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p> }
              </section>

              <section class="finance-chart" aria-labelledby="finance-source-chart">
                <header class="finance-chart__header"><div><h3 id="finance-source-chart" class="finance-chart__title">{{ t('bank.finance.creditsBySource') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.ledgerVolume') }}</p></div></header>
                <ul class="finance-bars" role="list">@for (bar of sourceBars(); track bar.label) { <li class="finance-bar"><span class="finance-bar__label">{{ bar.label }}</span><span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span><span class="finance-bar__track"><span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span></span></li> }</ul>
              </section>

              <section class="finance-chart" aria-labelledby="finance-destination-chart">
                <header class="finance-chart__header"><div><h3 id="finance-destination-chart" class="finance-chart__title">{{ t('bank.finance.fundDestinations') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.ledgerVolume') }}</p></div></header>
                <ul class="finance-bars" role="list">@for (bar of destinationBars(); track bar.label) { <li class="finance-bar"><span class="finance-bar__label">{{ bar.label }}</span><span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span><span class="finance-bar__track"><span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span></span></li> }</ul>
              </section>

              <section class="finance-chart finance-chart--wide" aria-labelledby="finance-activity-chart">
                <header class="finance-chart__header"><div><h3 id="finance-activity-chart" class="finance-chart__title">{{ t('bank.finance.weeklyActivity') }}</h3><p class="finance-chart__sub">{{ t('bank.finance.weeklyActivityDescription') }}</p></div></header>
                @if (trendPoints().length) {
                  <figure style="margin: 0">
                    <svg class="finance-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" [attr.aria-label]="t('bank.finance.weeklyActivity')">
                      <path class="finance-svg__grid" d="M 5 18 H 95 M 5 53 H 95 M 5 88 H 95" />
                      @for (point of trendPoints(); track point.label) { <rect class="finance-svg__fight" [attr.x]="point.x - 3.5" [attr.y]="88 - point.fightsHeight" width="3" [attr.height]="point.fightsHeight" rx="0.75" /><rect class="finance-svg__event" [attr.x]="point.x + 0.5" [attr.y]="88 - point.eventsHeight" width="3" [attr.height]="point.eventsHeight" rx="0.75" /><text class="finance-svg__label" [attr.x]="point.x" y="98">{{ point.label }}</text> }
                    </svg>
                    <figcaption class="finance-svg__legend"><span><i class="finance-svg__key finance-svg__key--fights"></i>{{ t('bank.finance.fights') }}</span><span><i class="finance-svg__key finance-svg__key--events"></i>{{ t('bank.finance.events') }}</span></figcaption>
                  </figure>
                } @else { <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p> }
              </section>
            </div>
          </section>

          <div class="finance-panels">
            <section class="finance-panel" aria-labelledby="finance-type-heading"><header class="finance-panel__header"><h2 id="finance-type-heading" class="finance-panel__title">{{ t('bank.finance.creditsBySource') }}</h2></header><ul class="finance-list">@for (line of bank.transaction_types; track line.label) { <li class="finance-list__row"><span class="finance-list__label">{{ line.label }}<span class="finance-list__meta">{{ t('bank.finance.ledgerEntries', { count: line.transaction_count }) }}</span></span><span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span></li> }</ul></section>
            <section class="finance-panel" aria-labelledby="finance-destination-heading"><header class="finance-panel__header"><h2 id="finance-destination-heading" class="finance-panel__title">{{ t('bank.finance.fundDestinations') }}</h2></header><ul class="finance-list">@for (line of bank.destinations.slice(0, 6); track line.label) { <li class="finance-list__row"><span class="finance-list__label">{{ line.label }}<span class="finance-list__meta">{{ t('bank.finance.ledgerEntries', { count: line.transaction_count }) }}</span></span><span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span></li> }</ul></section>
            <section class="finance-panel" aria-labelledby="finance-period-heading"><header class="finance-panel__header"><h2 id="finance-period-heading" class="finance-panel__title">{{ t('bank.finance.lastThirtyDays') }}</h2></header>@if (report(); as guildReport) { <ul class="finance-list"><li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.lootCreated') }}</span><span class="finance-list__amount">{{ formatAmount(guildReport.economy.loot_in) }}</span></li><li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.memberOutflow') }}</span><span class="finance-list__amount">{{ formatAmount(guildReport.economy.outflow_total) }}</span></li><li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.regearPaid') }}</span><span class="finance-list__amount">{{ formatAmount(guildReport.economy.regear_paid) }}</span></li><li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.siphonedNet') }}<span class="finance-list__meta">{{ t('bank.finance.siphonedDetail') }}</span></span><span class="finance-list__amount">{{ formatAmount(guildReport.economy.siphoned_net) }}</span></li></ul> } @else { <p class="finance-note">{{ t('bank.finance.reportPermission') }}</p> }</section>
          </div>

          <p class="finance-note">{{ t('bank.finance.ledgerNote') }}</p>
        } @else if (loading()) { <p class="finance-note">{{ t('bank.finance.loading') }}</p> } @else { <p class="finance-note">{{ t('bank.finance.unavailable') }}</p> }
      </section>
    </app-page-stack>
  `,
})
export class AdminFinance {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly summary = signal<BankAnalyticsSummary | null>(null);
  protected readonly report = signal<GuildReport | null>(null);
  protected readonly loading = signal(true);

  protected readonly liabilityBars = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    return this.makeBars([
      { label: this.t('bank.finance.openLiability'), value: summary.outstanding_total, tone: 'warning' },
      { label: this.t('bank.finance.awaitingApproval'), value: summary.requested_total, tone: 'primary' },
      { label: this.t('bank.finance.paidOut'), value: summary.paid_out_total, tone: 'success' },
      { label: this.t('bank.finance.donatedBack'), value: summary.donated_total, tone: 'neutral' },
    ]);
  });
  protected readonly transactionTypeBars = computed(() => this.breakdownBars(this.summary()?.transaction_types));
  protected readonly sourceBars = computed(() => this.breakdownBars(this.summary()?.sources));
  protected readonly destinationBars = computed(() => this.breakdownBars(this.summary()?.destinations));
  protected readonly outflowBars = computed(() => {
    const economy = this.report()?.economy;
    if (!economy) return [];
    return this.makeBars([
      { label: this.t('bank.finance.splitOutflow'), value: economy.outflow_splits, tone: 'primary' },
      { label: this.t('bank.finance.regearPaid'), value: economy.outflow_regear, tone: 'warning' },
      { label: this.t('bank.finance.otherOutflow'), value: economy.outflow_other, tone: 'neutral' },
    ]);
  });
  protected readonly donutTotal = computed(() =>
    this.liabilityBars().reduce((total, bar) => total + Math.abs(bar.value), 0),
  );
  protected readonly donutSegments = computed(() => {
    const total = this.donutTotal() || 1;
    const circumference = 226.2;
    let offset = 0;
    return this.liabilityBars().map((bar) => {
      const length = (Math.abs(bar.value) / total) * circumference;
      const segment = { ...bar, dasharray: `${length} ${circumference - length}`, dashoffset: -offset };
      offset += length;
      return segment;
    });
  });
  protected readonly trendPoints = computed<FinanceTrendPoint[]>(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return [];
    const maxFlow = Math.max(1, ...trends.flatMap((trend) => [Math.abs(trend.loot_in), Math.abs(trend.outflow)]));
    const maxActivity = Math.max(1, ...trends.flatMap((trend) => [trend.fights, trend.events]));
    const span = Math.max(1, trends.length - 1);
    return trends.map((trend, index) => ({
      label: this.formatWeek(trend.week_start),
      x: 6 + (88 * index) / span,
      lootY: 88 - (Math.abs(trend.loot_in) / maxFlow) * 70,
      outflowY: 88 - (Math.abs(trend.outflow) / maxFlow) * 70,
      fightsHeight: Math.max(trend.fights > 0 ? 2 : 0, (trend.fights / maxActivity) * 70),
      eventsHeight: Math.max(trend.events > 0 ? 2 : 0, (trend.events / maxActivity) * 70),
    }));
  });
  protected readonly lootTrendPolyline = computed(() => this.toPolyline(this.trendPoints(), 'lootY'));
  protected readonly outflowTrendPolyline = computed(() => this.toPolyline(this.trendPoints(), 'outflowY'));

  constructor() {
    void this.loadFinance();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) => this.translate.t(key, params);

  protected async loadFinance(): Promise<void> {
    this.loading.set(true);
    const [bankResult, reportResult] = await Promise.allSettled([
      firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary')),
      firstValueFrom(this.api.get<GuildReport>('api/intel/report')),
    ]);
    if (bankResult.status === 'fulfilled') this.summary.set(bankResult.value);
    else { this.summary.set(null); this.toasts.error(this.t('common.error')); }
    this.report.set(reportResult.status === 'fulfilled' ? reportResult.value : null);
    this.loading.set(false);
  }

  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number.isFinite(numeric) ? numeric : 0);
  }

  protected formatCompact(value: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  private breakdownBars(lines: readonly BankBreakdown[] | undefined): FinanceBar[] {
    return this.makeBars((lines ?? []).slice(0, 6).map((line, index) => ({
      label: line.label,
      value: line.total_amount,
      tone: (['primary', 'success', 'warning', 'neutral'] as const)[index % 4],
    })));
  }

  private makeBars(values: ReadonlyArray<{ label: string; value: number | string; tone: FinanceBar['tone'] }>): FinanceBar[] {
    const normalized = values.map((entry) => ({ ...entry, value: Number(entry.value) || 0 }));
    const max = Math.max(1, ...normalized.map((entry) => Math.abs(entry.value)));
    return normalized.map((entry) => ({ ...entry, width: (Math.abs(entry.value) / max) * 100 }));
  }

  private toPolyline(points: readonly FinanceTrendPoint[], y: 'lootY' | 'outflowY'): string {
    return points.map((point) => `${point.x},${point[y]}`).join(' ');
  }

  private formatWeek(value: TrendBucket['week_start']): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }
}
