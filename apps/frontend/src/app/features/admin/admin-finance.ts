import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import type {
  BankAnalyticsSummary,
  BankBreakdown,
  GuildReport,
  ReportMemberRow,
  TrendBucket,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Chart, type ChartTableRow } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/** Preset windows, plus the escape hatch to arbitrary dates. */
type PeriodId = '7' | '30' | '90' | 'custom';

const PRESET_DAYS: Readonly<Record<Exclude<PeriodId, 'custom'>, number>> = {
  '7': 7,
  '30': 30,
  '90': 90,
};

const MS_PER_DAY = 86_400_000;

/** A resolved reporting window, plus the comparable window right before it. */
interface ResolvedRange {
  readonly from: Date;
  readonly to: Date;
  readonly days: number;
  readonly previousFrom: Date;
  readonly previousTo: Date;
}

/** One KPI tile: a figure, its context, and where to go to verify it. */
interface FinanceKpi {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: 'default' | 'success' | 'warning' | 'danger';
  readonly delta?: FinanceDelta;
  readonly link?: readonly [string, Record<string, string>];
  readonly hint?: string;
}

/** Period-over-period movement, already resolved to a direction and a label. */
interface FinanceDelta {
  readonly label: string;
  readonly direction: 'up' | 'down' | 'flat';
  /** Whether the movement is a good thing, which is not the same as "up". */
  readonly good: boolean;
}

/** Minimal shape of an ECharts tooltip callback payload. */
interface TooltipParam {
  readonly seriesName?: string;
  readonly name?: string;
  readonly axisValueLabel?: string;
  readonly value?: unknown;
  readonly color?: string;
}

function toParamList(input: unknown): TooltipParam[] {
  return Array.isArray(input) ? (input as TooltipParam[]) : [input as TooltipParam];
}

/** Series and category names come from the API — never interpolate them raw. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toNumber(value: number | string | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * Finance workspace for officers with bank reporting access.
 *
 * Two data sources meet on this page and they answer different questions, so
 * every block says which one it is reading:
 *
 * - `GET /api/bank/admin/summary` is the **whole ledger**, every row ever
 *   written, and ignores the period filter. It answers "what does the bank owe
 *   and what has it settled".
 * - `GET /api/intel/report?from&to` is **window-scoped** silver flow. It
 *   answers "what happened in this period", and is fetched twice — once for
 *   the selected window and once for the window immediately before it, which
 *   is what makes the period-over-period deltas possible.
 *
 * Mixing the two silently is how a finance page starts lying, hence the
 * explicit scope chips on each section heading.
 */
@Component({
  selector: 'app-admin-finance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    Icon,
    NgTemplateOutlet,
    PageHeader,
    PageStack,
    RouterLink,
    TooltipDirective,
    ViewToggle,
  ],
  styles: `
    .fin-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-filters__group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .fin-filters__window,
    .fin-meta {
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
    }
    .fin-filters__window strong,
    .fin-meta strong {
      color: var(--color-text-secondary);
      font-weight: 600;
    }
    .fin-date {
      inline-size: 9.5rem;
    }

    .fin-section {
      display: grid;
      gap: 0.75rem;
    }
    .fin-section__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem 0.75rem;
    }
    .fin-section__title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      color: var(--color-text);
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .fin-section__sub {
      margin: 0.125rem 0 0;
      max-inline-size: 62ch;
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
      line-height: 1.45;
    }
    .fin-scope {
      flex: 0 0 auto;
      padding: 0.0625rem 0.375rem;
      border: 1px solid var(--color-border);
      border-radius: 999px;
      color: var(--color-text-tertiary);
      font-size: 0.625rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .fin-kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1rem;
    }
    .fin-kpi {
      display: flex;
      min-inline-size: 0;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.75rem 0.875rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
      color: inherit;
      text-decoration: none;
      transition:
        border-color 0.15s ease,
        background-color 0.15s ease;
    }
    a.fin-kpi:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    a.fin-kpi:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .fin-kpi__top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .fin-kpi__label {
      margin: 0;
      overflow: hidden;
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.035em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .fin-kpi__value {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 1.375rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      line-height: 1.15;
    }
    .fin-kpi__value--success {
      color: var(--color-success);
    }
    .fin-kpi__value--warning {
      color: var(--color-warning);
    }
    .fin-kpi__value--danger {
      color: var(--color-error);
    }
    .fin-kpi__detail {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: 0.6875rem;
      line-height: 1.35;
    }
    .fin-kpi__delta {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 0.1875rem;
      padding: 0.0625rem 0.3125rem;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.625rem;
      font-weight: 700;
    }
    .fin-kpi__delta--good {
      background: var(--color-success-container);
      color: var(--color-success);
    }
    .fin-kpi__delta--bad {
      background: var(--color-error-container);
      color: var(--color-error);
    }
    .fin-kpi__delta--flat {
      background: var(--color-surface-2);
      color: var(--color-text-tertiary);
    }
    .fin-kpi__cta {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-block-start: 0.125rem;
      color: var(--color-text-tertiary);
      font-size: 0.625rem;
      font-weight: 500;
    }

    .fin-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .fin-grid--thirds {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .fin-card {
      display: flex;
      min-inline-size: 0;
      flex-direction: column;
      padding: 0.875rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-card--full {
      grid-column: 1 / -1;
    }
    .fin-card__head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
      margin-block-end: 0.625rem;
    }
    .fin-card__title {
      margin: 0;
      color: var(--color-text);
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .fin-card__sub {
      margin: 0.125rem 0 0;
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
      line-height: 1.4;
    }
    .fin-card__badge {
      flex: 0 0 auto;
      padding: 0.125rem 0.375rem;
      border-radius: 4px;
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      font-weight: 600;
    }

    .fin-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--color-border);
      border-radius: 8px;
    }
    .fin-table {
      inline-size: 100%;
      min-inline-size: 42rem;
      border-collapse: collapse;
      font-size: 0.75rem;
    }
    .fin-table th,
    .fin-table td {
      padding: 0.5rem 0.75rem;
      border-block-end: 1px solid var(--color-border);
      text-align: end;
      white-space: nowrap;
    }
    .fin-table th:first-child,
    .fin-table td:first-child {
      text-align: start;
    }
    .fin-table thead th {
      position: sticky;
      inset-block-start: 0;
      background: var(--color-surface-2);
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .fin-table tbody td {
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .fin-table tbody th {
      color: var(--color-text);
      font-weight: 500;
    }
    .fin-table tbody tr:last-child td,
    .fin-table tbody tr:last-child th {
      border-block-end: 0;
    }
    .fin-table tbody tr:hover {
      background: var(--color-surface-hover);
    }
    .fin-table a {
      color: var(--color-primary);
      text-decoration: none;
    }
    .fin-table a:hover {
      text-decoration: underline;
    }

    .fin-note {
      margin: 0;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      color: var(--color-text-tertiary);
      font-size: 0.6875rem;
      line-height: 1.5;
    }
    .fin-empty {
      margin: 0;
      padding: 1.75rem 0;
      color: var(--color-text-tertiary);
      font-size: 0.75rem;
      text-align: center;
    }
    .fin-stale {
      opacity: 0.55;
      transition: opacity 0.15s ease;
    }

    @media (max-width: 72rem) {
      .fin-kpis {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .fin-grid,
      .fin-grid--thirds {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 40rem) {
      .fin-kpis {
        grid-template-columns: 1fr;
      }
    }
  `,
  template: `
    <app-page-header [title]="t('bank.finance.heading')" [subtitle]="t('bank.finance.description')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="busy()"
        (click)="loadFinance()"
      >
        <app-icon name="refresh" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="!summary()"
        (click)="exportCsv()"
      >
        <app-icon name="list" size="0.875rem" />
        {{ t('bank.finance.exportCsv') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- One filter row, above everything it scopes. -->
      <div class="fin-filters">
        <div class="fin-filters__group">
          <span class="eyebrow">{{ t('bank.finance.periodLabel') }}</span>
          <app-view-toggle
            [options]="periodOptions()"
            [active]="period()"
            (activeChange)="onPeriodChange($event)"
          />
          @if (period() === 'custom') {
            <label class="sr-only" for="fin-from">{{ t('bank.finance.from') }}</label>
            <input
              id="fin-from"
              class="input input--sm fin-date"
              type="date"
              [value]="customFrom()"
              [max]="customTo()"
              (change)="onCustomFrom($event)"
            />
            <span aria-hidden="true" style="color: var(--color-text-tertiary)">→</span>
            <label class="sr-only" for="fin-to">{{ t('bank.finance.to') }}</label>
            <input
              id="fin-to"
              class="input input--sm fin-date"
              type="date"
              [value]="customTo()"
              [min]="customFrom()"
              [max]="today()"
              (change)="onCustomTo($event)"
            />
          }
        </div>
        <p class="fin-filters__window" aria-live="polite">
          @if (busy()) {
            {{ t('bank.finance.reloading') }}
          } @else if (report(); as r) {
            <strong>{{ formatDate(r.from) }} → {{ formatDate(r.to) }}</strong>
            · {{ t('bank.finance.weeksTracked', { count: r.trends.length }) }}
          }
        </p>
      </div>

      @if (summary(); as bank) {
        <!-- ============ 1. Bank position — whole ledger, period-independent ============ -->
        <section class="fin-section" [attr.aria-label]="t('bank.finance.positionTitle')">
          <header class="fin-section__head">
            <div>
              <h2 class="fin-section__title">
                <app-icon name="bank" size="0.9375rem" />
                {{ t('bank.finance.positionTitle') }}
                <span class="fin-scope">{{ t('bank.finance.scopeAllTime') }}</span>
              </h2>
              <p class="fin-section__sub">{{ t('bank.finance.positionDescription') }}</p>
            </div>
            <p class="fin-meta">
              {{ t('bank.finance.ledgerVolume') }}
              <strong class="mono">{{ formatAmount(bank.ledger_volume) }}</strong>
              · {{ t('bank.finance.ledgerEntries', { count: bank.transaction_count }) }}
            </p>
          </header>

          <div class="fin-kpis">
            @for (kpi of positionKpis(); track kpi.key) {
              @if (kpi.link; as link) {
                <a class="fin-kpi" [routerLink]="link[0]" [queryParams]="link[1]">
                  <ng-container
                    *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: true }"
                  />
                </a>
              } @else {
                <div class="fin-kpi">
                  <ng-container
                    *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: false }"
                  />
                </div>
              }
            }
          </div>
        </section>

        @if (report(); as guildReport) {
          <!-- ============ 2. Silver flow in the selected window ============ -->
          <section class="fin-section" [attr.aria-label]="t('bank.finance.flowTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <app-icon name="activity" size="0.9375rem" />
                  {{ t('bank.finance.flowTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                </h2>
                <p class="fin-section__sub">{{ t('bank.finance.flowDescription') }}</p>
              </div>
            </header>

            <div class="fin-kpis">
              @for (kpi of flowKpis(); track kpi.key) {
                @if (kpi.link; as link) {
                  <a class="fin-kpi" [routerLink]="link[0]" [queryParams]="link[1]">
                    <ng-container
                      *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: true }"
                    />
                  </a>
                } @else {
                  <div class="fin-kpi">
                    <ng-container
                      *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: false }"
                    />
                  </div>
                }
              }
            </div>

            <div class="fin-grid">
              <article class="fin-card fin-card--full">
                <header class="fin-card__head">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.weeklyFlow') }}</h3>
                    <p class="fin-card__sub">{{ t('bank.finance.weeklyFlowDescription') }}</p>
                  </div>
                  <span class="fin-card__badge">
                    {{ t('bank.finance.avgWeeklyLoot') }} {{ formatCompact(avgWeeklyLoot()) }}
                  </span>
                </header>
                @if (hasTrends()) {
                  <app-chart
                    [option]="flowOption()"
                    height="19rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.weeklyFlow')"
                    [tableHead]="flowTableHead()"
                    [tableRows]="flowTableRows()"
                  />
                } @else {
                  <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>

              <article class="fin-card">
                <header class="fin-card__head">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.netWeekly') }}</h3>
                    <p class="fin-card__sub">{{ t('bank.finance.netWeeklyDescription') }}</p>
                  </div>
                  <span class="fin-card__badge">
                    {{ t('bank.finance.avgWeeklyNet') }} {{ formatSigned(avgWeeklyNet()) }}
                  </span>
                </header>
                @if (hasTrends()) {
                  <app-chart
                    [option]="netOption()"
                    height="16rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.netWeekly')"
                    [tableHead]="netTableHead()"
                    [tableRows]="netTableRows()"
                  />
                } @else {
                  <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>

              <article class="fin-card">
                <header class="fin-card__head">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.outflowAllocation') }}</h3>
                    <p class="fin-card__sub">
                      {{ t('bank.finance.outflowAllocationDescription') }}
                    </p>
                  </div>
                  <span class="fin-card__badge">{{
                    formatCompact(guildReport.economy.outflow_total)
                  }}</span>
                </header>
                @if (guildReport.economy.outflow_total > 0) {
                  <app-chart
                    [option]="outflowOption()"
                    height="16rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.outflowAllocation')"
                    [tableHead]="shareTableHead()"
                    [tableRows]="outflowTableRows()"
                  />
                } @else {
                  <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>
            </div>
          </section>

          <!-- ============ 3. Losses and recovery ============ -->
          <section class="fin-section" [attr.aria-label]="t('bank.finance.combatTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <app-icon name="shield" size="0.9375rem" />
                  {{ t('bank.finance.combatTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                </h2>
                <p class="fin-section__sub">{{ t('bank.finance.combatDescription') }}</p>
              </div>
            </header>

            <div class="fin-kpis">
              @for (kpi of combatKpis(); track kpi.key) {
                <div class="fin-kpi">
                  <ng-container
                    *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: false }"
                  />
                </div>
              }
            </div>

            <div class="fin-grid">
              <article class="fin-card">
                <header class="fin-card__head">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.lossVsRegear') }}</h3>
                    <p class="fin-card__sub">{{ t('bank.finance.coverageDetail') }}</p>
                  </div>
                  <span class="fin-card__badge">{{ regearCoverageRatio() }}%</span>
                </header>
                @if (hasTrends()) {
                  <app-chart
                    [option]="lossRegearOption()"
                    height="17rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.lossVsRegear')"
                    [tableHead]="lossTableHead()"
                    [tableRows]="lossTableRows()"
                  />
                } @else {
                  <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>

              <article class="fin-card">
                <header class="fin-card__head">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.weeklyActivity') }}</h3>
                    <p class="fin-card__sub">{{ t('bank.finance.weeklyActivityDescription') }}</p>
                  </div>
                </header>
                @if (hasTrends()) {
                  <app-chart
                    [option]="activityOption()"
                    height="17rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.weeklyActivity')"
                    [tableHead]="activityTableHead()"
                    [tableRows]="activityTableRows()"
                  />
                } @else {
                  <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>
            </div>
          </section>
        } @else {
          <p class="fin-note">{{ t('bank.finance.reportPermission') }}</p>
        }

        <!-- ============ 4. Where money comes from and goes — whole ledger ============ -->
        <section class="fin-section" [attr.aria-label]="t('bank.finance.originTitle')">
          <header class="fin-section__head">
            <div>
              <h2 class="fin-section__title">
                <app-icon name="scan" size="0.9375rem" />
                {{ t('bank.finance.originTitle') }}
                <span class="fin-scope">{{ t('bank.finance.scopeAllTime') }}</span>
              </h2>
              <p class="fin-section__sub">{{ t('bank.finance.originDescription') }}</p>
            </div>
          </header>

          <div class="fin-grid fin-grid--thirds">
            <article class="fin-card">
              <header class="fin-card__head">
                <h3 class="fin-card__title">{{ t('bank.finance.topSourcesTitle') }}</h3>
              </header>
              @if (bank.sources.length > 0) {
                <app-chart
                  [option]="sourcesOption()"
                  height="16rem"
                  [stale]="busy()"
                  [label]="t('bank.finance.topSourcesTitle')"
                  [tableHead]="breakdownTableHead()"
                  [tableRows]="sourcesTableRows()"
                />
              } @else {
                <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
              }
            </article>

            <article class="fin-card">
              <header class="fin-card__head">
                <h3 class="fin-card__title">{{ t('bank.finance.topDestinationsTitle') }}</h3>
              </header>
              @if (bank.destinations.length > 0) {
                <app-chart
                  [option]="destinationsOption()"
                  height="16rem"
                  [stale]="busy()"
                  [label]="t('bank.finance.topDestinationsTitle')"
                  [tableHead]="breakdownTableHead()"
                  [tableRows]="destinationsTableRows()"
                />
              } @else {
                <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
              }
            </article>

            <article class="fin-card">
              <header class="fin-card__head">
                <h3 class="fin-card__title">{{ t('bank.finance.ledgerMix') }}</h3>
                <span class="fin-card__badge">{{ t('bank.finance.byTransactionType') }}</span>
              </header>
              @if (bank.transaction_types.length > 0) {
                <app-chart
                  [option]="typesOption()"
                  height="16rem"
                  [stale]="busy()"
                  [label]="t('bank.finance.ledgerMix')"
                  [tableHead]="breakdownTableHead()"
                  [tableRows]="typesTableRows()"
                />
              } @else {
                <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
              }
            </article>
          </div>
        </section>

        <!-- ============ 5. Per-member ledger — every figure traceable to a member ============ -->
        @if (memberRows().length > 0) {
          <section class="fin-section" [attr.aria-label]="t('bank.finance.memberLedgerTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <app-icon name="users" size="0.9375rem" />
                  {{ t('bank.finance.memberLedgerTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                </h2>
                <p class="fin-section__sub">{{ t('bank.finance.memberLedgerDescription') }}</p>
              </div>
              <p class="fin-meta">
                {{ t('bank.finance.membersShown', { count: memberRows().length }) }}
              </p>
            </header>

            <div class="fin-table-wrap" [class.fin-stale]="busy()">
              <table class="fin-table">
                <caption class="sr-only">
                  {{
                    t('bank.finance.memberLedgerTitle')
                  }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{{ t('bank.finance.member') }}</th>
                    <th scope="col">{{ t('bank.finance.splitEarnings') }}</th>
                    <th scope="col">{{ t('bank.finance.regearSilver') }}</th>
                    <th scope="col">{{ t('bank.finance.silverLost') }}</th>
                    <th scope="col">{{ t('bank.finance.bankPending') }}</th>
                    <th scope="col">{{ t('bank.finance.siphoned') }}</th>
                    <th scope="col">{{ t('common.actions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of memberRows(); track row.user_id) {
                    <tr>
                      <th scope="row">{{ row.username }}</th>
                      <td>{{ formatAmount(row.split_earnings) }}</td>
                      <td>{{ formatAmount(row.regear_silver) }}</td>
                      <td>{{ formatAmount(row.silver_lost) }}</td>
                      <td>{{ formatAmount(row.bank_pending) }}</td>
                      <td>{{ formatAmount(row.siphoned) }}</td>
                      <td>
                        <a
                          [routerLink]="'/admin/transactions'"
                          [queryParams]="{ search: row.username }"
                          [appTooltip]="t('bank.finance.viewTransactions')"
                        >
                          {{ t('bank.finance.viewTransactions') }}
                        </a>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        @if (report()?.data_quality; as quality) {
          <p class="fin-note">
            <strong>{{ t('bank.finance.dataQuality') }}:</strong>
            {{
              t('bank.finance.dataQualityDetail', {
                attributed: quality.attributed_battles,
                total: quality.total_battles,
              })
            }}
            @if (quality.unlinked_players.length > 0) {
              · {{ t('bank.finance.unlinkedPlayers', { count: quality.unlinked_players.length }) }}
            }
          </p>
        }
        <p class="fin-note">{{ t('bank.finance.ledgerNote') }}</p>
      } @else if (loading()) {
        <p class="fin-note">{{ t('bank.finance.loading') }}</p>
      } @else {
        <p class="fin-note">{{ t('bank.finance.unavailable') }}</p>
      }
    </app-page-stack>

    <!-- Shared KPI body so the linked and unlinked tiles cannot drift apart. -->
    <ng-template #kpiBody let-kpi let-linked="linked">
      <div class="fin-kpi__top">
        <p class="fin-kpi__label">{{ kpi.label }}</p>
        @if (kpi.delta; as delta) {
          <span
            class="fin-kpi__delta"
            [class.fin-kpi__delta--good]="delta.direction !== 'flat' && delta.good"
            [class.fin-kpi__delta--bad]="delta.direction !== 'flat' && !delta.good"
            [class.fin-kpi__delta--flat]="delta.direction === 'flat'"
            [appTooltip]="t('bank.finance.vsPrevious', { days: rangeDays() })"
          >
            {{ delta.label }}
          </span>
        }
      </div>
      <p class="fin-kpi__value" [class]="'fin-kpi__value--' + kpi.tone">{{ kpi.value }}</p>
      <p class="fin-kpi__detail">{{ kpi.detail }}</p>
      @if (linked) {
        <span class="fin-kpi__cta">
          {{ t('bank.finance.viewTransactions') }}
          <app-icon name="chevron-right" size="0.75rem" />
        </span>
      }
    </ng-template>
  `,
})
export class AdminFinance {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly theme = inject(ThemeService);

  protected readonly summary = signal<BankAnalyticsSummary | null>(null);
  protected readonly report = signal<GuildReport | null>(null);
  protected readonly previousReport = signal<GuildReport | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);

  protected readonly period = signal<PeriodId>('30');
  protected readonly customFrom = signal(toDateInput(new Date(Date.now() - 30 * MS_PER_DAY)));
  protected readonly customTo = signal(toDateInput(new Date()));

  /** True while any fetch is in flight; charts hold their last render instead of flashing. */
  protected readonly busy = computed(() => this.loading() || this.refreshing());

  protected readonly today = computed(() => toDateInput(new Date()));

  protected readonly periodOptions = computed<ViewToggleOption[]>(() => [
    { id: '7', label: this.t('bank.finance.period7') },
    { id: '30', label: this.t('bank.finance.period30') },
    { id: '90', label: this.t('bank.finance.period90') },
    { id: 'custom', label: this.t('bank.finance.periodCustom'), icon: 'calendar' },
  ]);

  protected readonly rangeDays = computed(() => this.resolveRange()?.days ?? 30);

  protected readonly trends = computed<readonly TrendBucket[]>(() => this.report()?.trends ?? []);
  protected readonly hasTrends = computed(() => this.trends().length > 0);

  private readonly palette = computed(() => chartPalette(this.theme.isDark()));
  private readonly chrome = computed(() => chartChrome(this.theme.isDark()));

  constructor() {
    void this.loadFinance();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /* ------------------------------ Loading ------------------------------ */

  protected onPeriodChange(id: string): void {
    this.period.set(id as PeriodId);
    void this.loadFinance();
  }

  protected onCustomFrom(event: Event): void {
    this.customFrom.set((event.target as HTMLInputElement).value);
    void this.loadFinance();
  }

  protected onCustomTo(event: Event): void {
    this.customTo.set((event.target as HTMLInputElement).value);
    void this.loadFinance();
  }

  /**
   * Resolves the selected period into an absolute window plus the equally long
   * window immediately before it. Returns `null` when a custom range is
   * incomplete or inverted, which is a user-correctable state, not an error.
   */
  private resolveRange(): ResolvedRange | null {
    const preset = this.period();
    let from: Date;
    let to: Date;

    if (preset === 'custom') {
      const rawFrom = this.customFrom();
      const rawTo = this.customTo();
      if (!rawFrom || !rawTo) {
        return null;
      }
      from = new Date(`${rawFrom}T00:00:00`);
      to = new Date(`${rawTo}T23:59:59`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return null;
      }
    } else {
      to = new Date();
      from = new Date(to.getTime() - PRESET_DAYS[preset] * MS_PER_DAY);
    }

    const span = to.getTime() - from.getTime();
    return {
      from,
      to,
      days: Math.max(1, Math.round(span / MS_PER_DAY)),
      previousFrom: new Date(from.getTime() - span),
      previousTo: new Date(from.getTime()),
    };
  }

  protected async loadFinance(): Promise<void> {
    const range = this.resolveRange();
    if (!range) {
      this.toasts.error(this.t('bank.finance.invalidRange'));
      return;
    }

    const firstLoad = this.summary() === null;
    this.loading.set(firstLoad);
    this.refreshing.set(!firstLoad);

    const [bankResult, reportResult, previousResult] = await Promise.allSettled([
      firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary')),
      firstValueFrom(
        this.api.get<GuildReport>('api/intel/report', {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
        }),
      ),
      firstValueFrom(
        this.api.get<GuildReport>('api/intel/report', {
          from: range.previousFrom.toISOString(),
          to: range.previousTo.toISOString(),
        }),
      ),
    ]);

    if (bankResult.status === 'fulfilled') {
      this.summary.set(bankResult.value);
    } else {
      this.summary.set(null);
      this.toasts.error(this.t('common.error'));
    }
    this.report.set(reportResult.status === 'fulfilled' ? reportResult.value : null);
    this.previousReport.set(previousResult.status === 'fulfilled' ? previousResult.value : null);
    this.loading.set(false);
    this.refreshing.set(false);
  }

  /* -------------------------------- KPIs ------------------------------- */

  /**
   * Whole-ledger position. Each tile links to the transaction queue filtered to
   * the status it counts, so the figure can always be walked back to its rows.
   */
  protected readonly positionKpis = computed<FinanceKpi[]>(() => {
    const bank = this.summary();
    if (!bank) {
      return [];
    }
    return [
      {
        key: 'outstanding',
        label: this.t('bank.finance.openLiability'),
        value: this.formatAmount(bank.outstanding_total),
        detail: this.t('bank.finance.creditsOwed', { count: bank.outstanding_count }),
        tone: 'warning',
        link: ['/admin/transactions', { status: 'pending' }],
      },
      {
        key: 'requested',
        label: this.t('bank.finance.awaitingApproval'),
        value: this.formatAmount(bank.requested_total),
        detail: this.t('bank.finance.requestedWithdrawals', { count: bank.requested_count }),
        tone: 'default',
        link: ['/admin/transactions', { status: 'requested' }],
      },
      {
        key: 'paid',
        label: this.t('bank.finance.paidOut'),
        value: this.formatAmount(bank.paid_out_total),
        detail: this.t('bank.finance.settledPayouts', { count: bank.paid_out_count }),
        tone: 'success',
        link: ['/admin/transactions', { status: 'withdrawn' }],
      },
      {
        key: 'donated',
        label: this.t('bank.finance.donatedBack'),
        value: this.formatAmount(bank.donated_total),
        detail: this.t('bank.finance.memberDonations', { count: bank.donated_count }),
        tone: 'default',
        link: ['/admin/transactions', { status: 'donated' }],
      },
    ];
  });

  /** Window-scoped flow, each figure carrying its movement against the prior window. */
  protected readonly flowKpis = computed<FinanceKpi[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    const previous = this.previousReport()?.economy;
    return [
      {
        key: 'loot',
        label: this.t('bank.finance.lootCreated'),
        value: this.formatAmount(economy.loot_in),
        detail: this.t('bank.finance.perWeek', { value: this.formatCompact(this.avgWeeklyLoot()) }),
        tone: 'success',
        delta: this.buildDelta(economy.loot_in, previous?.loot_in, true),
      },
      {
        key: 'outflow',
        label: this.t('bank.finance.memberOutflow'),
        value: this.formatAmount(economy.outflow_total),
        detail: this.t('bank.finance.outflowSplit', {
          splits: this.formatCompact(economy.outflow_splits),
          regear: this.formatCompact(economy.outflow_regear),
        }),
        tone: 'default',
        delta: this.buildDelta(economy.outflow_total, previous?.outflow_total, false),
      },
      {
        key: 'net',
        label: this.t('bank.finance.netCashFlow'),
        value: this.formatSigned(economy.net),
        detail: this.t('bank.finance.netDetail'),
        tone: economy.net >= 0 ? 'success' : 'danger',
        delta: this.buildDelta(economy.net, previous?.net, true),
      },
      {
        key: 'pending',
        label: this.t('bank.finance.bankPending'),
        value: this.formatAmount(economy.bank_pending),
        detail: this.t('bank.finance.bankPendingDetail'),
        tone: 'warning',
        delta: this.buildDelta(economy.bank_pending, previous?.bank_pending, false),
        link: ['/admin/transactions', { status: 'pending' }],
      },
    ];
  });

  protected readonly combatKpis = computed<FinanceKpi[]>(() => {
    const report = this.report();
    if (!report) {
      return [];
    }
    const previous = this.previousReport();
    const lost = report.overview.silver_lost;
    return [
      {
        key: 'lost',
        label: this.t('bank.finance.silverLost'),
        value: this.formatAmount(lost),
        detail: this.t('bank.finance.acrossFights', { count: report.overview.fights }),
        tone: 'danger',
        delta: this.buildDelta(lost, previous?.overview.silver_lost, false),
      },
      {
        key: 'regear',
        label: this.t('bank.finance.regearPaid'),
        value: this.formatAmount(report.economy.regear_paid),
        detail: this.t('bank.finance.regearOpenDetail', {
          value: this.formatCompact(report.economy.regear_open),
        }),
        tone: 'default',
        delta: this.buildDelta(report.economy.regear_paid, previous?.economy.regear_paid, true),
      },
      {
        key: 'coverage',
        label: this.t('bank.finance.regearCoverage'),
        value: `${this.regearCoverageRatio()}%`,
        detail: this.t('bank.finance.coverageDetail'),
        tone: 'default',
      },
      {
        key: 'fame',
        label: this.t('bank.finance.fameEfficiency'),
        value: this.formatCompact(report.economy.fame_per_million_lost),
        detail: this.t('bank.finance.fameEfficiencyDetail'),
        tone: 'default',
        delta: this.buildDelta(
          report.economy.fame_per_million_lost,
          previous?.economy.fame_per_million_lost,
          true,
        ),
      },
    ];
  });

  /**
   * Percentage movement against the previous window.
   *
   * `higherIsBetter` is deliberately separate from the direction: outflow going
   * up is not automatically bad news, but it is never painted green.
   */
  private buildDelta(
    current: number,
    previous: number | undefined,
    higherIsBetter: boolean,
  ): FinanceDelta | undefined {
    if (previous === undefined || previous === 0) {
      return undefined;
    }
    const change = ((current - previous) / Math.abs(previous)) * 100;
    if (!Number.isFinite(change)) {
      return undefined;
    }
    const rounded = Math.round(change);
    if (rounded === 0) {
      return { label: '0%', direction: 'flat', good: true };
    }
    return {
      label: `${rounded > 0 ? '+' : ''}${rounded}%`,
      direction: rounded > 0 ? 'up' : 'down',
      good: rounded > 0 === higherIsBetter,
    };
  }

  protected readonly avgWeeklyLoot = computed(() => {
    const trends = this.trends();
    if (trends.length === 0) {
      return 0;
    }
    return Math.round(trends.reduce((acc, bucket) => acc + bucket.loot_in, 0) / trends.length);
  });

  protected readonly avgWeeklyNet = computed(() => {
    const trends = this.trends();
    if (trends.length === 0) {
      return 0;
    }
    const total = trends.reduce((acc, bucket) => acc + (bucket.loot_in - bucket.outflow), 0);
    return Math.round(total / trends.length);
  });

  protected readonly regearCoverageRatio = computed(() => {
    const trends = this.trends();
    const lost = trends.reduce((acc, bucket) => acc + (bucket.silver_lost || 0), 0);
    if (lost <= 0) {
      return 0;
    }
    const paid = trends.reduce((acc, bucket) => acc + (bucket.regear_paid || 0), 0);
    return Math.min(999, Math.round((paid / lost) * 100));
  });

  protected readonly memberRows = computed<readonly ReportMemberRow[]>(() => {
    const members = this.report()?.members ?? [];
    return [...members]
      .filter(
        (row) =>
          row.split_earnings > 0 ||
          row.regear_silver > 0 ||
          row.silver_lost > 0 ||
          row.bank_pending > 0 ||
          row.siphoned > 0,
      )
      .sort((a, b) => b.split_earnings + b.regear_silver - (a.split_earnings + a.regear_silver))
      .slice(0, 25);
  });

  /* ------------------------------- Charts ------------------------------ */

  private weekLabels(): string[] {
    return this.trends().map((bucket) => this.formatWeek(bucket.week_start));
  }

  /** Shared axis/grid skeleton so every plot lines up with the others. */
  private baseGrid(bottom: number): EChartsOption['grid'] {
    return { left: 4, right: 12, top: 30, bottom, containLabel: true };
  }

  private valueAxisLabel(): Record<string, unknown> {
    return { formatter: (value: number) => this.formatCompact(value), hideOverlap: true };
  }

  /** Axis tooltip listing every series at the hovered week, value first. */
  private axisTooltip(unit: 'silver' | 'count'): Record<string, unknown> {
    return {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (input: unknown) => {
        const params = toParamList(input);
        const header = escapeHtml(params[0]?.axisValueLabel ?? params[0]?.name ?? '');
        const rows = params
          .map((param) => {
            const raw = toNumber(param.value as number);
            const value = unit === 'silver' ? this.formatAmount(raw) : this.formatAmount(raw);
            const key = `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${
              param.color ?? 'currentColor'
            };vertical-align:middle;margin-inline-end:6px"></span>`;
            return `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin-top:3px">
              <span style="opacity:0.75">${key}${escapeHtml(param.seriesName ?? '')}</span>
              <strong style="font-variant-numeric:tabular-nums">${escapeHtml(value)}</strong>
            </div>`;
          })
          .join('');
        return `<div style="font-size:11px;opacity:0.7;margin-bottom:2px">${header}</div>${rows}`;
      },
    };
  }

  /** Per-mark tooltip for the horizontal breakdown bars. */
  private itemTooltip(total: number): Record<string, unknown> {
    return {
      trigger: 'item',
      formatter: (input: unknown) => {
        const param = toParamList(input)[0];
        const raw = toNumber(param?.value as number);
        const share = total > 0 ? Math.round((raw / total) * 1000) / 10 : 0;
        return `<div style="font-size:11px;opacity:0.7;margin-bottom:2px">${escapeHtml(
          param?.name ?? '',
        )}</div><strong style="font-variant-numeric:tabular-nums">${escapeHtml(
          this.formatAmount(raw),
        )}</strong> <span style="opacity:0.6">· ${share}%</span>`;
      },
    };
  }

  /** Vertical gradient under a line, fading to nothing at the baseline. */
  private areaFill(color: string): Record<string, unknown> {
    return {
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: `${color}3d` },
          { offset: 1, color: `${color}00` },
        ],
      },
    };
  }

  protected readonly flowOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();
    const surface = this.chrome().surface;
    const zoomable = trends.length > 10;

    // A ring in the surface colour keeps the two markers readable where the
    // lines cross, which on a flow chart is exactly where the reader looks.
    const marker = (color: string) => ({ color, borderColor: surface, borderWidth: 2 });

    return {
      aria: { enabled: true },
      grid: this.baseGrid(zoomable ? 46 : 8),
      legend: { top: 0, left: 0 },
      tooltip: this.axisTooltip('silver'),
      xAxis: { type: 'category', boundaryGap: false, data: this.weekLabels() },
      yAxis: { type: 'value', axisLabel: this.valueAxisLabel() },
      dataZoom: zoomable
        ? [
            { type: 'inside', filterMode: 'none' },
            { type: 'slider', height: 18, bottom: 6, filterMode: 'none' },
          ]
        : undefined,
      series: [
        {
          name: this.t('bank.finance.lootCreated'),
          type: 'line',
          data: trends.map((bucket) => bucket.loot_in),
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 2, color: palette.lootIn },
          itemStyle: marker(palette.lootIn),
          areaStyle: this.areaFill(palette.lootIn),
          emphasis: { focus: 'series' },
        },
        {
          name: this.t('bank.finance.memberOutflow'),
          type: 'line',
          data: trends.map((bucket) => bucket.outflow),
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 2, color: palette.outflow },
          itemStyle: marker(palette.outflow),
          areaStyle: this.areaFill(palette.outflow),
          emphasis: { focus: 'series' },
        },
      ],
    };
  });

  protected readonly netOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();
    const values = trends.map((bucket) => bucket.loot_in - bucket.outflow);

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      tooltip: this.axisTooltip('silver'),
      xAxis: { type: 'category', data: this.weekLabels() },
      yAxis: { type: 'value', axisLabel: this.valueAxisLabel() },
      series: [
        {
          name: this.t('bank.finance.netResult'),
          type: 'bar',
          data: values.map((value) => ({
            value,
            itemStyle: {
              color: value >= 0 ? palette.neutralSeries : palette.negativeSeries,
              borderRadius: value >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
            },
          })),
          barMaxWidth: 26,
          barCategoryGap: '38%',
        },
      ],
    };
  });

  protected readonly lossRegearOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      legend: { top: 0, left: 0 },
      tooltip: this.axisTooltip('silver'),
      xAxis: { type: 'category', data: this.weekLabels() },
      yAxis: { type: 'value', axisLabel: this.valueAxisLabel() },
      series: [
        {
          name: this.t('bank.finance.silverLost'),
          type: 'bar',
          data: trends.map((bucket) => Math.abs(bucket.silver_lost || 0)),
          itemStyle: { color: palette.silverLost, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
          barGap: '18%',
          barCategoryGap: '40%',
        },
        {
          name: this.t('bank.finance.regearPaid'),
          type: 'bar',
          data: trends.map((bucket) => Math.abs(bucket.regear_paid || 0)),
          itemStyle: { color: palette.regearPaid, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
      ],
    };
  });

  protected readonly activityOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      legend: { top: 0, left: 0 },
      tooltip: this.axisTooltip('count'),
      xAxis: { type: 'category', data: this.weekLabels() },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: this.t('bank.finance.fights'),
          type: 'bar',
          data: trends.map((bucket) => bucket.fights),
          itemStyle: { color: palette.fights, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
          barGap: '18%',
          barCategoryGap: '40%',
        },
        {
          name: this.t('bank.finance.events'),
          type: 'bar',
          data: trends.map((bucket) => bucket.events),
          itemStyle: { color: palette.events, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
      ],
    };
  });

  /**
   * Horizontal single-series bars for nominal categories.
   *
   * One series, one colour: darkening bars by size would double-encode length
   * as hue and burn the only free channel on information the bar already shows.
   */
  private horizontalBars(
    rows: ReadonlyArray<{ label: string; value: number }>,
    directLabels: boolean,
  ): EChartsOption {
    const palette = this.palette();
    const ordered = [...rows].sort((a, b) => a.value - b.value);
    const total = ordered.reduce((acc, row) => acc + row.value, 0);

    return {
      aria: { enabled: true },
      grid: { left: 4, right: directLabels ? 72 : 16, top: 8, bottom: 4, containLabel: true },
      tooltip: this.itemTooltip(total),
      xAxis: {
        type: 'value',
        // These cards are narrow; the default tick count collides into an
        // unreadable smear, so ask for few ticks and drop any that still touch.
        splitNumber: 3,
        axisLabel: this.valueAxisLabel(),
        splitLine: { show: true },
      },
      yAxis: {
        type: 'category',
        data: ordered.map((row) => row.label),
        axisLabel: { width: 124, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          data: ordered.map((row) => row.value),
          itemStyle: { color: palette.neutralSeries, borderRadius: [0, 4, 4, 0] },
          barMaxWidth: 16,
          barCategoryGap: '42%',
          label: directLabels
            ? {
                show: true,
                position: 'right',
                distance: 8,
                formatter: (param: { value?: unknown }) =>
                  this.formatCompact(toNumber(param.value as number)),
                fontSize: 11,
                color: this.chrome().textSecondary,
                textBorderWidth: 0,
              }
            : { show: false },
        },
      ],
    };
  }

  protected readonly outflowOption = computed<EChartsOption>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return {};
    }
    return this.horizontalBars(
      [
        { label: this.t('bank.finance.splitOutflow'), value: economy.outflow_splits },
        { label: this.t('bank.finance.regearPaid'), value: economy.outflow_regear },
        { label: this.t('bank.finance.otherOutflow'), value: economy.outflow_other },
      ],
      true,
    );
  });

  protected readonly sourcesOption = computed<EChartsOption>(() =>
    this.horizontalBars(this.breakdownRows(this.summary()?.sources), false),
  );

  protected readonly destinationsOption = computed<EChartsOption>(() =>
    this.horizontalBars(this.breakdownRows(this.summary()?.destinations), false),
  );

  protected readonly typesOption = computed<EChartsOption>(() =>
    this.horizontalBars(this.breakdownRows(this.summary()?.transaction_types), false),
  );

  private breakdownRows(
    lines: readonly BankBreakdown[] | undefined,
  ): ReadonlyArray<{ label: string; value: number }> {
    return [...(lines ?? [])]
      .map((line) => ({ label: line.label, value: Math.abs(toNumber(line.total_amount)) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }

  /* ---------------------------- Table twins ---------------------------- */

  protected readonly flowTableHead = computed(() => [
    this.t('bank.finance.week'),
    this.t('bank.finance.lootCreated'),
    this.t('bank.finance.memberOutflow'),
    this.t('bank.finance.netResult'),
  ]);

  protected readonly flowTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      this.formatAmount(bucket.loot_in),
      this.formatAmount(bucket.outflow),
      this.formatSigned(bucket.loot_in - bucket.outflow),
    ]),
  );

  protected readonly netTableHead = computed(() => [
    this.t('bank.finance.week'),
    this.t('bank.finance.netResult'),
  ]);

  protected readonly netTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      this.formatSigned(bucket.loot_in - bucket.outflow),
    ]),
  );

  protected readonly lossTableHead = computed(() => [
    this.t('bank.finance.week'),
    this.t('bank.finance.silverLost'),
    this.t('bank.finance.regearPaid'),
  ]);

  protected readonly lossTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      this.formatAmount(Math.abs(bucket.silver_lost || 0)),
      this.formatAmount(Math.abs(bucket.regear_paid || 0)),
    ]),
  );

  protected readonly activityTableHead = computed(() => [
    this.t('bank.finance.week'),
    this.t('bank.finance.fights'),
    this.t('bank.finance.events'),
  ]);

  protected readonly activityTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      String(bucket.fights),
      String(bucket.events),
    ]),
  );

  protected readonly shareTableHead = computed(() => [
    this.t('bank.finance.destination'),
    this.t('common.amount'),
  ]);

  protected readonly breakdownTableHead = computed(() => [
    this.t('common.label'),
    this.t('common.amount'),
    this.t('bank.finance.ledgerEntriesShort'),
  ]);

  protected readonly outflowTableRows = computed<ChartTableRow[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    return [
      [this.t('bank.finance.splitOutflow'), this.formatAmount(economy.outflow_splits)],
      [this.t('bank.finance.regearPaid'), this.formatAmount(economy.outflow_regear)],
      [this.t('bank.finance.otherOutflow'), this.formatAmount(economy.outflow_other)],
    ];
  });

  protected readonly sourcesTableRows = computed(() =>
    this.breakdownTable(this.summary()?.sources),
  );

  protected readonly destinationsTableRows = computed(() =>
    this.breakdownTable(this.summary()?.destinations),
  );

  protected readonly typesTableRows = computed(() =>
    this.breakdownTable(this.summary()?.transaction_types),
  );

  private breakdownTable(lines: readonly BankBreakdown[] | undefined): ChartTableRow[] {
    return [...(lines ?? [])]
      .sort((a, b) => Math.abs(toNumber(b.total_amount)) - Math.abs(toNumber(a.total_amount)))
      .slice(0, 8)
      .map((line) => [
        line.label,
        this.formatAmount(line.total_amount),
        String(line.transaction_count),
      ]);
  }

  /* ------------------------------- Export ------------------------------ */

  /**
   * Downloads everything on screen as one CSV, in labelled blocks.
   *
   * Officers reconcile against an external sheet, so the export mirrors the
   * page rather than a single chart: the window that produced it, the weekly
   * series, the totals, the whole-ledger breakdowns and the per-member rows.
   */
  protected exportCsv(): void {
    const bank = this.summary();
    if (!bank || typeof document === 'undefined') {
      return;
    }
    const report = this.report();
    const cell = (value: string | number): string => {
      const text = String(value);
      return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const line = (...values: Array<string | number>): string => values.map(cell).join(',');
    const rows: string[] = [];

    rows.push(line(this.t('bank.finance.heading')));
    if (report) {
      rows.push(line(this.t('bank.finance.periodLabel'), report.from, report.to));
    }
    rows.push('');

    rows.push(line(this.t('bank.finance.positionTitle')));
    rows.push(
      line(
        this.t('common.label'),
        this.t('common.amount'),
        this.t('bank.finance.ledgerEntriesShort'),
      ),
    );
    rows.push(
      line(
        this.t('bank.finance.openLiability'),
        toNumber(bank.outstanding_total),
        bank.outstanding_count,
      ),
    );
    rows.push(
      line(
        this.t('bank.finance.awaitingApproval'),
        toNumber(bank.requested_total),
        bank.requested_count,
      ),
    );
    rows.push(
      line(this.t('bank.finance.paidOut'), toNumber(bank.paid_out_total), bank.paid_out_count),
    );
    rows.push(
      line(this.t('bank.finance.donatedBack'), toNumber(bank.donated_total), bank.donated_count),
    );
    rows.push(
      line(
        this.t('bank.finance.ledgerVolume'),
        toNumber(bank.ledger_volume),
        bank.transaction_count,
      ),
    );
    rows.push('');

    if (report) {
      rows.push(line(this.t('bank.finance.weeklyFlow')));
      rows.push(
        line(
          this.t('bank.finance.week'),
          this.t('bank.finance.lootCreated'),
          this.t('bank.finance.memberOutflow'),
          this.t('bank.finance.netResult'),
          this.t('bank.finance.silverLost'),
          this.t('bank.finance.regearPaid'),
          this.t('bank.finance.fights'),
          this.t('bank.finance.events'),
        ),
      );
      for (const bucket of report.trends) {
        rows.push(
          line(
            bucket.week_start,
            bucket.loot_in,
            bucket.outflow,
            bucket.loot_in - bucket.outflow,
            bucket.silver_lost,
            bucket.regear_paid,
            bucket.fights,
            bucket.events,
          ),
        );
      }
      rows.push('');

      rows.push(line(this.t('bank.finance.memberLedgerTitle')));
      rows.push(
        line(
          this.t('bank.finance.member'),
          this.t('bank.finance.splitEarnings'),
          this.t('bank.finance.regearSilver'),
          this.t('bank.finance.silverLost'),
          this.t('bank.finance.bankPending'),
          this.t('bank.finance.siphoned'),
        ),
      );
      for (const member of this.memberRows()) {
        rows.push(
          line(
            member.username,
            member.split_earnings,
            member.regear_silver,
            member.silver_lost,
            member.bank_pending,
            member.siphoned,
          ),
        );
      }
      rows.push('');
    }

    const blocks: ReadonlyArray<[TranslationKey, readonly BankBreakdown[]]> = [
      ['bank.finance.topSourcesTitle', bank.sources],
      ['bank.finance.topDestinationsTitle', bank.destinations],
      ['bank.finance.ledgerMix', bank.transaction_types],
    ];
    for (const [titleKey, lines] of blocks) {
      rows.push(line(this.t(titleKey)));
      rows.push(
        line(
          this.t('common.label'),
          this.t('common.amount'),
          this.t('bank.finance.ledgerEntriesShort'),
        ),
      );
      for (const entry of lines) {
        rows.push(line(entry.label, toNumber(entry.total_amount), entry.transaction_count));
      }
      rows.push('');
    }

    // The BOM keeps Excel from mangling non-ASCII member names.
    const blob = new Blob([`﻿${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `weaklings-finance-${toDateInput(new Date())}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toasts.success(this.t('bank.finance.exported'));
  }

  /* ----------------------------- Formatting ---------------------------- */

  private getLocale(): string {
    const lang = this.translate.language();
    if (lang === 'it') return 'it-IT';
    if (lang === 'es') return 'es-ES';
    return 'en-US';
  }

  protected formatAmount(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.getLocale(), { maximumFractionDigits: 0 }).format(
      toNumber(value),
    );
  }

  protected formatSigned(value: number): string {
    const formatted = this.formatAmount(Math.abs(value));
    if (value === 0) {
      return formatted;
    }
    return `${value > 0 ? '+' : '−'}${formatted}`;
  }

  protected formatCompact(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.getLocale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(toNumber(value));
  }

  protected formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.getLocale(), { dateStyle: 'medium' }).format(date);
  }

  private formatWeek(value: TrendBucket['week_start']): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : new Intl.DateTimeFormat(this.getLocale(), { month: 'short', day: 'numeric' }).format(date);
  }
}
