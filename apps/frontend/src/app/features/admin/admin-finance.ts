import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
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
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/** Preset windows, plus the escape hatch to arbitrary dates. */
type PeriodId = '7' | '30' | '90' | 'custom';
type SectionTabId = 'all' | 'position' | 'taxes' | 'flow' | 'combat' | 'origin' | 'members';

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
  readonly icon: IconName;
  readonly badge?: string;
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
 * - `GET /api/intel/report?from&to` is **window-scoped** silver flow and split
 *   economics. It answers "what happened in this period" (including how much the
 *   guild earned in taxes, how much was spent on repairs, and net payouts), and
 *   is fetched twice — once for the selected window and once for the window
 *   immediately before it, which is what makes period-over-period deltas possible.
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
  styles: [COMPACT_FEATURE_STYLES, `
    .fin-toolbar {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      padding: 0.75rem 0.875rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .fin-filters__group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .fin-filters__window,
    .fin-meta {
      margin: 0;
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

    .fin-nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
      padding-block-start: 0.625rem;
      border-block-start: 1px solid var(--color-border);
    }
    .fin-nav__btn {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.3125rem 0.625rem;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition:
        background-color 0.15s ease,
        color 0.15s ease,
        border-color 0.15s ease;
    }
    .fin-nav__btn:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .fin-nav__btn--active {
      border-color: var(--color-border-strong);
      background: var(--color-surface-2);
      color: var(--color-text);
      font-weight: 600;
    }

    .fin-section {
      display: grid;
      gap: 0.875rem;
    }
    .fin-section__head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.5rem 0.75rem;
    }
    .fin-section__title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      color: var(--color-text);
      font-size: 0.9375rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .fin-section__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      inline-size: 1.625rem;
      block-size: 1.625rem;
      border-radius: 6px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-2);
      color: var(--color-primary);
    }
    .fin-section__sub {
      margin: 0.1875rem 0 0;
      max-inline-size: 65ch;
      color: var(--color-text-tertiary);
      font-size: 0.75rem;
      line-height: 1.45;
    }
    .fin-scope {
      flex: 0 0 auto;
      padding: 0.125rem 0.4375rem;
      border: 1px solid var(--color-border);
      border-radius: 999px;
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.625rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .fin-scope--accent {
      border-color: color-mix(in srgb, var(--color-primary) 35%, var(--color-border));
      background: color-mix(in srgb, var(--color-primary) 10%, transparent);
      color: var(--color-primary);
    }

    .fin-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 14.5rem), 1fr));
      gap: 0.75rem;
    }
    .fin-kpi {
      position: relative;
      display: flex;
      min-inline-size: 0;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.875rem 1rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
      color: inherit;
      text-decoration: none;
      transition:
        border-color 0.15s ease,
        background-color 0.15s ease,
        transform 0.15s ease;
    }
    .fin-kpi--success {
      border-inline-start: 3px solid var(--color-success);
    }
    .fin-kpi--warning {
      border-inline-start: 3px solid var(--color-warning);
    }
    .fin-kpi--danger {
      border-inline-start: 3px solid var(--color-error);
    }
    .fin-kpi--default {
      border-inline-start: 3px solid var(--color-primary);
    }
    a.fin-kpi:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
      transform: translateY(-1px);
    }
    a.fin-kpi:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .fin-kpi__top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .fin-kpi__title-group {
      display: flex;
      align-items: center;
      gap: 0.4375rem;
      min-inline-size: 0;
    }
    .fin-kpi__icon {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      inline-size: 1.5rem;
      block-size: 1.5rem;
      border-radius: 5px;
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .fin-kpi__icon--success {
      background: var(--color-success-container);
      color: var(--color-success);
    }
    .fin-kpi__icon--warning {
      background: var(--color-warning-container, var(--color-surface-2));
      color: var(--color-warning);
    }
    .fin-kpi__icon--danger {
      background: var(--color-error-container);
      color: var(--color-error);
    }
    .fin-kpi__label {
      margin: 0;
      overflow: hidden;
      color: var(--color-text-secondary);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .fin-kpi__badges {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 0.25rem;
    }
    .fin-kpi__pill {
      padding: 0.0625rem 0.375rem;
      border-radius: 4px;
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 0.625rem;
      font-weight: 600;
    }
    .fin-kpi__value {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 1.4375rem;
      font-weight: 700;
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
    .fin-kpi__foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .fin-kpi__detail {
      margin: 0;
      color: var(--color-text-tertiary);
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
      font-variant-numeric: tabular-nums;
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
      flex: 0 0 auto;
      align-items: center;
      gap: 0.1875rem;
      color: var(--color-primary);
      font-size: 0.625rem;
      font-weight: 600;
    }

    /* Pipeline / Waterfall card */
    .fin-pipeline {
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
      padding: 1rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-pipeline__steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
      gap: 0.5rem;
      align-items: stretch;
    }
    .fin-step {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.25rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface-2);
    }
    .fin-step--highlight {
      border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
      background: color-mix(in srgb, var(--color-success) 8%, var(--color-surface));
    }
    .fin-step--deduct {
      border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
      background: color-mix(in srgb, var(--color-warning) 6%, var(--color-surface));
    }
    .fin-step--member {
      border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
      background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface));
    }
    .fin-step__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.375rem;
    }
    .fin-step__op {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.0625rem 0.3125rem;
      border-radius: 3px;
      background: var(--color-surface);
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-size: 0.625rem;
      font-weight: 700;
    }
    .fin-step__label {
      color: var(--color-text-secondary);
      font-size: 0.6875rem;
      font-weight: 600;
    }
    .fin-step__val {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 1.0625rem;
      font-weight: 700;
    }
    .fin-step__sub {
      margin: 0;
      color: var(--color-text-tertiary);
      font-size: 0.625rem;
    }

    .fin-bar-stack {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }
    .fin-bar-track {
      display: flex;
      overflow: hidden;
      block-size: 0.625rem;
      border-radius: 999px;
      background: var(--color-surface-2);
    }
    .fin-bar-seg {
      block-size: 100%;
      transition: inline-size 0.25s ease;
    }
    .fin-bar-legend {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem 1.25rem;
      font-size: 0.6875rem;
      color: var(--color-text-secondary);
    }
    .fin-bar-legend__item {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }
    .fin-bar-legend__dot {
      inline-size: 0.5rem;
      block-size: 0.5rem;
      border-radius: 2px;
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
      padding: 0.875rem 1rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-card--full {
      grid-column: 1 / -1;
    }
    .fin-card__head {
      display: flex;
      align-items: flex-start;
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
      padding: 0.125rem 0.4375rem;
      border-radius: 4px;
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 0.6875rem;
      font-weight: 600;
    }

    .fin-table-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .fin-search {
      inline-size: min(100%, 18rem);
    }

    .fin-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface);
    }
    .fin-table {
      inline-size: 100%;
      min-inline-size: 46rem;
      border-collapse: collapse;
      font-size: 0.75rem;
    }
    .fin-table th,
    .fin-table td {
      padding: 0.5625rem 0.75rem;
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
    .fin-member-cell {
      display: flex;
      flex-direction: column;
      gap: 0.0625rem;
    }
    .fin-member-cell__sub {
      color: var(--color-text-tertiary);
      font-size: 0.625rem;
      font-weight: 400;
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
      font-family: var(--font-sans);
      font-weight: 500;
    }
    .fin-table a:hover {
      text-decoration: underline;
    }
    .fin-val--pos {
      color: var(--color-success) !important;
      font-weight: 600;
    }
    .fin-val--neg {
      color: var(--color-error) !important;
    }
    .fin-val--warn {
      color: var(--color-warning) !important;
    }

    .fin-note {
      margin: 0;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface);
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
      .fin-grid,
      .fin-grid--thirds {
        grid-template-columns: 1fr;
      }
    }
  `],
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
      <!-- Unified control toolbar: period filter, granularity, and section focus tabs -->
      <div class="fin-toolbar">
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
          <div class="fin-filters__group">
            <span class="eyebrow">{{ t('bank.finance.granularityLabel') }}</span>
            <app-view-toggle
              [options]="granularityOptions()"
              [active]="granularity()"
              (activeChange)="onGranularityChange($event)"
            />
          </div>
          <p class="fin-filters__window" aria-live="polite">
            @if (busy()) {
              {{ t('bank.finance.reloading') }}
            } @else if (report(); as r) {
              <strong>{{ formatDate(r.from) }} → {{ formatDate(r.to) }}</strong>
              · {{ trackedWindowLabel() }}
            }
          </p>
        </div>

        <nav class="fin-nav" [attr.aria-label]="t('common.overview')">
          @for (tab of sectionTabs(); track tab.id) {
            <button
              type="button"
              class="fin-nav__btn"
              [class.fin-nav__btn--active]="activeSection() === tab.id"
              (click)="activeSection.set(tab.id)"
            >
              <app-icon [name]="tab.icon" size="0.8125rem" />
              {{ tab.label }}
            </button>
          }
        </nav>
      </div>

      @if (summary(); as bank) {
        <!-- ============ 1. Bank position — whole ledger, period-independent ============ -->
        @if (activeSection() === 'all' || activeSection() === 'position') {
          <section class="fin-section" [attr.aria-label]="t('bank.finance.positionTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <span class="fin-section__icon">
                    <app-icon name="bank" size="0.9375rem" />
                  </span>
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
                  <a
                    class="fin-kpi"
                    [class]="'fin-kpi fin-kpi--' + kpi.tone"
                    [routerLink]="link[0]"
                    [queryParams]="link[1]"
                  >
                    <ng-container
                      *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: true }"
                    />
                  </a>
                } @else {
                  <div class="fin-kpi" [class]="'fin-kpi fin-kpi--' + kpi.tone">
                    <ng-container
                      *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: false }"
                    />
                  </div>
                }
              }
            </div>
          </section>
        }

        @if (report(); as guildReport) {
          <!-- ============ 2. Guild Taxes, Repairs & Split Economics ============ -->
          @if (activeSection() === 'all' || activeSection() === 'taxes') {
            <section class="fin-section" [attr.aria-label]="t('bank.finance.taxesTitle')">
              <header class="fin-section__head">
                <div>
                  <h2 class="fin-section__title">
                    <span class="fin-section__icon">
                      <app-icon name="coins" size="0.9375rem" />
                    </span>
                    {{ t('bank.finance.taxesTitle') }}
                    <span class="fin-scope fin-scope--accent">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="fin-section__sub">{{ t('bank.finance.taxesDescription') }}</p>
                </div>
                <p class="fin-meta">
                  <strong>{{
                    t('bank.finance.splitsCountBadge', {
                      completed: guildReport.economy.split_completed_count ?? 0,
                      pending: guildReport.economy.split_pending_count ?? 0,
                    })
                  }}</strong>
                  @if ((guildReport.economy.split_completed_count ?? 0) > 0) {
                    · {{ t('bank.finance.avgSplitValue') }}:
                    <strong class="mono">{{ formatCompact(avgCompletedSplitValue()) }}</strong>
                  }
                </p>
              </header>

              <div class="fin-kpis">
                @for (kpi of taxAndRepairKpis(); track kpi.key) {
                  @if (kpi.link; as link) {
                    <a
                      class="fin-kpi"
                      [class]="'fin-kpi fin-kpi--' + kpi.tone"
                      [routerLink]="link[0]"
                      [queryParams]="link[1]"
                    >
                      <ng-container
                        *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: true }"
                      />
                    </a>
                  } @else {
                    <div class="fin-kpi" [class]="'fin-kpi fin-kpi--' + kpi.tone">
                      <ng-container
                        *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: false }"
                      />
                    </div>
                  }
                }
              </div>

              <!-- Visual Loot Split Value Pipeline (Gross + Bags - Repairs = Pool -> Guild Tax + Member Net) -->
              <article class="fin-pipeline">
                <header class="fin-card__head" style="margin-block-end: 0">
                  <div>
                    <h3 class="fin-card__title">{{ t('bank.finance.pipelineTitle') }}</h3>
                    <p class="fin-card__sub">{{ t('bank.finance.pipelineSubtitle') }}</p>
                  </div>
                  <span class="fin-card__badge">
                    {{ t('bank.finance.repairBurden') }}: {{ repairToGrossPct() }}% ·
                    Fee: {{ guildReport.economy.split_avg_fee_pct ?? 0 }}%
                  </span>
                </header>

                <div class="fin-pipeline__steps">
                  <div class="fin-step">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.grossLoot') }}</span>
                      <span class="fin-step__op">BASE</span>
                    </div>
                    <p class="fin-step__val">{{ formatAmount(guildReport.economy.split_gross_loot ?? 0) }}</p>
                    <p class="fin-step__sub">
                      {{
                        t('bank.finance.grossLootDetail', {
                          count: guildReport.economy.split_completed_count ?? 0,
                        })
                      }}
                    </p>
                  </div>

                  <div class="fin-step">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.bagsSilver') }}</span>
                      <span class="fin-step__op">+</span>
                    </div>
                    <p class="fin-step__val">+{{ formatAmount(guildReport.economy.split_bags_total ?? 0) }}</p>
                    <p class="fin-step__sub">{{ t('bank.finance.bagsSilverDetail') }}</p>
                  </div>

                  <div class="fin-step fin-step--deduct">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.repairSpent') }}</span>
                      <span class="fin-step__op">−</span>
                    </div>
                    <p class="fin-step__val" style="color: var(--color-warning)">
                      −{{ formatAmount(guildReport.economy.split_repair_total ?? 0) }}
                    </p>
                    <p class="fin-step__sub">{{ repairToGrossPct() }}% {{ t('bank.finance.grossLoot') }}</p>
                  </div>

                  <div class="fin-step">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.preTaxPool') }}</span>
                      <span class="fin-step__op">=</span>
                    </div>
                    <p class="fin-step__val">{{ formatAmount(guildReport.economy.split_completed) }}</p>
                    <p class="fin-step__sub">{{ t('bank.finance.preTaxPoolDetail') }}</p>
                  </div>

                  <div class="fin-step fin-step--highlight">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.guildTaxEarned') }}</span>
                      <span class="fin-step__op">{{ guildReport.economy.split_avg_fee_pct ?? 0 }}%</span>
                    </div>
                    <p class="fin-step__val" style="color: var(--color-success)">
                      +{{ formatAmount(guildReport.economy.split_tax_total ?? 0) }}
                    </p>
                    <p class="fin-step__sub">
                      {{ t('bank.finance.taxRegearCoverage') }}: {{ taxToRegearCoveragePct() }}%
                    </p>
                  </div>

                  <div class="fin-step fin-step--member">
                    <div class="fin-step__head">
                      <span class="fin-step__label">{{ t('bank.finance.memberNetDistributed') }}</span>
                      <span class="fin-step__op">{{ memberShareOfPoolPct() }}%</span>
                    </div>
                    <p class="fin-step__val" style="color: var(--color-primary)">
                      {{ formatAmount(guildReport.economy.split_net_distributed ?? 0) }}
                    </p>
                    <p class="fin-step__sub">
                      {{ t('bank.finance.memberNetDistributedDetail', { pct: memberShareOfPoolPct() }) }}
                    </p>
                  </div>
                </div>

                @if (totalGrossPlusBags() > 0) {
                  <div class="fin-bar-stack">
                    <div class="fin-bar-track" role="img" [attr.aria-label]="t('bank.finance.pipelineTitle')">
                      <div
                        class="fin-bar-seg"
                        [style.inline-size.%]="pipelineSharePct(guildReport.economy.split_repair_total ?? 0)"
                        style="background: var(--color-warning)"
                      ></div>
                      <div
                        class="fin-bar-seg"
                        [style.inline-size.%]="pipelineSharePct(guildReport.economy.split_tax_total ?? 0)"
                        style="background: var(--color-success)"
                      ></div>
                      <div
                        class="fin-bar-seg"
                        [style.inline-size.%]="pipelineSharePct(guildReport.economy.split_net_distributed ?? 0)"
                        style="background: var(--color-primary)"
                      ></div>
                    </div>
                    <div class="fin-bar-legend">
                      <span class="fin-bar-legend__item">
                        <span class="fin-bar-legend__dot" style="background: var(--color-warning)"></span>
                        {{ t('bank.finance.repairSpent') }}:
                        <strong class="mono">{{ formatCompact(guildReport.economy.split_repair_total ?? 0) }}</strong>
                        ({{ pipelineSharePct(guildReport.economy.split_repair_total ?? 0) }}%)
                      </span>
                      <span class="fin-bar-legend__item">
                        <span class="fin-bar-legend__dot" style="background: var(--color-success)"></span>
                        {{ t('bank.finance.guildTaxEarned') }}:
                        <strong class="mono">{{ formatCompact(guildReport.economy.split_tax_total ?? 0) }}</strong>
                        ({{ pipelineSharePct(guildReport.economy.split_tax_total ?? 0) }}%)
                      </span>
                      <span class="fin-bar-legend__item">
                        <span class="fin-bar-legend__dot" style="background: var(--color-primary)"></span>
                        {{ t('bank.finance.memberNetDistributed') }}:
                        <strong class="mono">{{ formatCompact(guildReport.economy.split_net_distributed ?? 0) }}</strong>
                        ({{ pipelineSharePct(guildReport.economy.split_net_distributed ?? 0) }}%)
                      </span>
                    </div>
                  </div>
                }
              </article>

              <div class="fin-grid">
                <article class="fin-card">
                  <header class="fin-card__head">
                    <div>
                      <h3 class="fin-card__title">{{ t('bank.finance.splitEconomicsChartTitle') }}</h3>
                      <p class="fin-card__sub">{{ t('bank.finance.splitEconomicsChartSub') }}</p>
                    </div>
                    <span class="fin-card__badge">
                      {{ formatCompact(guildReport.economy.split_tax_total ?? 0) }} Tax
                    </span>
                  </header>
                  @if (hasTrends()) {
                    <app-chart
                      [option]="splitEconomicsOption()"
                      height="17rem"
                      [stale]="busy()"
                      [label]="t('bank.finance.splitEconomicsChartTitle')"
                      [tableHead]="splitEconomicsTableHead()"
                      [tableRows]="splitEconomicsTableRows()"
                    />
                  } @else {
                    <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                  }
                </article>

                <article class="fin-card">
                  <header class="fin-card__head">
                    <div>
                      <h3 class="fin-card__title">{{ t('bank.finance.taxVsRegearChartTitle') }}</h3>
                      <p class="fin-card__sub">{{ t('bank.finance.taxVsRegearChartSub') }}</p>
                    </div>
                    <span class="fin-card__badge">{{ taxToRegearCoveragePct() }}%</span>
                  </header>
                  @if (hasTrends()) {
                    <app-chart
                      [option]="taxVsRegearOption()"
                      height="17rem"
                      [stale]="busy()"
                      [label]="t('bank.finance.taxVsRegearChartTitle')"
                      [tableHead]="taxVsRegearTableHead()"
                      [tableRows]="taxVsRegearTableRows()"
                    />
                  } @else {
                    <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                  }
                </article>
              </div>
            </section>
          }

          <!-- ============ 3. Silver flow in the selected window ============ -->
          @if (activeSection() === 'all' || activeSection() === 'flow') {
            <section class="fin-section" [attr.aria-label]="t('bank.finance.flowTitle')">
              <header class="fin-section__head">
                <div>
                  <h2 class="fin-section__title">
                    <span class="fin-section__icon">
                      <app-icon name="activity" size="0.9375rem" />
                    </span>
                    {{ t('bank.finance.flowTitle') }}
                    <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="fin-section__sub">{{ t('bank.finance.flowDescription') }}</p>
                </div>
              </header>

              <div class="fin-kpis">
                @for (kpi of flowKpis(); track kpi.key) {
                  @if (kpi.link; as link) {
                    <a
                      class="fin-kpi"
                      [class]="'fin-kpi fin-kpi--' + kpi.tone"
                      [routerLink]="link[0]"
                      [queryParams]="link[1]"
                    >
                      <ng-container
                        *ngTemplateOutlet="kpiBody; context: { $implicit: kpi, linked: true }"
                      />
                    </a>
                  } @else {
                    <div class="fin-kpi" [class]="'fin-kpi fin-kpi--' + kpi.tone">
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
                      <h3 class="fin-card__title">{{ flowCardTitle() }}</h3>
                      <p class="fin-card__sub">{{ flowCardDescription() }}</p>
                    </div>
                    <span class="fin-card__badge">
                      {{ avgLootBadgeLabel() }} {{ formatCompact(avgLoot()) }}
                    </span>
                  </header>
                  @if (hasTrends()) {
                    <app-chart
                      [option]="flowOption()"
                      height="19rem"
                      [stale]="busy()"
                      [label]="flowCardTitle()"
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
                      <h3 class="fin-card__title">{{ netCardTitle() }}</h3>
                      <p class="fin-card__sub">{{ netCardDescription() }}</p>
                    </div>
                    <span class="fin-card__badge">
                      {{ avgNetBadgeLabel() }} {{ formatSigned(avgNet()) }}
                    </span>
                  </header>
                  @if (hasTrends()) {
                    <app-chart
                      [option]="netOption()"
                      height="16rem"
                      [stale]="busy()"
                      [label]="netCardTitle()"
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
          }

          <!-- ============ 4. Losses and recovery ============ -->
          @if (activeSection() === 'all' || activeSection() === 'combat') {
            <section class="fin-section" [attr.aria-label]="t('bank.finance.combatTitle')">
              <header class="fin-section__head">
                <div>
                  <h2 class="fin-section__title">
                    <span class="fin-section__icon">
                      <app-icon name="shield" size="0.9375rem" />
                    </span>
                    {{ t('bank.finance.combatTitle') }}
                    <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="fin-section__sub">{{ t('bank.finance.combatDescription') }}</p>
                </div>
              </header>

              <div class="fin-kpis">
                @for (kpi of combatKpis(); track kpi.key) {
                  <div class="fin-kpi" [class]="'fin-kpi fin-kpi--' + kpi.tone">
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
                      <h3 class="fin-card__title">{{ activityCardTitle() }}</h3>
                      <p class="fin-card__sub">{{ activityCardDescription() }}</p>
                    </div>
                  </header>
                  @if (hasTrends()) {
                    <app-chart
                      [option]="activityOption()"
                      height="17rem"
                      [stale]="busy()"
                      [label]="activityCardTitle()"
                      [tableHead]="activityTableHead()"
                      [tableRows]="activityTableRows()"
                    />
                  } @else {
                    <p class="fin-empty">{{ t('bank.finance.noChartData') }}</p>
                  }
                </article>
              </div>
            </section>
          }
        } @else {
          <p class="fin-note">{{ t('bank.finance.reportPermission') }}</p>
        }

        <!-- ============ 5. Where money comes from and goes — whole ledger ============ -->
        @if (activeSection() === 'all' || activeSection() === 'origin') {
          <section class="fin-section" [attr.aria-label]="t('bank.finance.originTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <span class="fin-section__icon">
                    <app-icon name="scan" size="0.9375rem" />
                  </span>
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
        }

        <!-- ============ 6. Per-member ledger — every figure traceable to a member ============ -->
        @if ((activeSection() === 'all' || activeSection() === 'members') && allMemberRows().length > 0) {
          <section class="fin-section" [attr.aria-label]="t('bank.finance.memberLedgerTitle')">
            <header class="fin-section__head">
              <div>
                <h2 class="fin-section__title">
                  <span class="fin-section__icon">
                    <app-icon name="users" size="0.9375rem" />
                  </span>
                  {{ t('bank.finance.memberLedgerTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                </h2>
                <p class="fin-section__sub">{{ t('bank.finance.memberLedgerDescription') }}</p>
              </div>
              <div class="fin-table-controls">
                <input
                  type="search"
                  class="input input--sm fin-search"
                  [placeholder]="t('bank.finance.searchMemberPlaceholder')"
                  [value]="memberSearch()"
                  (input)="onMemberSearch($event)"
                />
                <p class="fin-meta">
                  {{ t('bank.finance.membersShown', { count: memberRows().length }) }}
                </p>
              </div>
            </header>

            <div class="fin-table-wrap" [class.fin-stale]="busy()">
              <table class="fin-table">
                <caption class="sr-only">
                  {{ t('bank.finance.memberLedgerTitle') }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{{ t('bank.finance.member') }}</th>
                    <th scope="col">{{ t('bank.finance.splitEarnings') }}</th>
                    <th scope="col">{{ t('bank.finance.regearSilver') }}</th>
                    <th scope="col">{{ t('bank.finance.totalReceived') }}</th>
                    <th scope="col">{{ t('bank.finance.silverLost') }}</th>
                    <th scope="col">{{ t('bank.finance.netCombatBalance') }}</th>
                    <th scope="col">{{ t('bank.finance.bankPending') }}</th>
                    <th scope="col">{{ t('bank.finance.siphoned') }}</th>
                    <th scope="col">{{ t('common.actions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of memberRows(); track row.user_id) {
                    <tr>
                      <th scope="row">
                        <div class="fin-member-cell">
                          <span>{{ row.username }}</span>
                          @if (row.albion_name && row.albion_name !== row.username) {
                            <span class="fin-member-cell__sub">{{ row.albion_name }}</span>
                          }
                        </div>
                      </th>
                      <td>{{ formatAmount(row.split_earnings) }}</td>
                      <td>{{ formatAmount(row.regear_silver) }}</td>
                      <td class="fin-val--pos">
                        {{ formatAmount(row.split_earnings + row.regear_silver) }}
                      </td>
                      <td>{{ formatAmount(row.silver_lost) }}</td>
                      <td
                        [class.fin-val--pos]="row.split_earnings + row.regear_silver - row.silver_lost >= 0"
                        [class.fin-val--neg]="row.split_earnings + row.regear_silver - row.silver_lost < 0"
                      >
                        {{ formatSigned(row.split_earnings + row.regear_silver - row.silver_lost) }}
                      </td>
                      <td [class.fin-val--warn]="row.bank_pending > 0">
                        {{ formatAmount(row.bank_pending) }}
                      </td>
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
        <div class="fin-kpi__title-group">
          <span class="fin-kpi__icon" [class]="'fin-kpi__icon fin-kpi__icon--' + kpi.tone">
            <app-icon [name]="kpi.icon" size="0.8125rem" />
          </span>
          <p class="fin-kpi__label">{{ kpi.label }}</p>
        </div>
        <div class="fin-kpi__badges">
          @if (kpi.badge; as badge) {
            <span class="fin-kpi__pill">{{ badge }}</span>
          }
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
      </div>
      <p class="fin-kpi__value" [class]="'fin-kpi__value--' + kpi.tone">{{ kpi.value }}</p>
      <div class="fin-kpi__foot">
        <p class="fin-kpi__detail">{{ kpi.detail }}</p>
        @if (linked) {
          <span class="fin-kpi__cta">
            {{ t('bank.finance.viewTransactions') }}
            <app-icon name="chevron-right" size="0.75rem" />
          </span>
        }
      </div>
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
  protected readonly granularity = signal<'day' | 'week'>('day');
  protected readonly activeSection = signal<SectionTabId>('all');
  protected readonly memberSearch = signal('');
  protected readonly customFrom = signal(toDateInput(new Date(Date.now() - 30 * MS_PER_DAY)));
  protected readonly customTo = signal(toDateInput(new Date()));

  /** True while any fetch is in flight; charts hold their last render instead of flashing. */
  protected readonly busy = computed(() => this.loading() || this.refreshing());

  protected readonly today = computed(() => toDateInput(new Date()));

  protected readonly sectionTabs = computed<ReadonlyArray<{ id: SectionTabId; label: string; icon: IconName }>>(() => [
    { id: 'all', label: this.t('bank.finance.navAll'), icon: 'dashboard' },
    { id: 'taxes', label: this.t('bank.finance.navTaxes'), icon: 'coins' },
    { id: 'position', label: this.t('bank.finance.navPosition'), icon: 'bank' },
    { id: 'flow', label: this.t('bank.finance.navFlow'), icon: 'activity' },
    { id: 'combat', label: this.t('bank.finance.navCombat'), icon: 'shield' },
    { id: 'origin', label: this.t('bank.finance.navOrigin'), icon: 'scan' },
    { id: 'members', label: this.t('bank.finance.navMembers'), icon: 'users' },
  ]);

  protected readonly periodOptions = computed<ViewToggleOption[]>(() => [
    { id: '7', label: this.t('bank.finance.period7') },
    { id: '30', label: this.t('bank.finance.period30') },
    { id: '90', label: this.t('bank.finance.period90') },
    { id: 'custom', label: this.t('bank.finance.periodCustom'), icon: 'calendar' },
  ]);

  protected readonly granularityOptions = computed<ViewToggleOption[]>(() => [
    { id: 'day', label: this.t('bank.finance.granularityDay') },
    { id: 'week', label: this.t('bank.finance.granularityWeek') },
  ]);

  protected readonly rangeDays = computed(() => this.resolveRange()?.days ?? 30);

  protected readonly trends = computed<readonly TrendBucket[]>(() => this.report()?.trends ?? []);
  protected readonly hasTrends = computed(() => this.trends().length > 0);

  protected readonly trackedWindowLabel = computed(() => {
    const count = this.trends().length;
    return this.granularity() === 'day'
      ? this.t('bank.finance.daysTracked', { count })
      : this.t('bank.finance.weeksTracked', { count });
  });

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

  protected onGranularityChange(id: string): void {
    this.granularity.set(id as 'day' | 'week');
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

  protected onMemberSearch(event: Event): void {
    this.memberSearch.set((event.target as HTMLInputElement).value);
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

    const granularity = this.granularity();
    const [bankResult, reportResult, previousResult] = await Promise.allSettled([
      firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary')),
      firstValueFrom(
        this.api.get<GuildReport>('api/intel/report', {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          granularity,
        }),
      ),
      firstValueFrom(
        this.api.get<GuildReport>('api/intel/report', {
          from: range.previousFrom.toISOString(),
          to: range.previousTo.toISOString(),
          granularity,
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
        icon: 'alert',
        badge: `${bank.outstanding_count}`,
        link: ['/admin/transactions', { status: 'pending' }],
      },
      {
        key: 'requested',
        label: this.t('bank.finance.awaitingApproval'),
        value: this.formatAmount(bank.requested_total),
        detail: this.t('bank.finance.requestedWithdrawals', { count: bank.requested_count }),
        tone: bank.requested_count > 0 ? 'warning' : 'default',
        icon: 'bell',
        badge: `${bank.requested_count}`,
        link: ['/admin/transactions', { status: 'requested' }],
      },
      {
        key: 'paid',
        label: this.t('bank.finance.paidOut'),
        value: this.formatAmount(bank.paid_out_total),
        detail: this.t('bank.finance.settledPayouts', { count: bank.paid_out_count }),
        tone: 'success',
        icon: 'check',
        badge: `${bank.paid_out_count}`,
        link: ['/admin/transactions', { status: 'withdrawn' }],
      },
      {
        key: 'donated',
        label: this.t('bank.finance.donatedBack'),
        value: this.formatAmount(bank.donated_total),
        detail: this.t('bank.finance.memberDonations', { count: bank.donated_count }),
        tone: 'default',
        icon: 'trophy',
        badge: `${bank.donated_count}`,
        link: ['/admin/transactions', { status: 'donated' }],
      },
    ];
  });

  /**
   * Split economics, guild tax earnings, repair costs, and guild treasury balance.
   */
  protected readonly taxAndRepairKpis = computed<FinanceKpi[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    const previous = this.previousReport()?.economy;
    const taxTotal = economy.split_tax_total ?? 0;
    const prevTaxTotal = previous?.split_tax_total;
    const repairTotal = economy.split_repair_total ?? 0;
    const prevRepairTotal = previous?.split_repair_total;
    const grossLoot = economy.split_gross_loot ?? economy.split_completed;
    const prevGrossLoot = previous?.split_gross_loot ?? previous?.split_completed;
    const netDistributed = economy.split_net_distributed ?? economy.split_completed;
    const prevNetDistributed = previous?.split_net_distributed ?? previous?.split_completed;
    const treasuryNet =
      economy.guild_treasury_net ??
      taxTotal + (economy.bank_donated ?? 0) - economy.regear_paid - economy.outflow_other;
    const prevTreasuryNet = previous
      ? (previous.guild_treasury_net ??
        (previous.split_tax_total ?? 0) +
          (previous.bank_donated ?? 0) -
          previous.regear_paid -
          previous.outflow_other)
      : undefined;

    return [
      {
        key: 'guild_tax',
        label: this.t('bank.finance.guildTaxEarned'),
        value: this.formatAmount(taxTotal),
        detail: this.t('bank.finance.guildTaxEarnedDetail', {
          pct: economy.split_avg_fee_pct ?? 0,
          pending: this.formatCompact(economy.split_pending_tax_total ?? 0),
        }),
        tone: 'success',
        icon: 'percent',
        badge: `${economy.split_avg_fee_pct ?? 0}% fee`,
        delta: this.buildDelta(taxTotal, prevTaxTotal, true),
        link: ['/splits', {}],
      },
      {
        key: 'repair_spent',
        label: this.t('bank.finance.repairSpent'),
        value: this.formatAmount(repairTotal),
        detail: this.t('bank.finance.repairSpentDetail', {
          pct: this.repairToGrossPct(),
          pending: this.formatCompact(economy.split_pending_repair_total ?? 0),
        }),
        tone: repairTotal > 0 ? 'warning' : 'default',
        icon: 'hammer',
        badge: `${this.repairToGrossPct()}%`,
        delta: this.buildDelta(repairTotal, prevRepairTotal, false),
        link: ['/splits', {}],
      },
      {
        key: 'gross_loot',
        label: this.t('bank.finance.grossLoot'),
        value: this.formatAmount(grossLoot),
        detail: this.t('bank.finance.grossLootDetail', {
          count: economy.split_completed_count ?? 0,
        }),
        tone: 'default',
        icon: 'package',
        badge: `+${this.formatCompact(economy.split_bags_total ?? 0)} bags`,
        delta: this.buildDelta(grossLoot, prevGrossLoot, true),
      },
      {
        key: 'member_net',
        label: this.t('bank.finance.memberNetDistributed'),
        value: this.formatAmount(netDistributed),
        detail: this.t('bank.finance.memberNetDistributedDetail', {
          pct: this.memberShareOfPoolPct(),
        }),
        tone: 'default',
        icon: 'users',
        badge: `${this.memberShareOfPoolPct()}%`,
        delta: this.buildDelta(netDistributed, prevNetDistributed, true),
      },
      {
        key: 'treasury_net',
        label: this.t('bank.finance.treasuryNet'),
        value: this.formatSigned(treasuryNet),
        detail: this.t('bank.finance.treasuryNetDetail', {
          tax: this.formatCompact(taxTotal),
          donated: this.formatCompact(economy.bank_donated ?? 0),
          regear: this.formatCompact(economy.regear_paid),
        }),
        tone: treasuryNet >= 0 ? 'success' : 'danger',
        icon: 'bank',
        delta: this.buildDelta(treasuryNet, prevTreasuryNet, true),
      },
      {
        key: 'tax_regear_cov',
        label: this.t('bank.finance.taxRegearCoverage'),
        value: `${this.taxToRegearCoveragePct()}%`,
        detail: this.t('bank.finance.taxRegearCoverageDetail'),
        tone: this.taxToRegearCoveragePct() >= 100 ? 'success' : 'warning',
        icon: 'shield',
        badge: `${this.formatCompact(taxTotal)} / ${this.formatCompact(economy.regear_paid)}`,
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
        detail: this.granularity() === 'day'
          ? this.t('bank.finance.perDay', { value: this.formatCompact(this.avgLoot()) })
          : this.t('bank.finance.perWeek', { value: this.formatCompact(this.avgLoot()) }),
        tone: 'success',
        icon: 'coins',
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
        icon: 'arrow-right',
        delta: this.buildDelta(economy.outflow_total, previous?.outflow_total, false),
      },
      {
        key: 'net',
        label: this.t('bank.finance.netCashFlow'),
        value: this.formatSigned(economy.net),
        detail: this.t('bank.finance.netDetail'),
        tone: economy.net >= 0 ? 'success' : 'danger',
        icon: 'activity',
        delta: this.buildDelta(economy.net, previous?.net, true),
      },
      {
        key: 'pending',
        label: this.t('bank.finance.bankPending'),
        value: this.formatAmount(economy.bank_pending),
        detail: this.t('bank.finance.bankPendingDetail'),
        tone: 'warning',
        icon: 'alert',
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
        icon: 'swords',
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
        icon: 'shield',
        delta: this.buildDelta(report.economy.regear_paid, previous?.economy.regear_paid, true),
      },
      {
        key: 'coverage',
        label: this.t('bank.finance.regearCoverage'),
        value: `${this.regearCoverageRatio()}%`,
        detail: this.t('bank.finance.coverageDetail'),
        tone: this.regearCoverageRatio() >= 80 ? 'success' : 'default',
        icon: 'check',
      },
      {
        key: 'fame',
        label: this.t('bank.finance.fameEfficiency'),
        value: this.formatCompact(report.economy.fame_per_million_lost),
        detail: this.t('bank.finance.fameEfficiencyDetail'),
        tone: 'default',
        icon: 'zap',
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

  protected readonly totalGrossPlusBags = computed(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return 0;
    }
    return (economy.split_gross_loot ?? 0) + (economy.split_bags_total ?? 0);
  });

  protected readonly repairToGrossPct = computed(() => {
    const economy = this.report()?.economy;
    const gross = economy?.split_gross_loot ?? 0;
    const repair = economy?.split_repair_total ?? 0;
    if (gross <= 0) {
      return 0;
    }
    return Math.round((repair / gross) * 1000) / 10;
  });

  protected readonly memberShareOfPoolPct = computed(() => {
    const economy = this.report()?.economy;
    const pool = economy?.split_completed ?? 0;
    const net = economy?.split_net_distributed ?? 0;
    if (pool <= 0) {
      return 0;
    }
    return Math.round((net / pool) * 1000) / 10;
  });

  protected readonly taxToRegearCoveragePct = computed(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return 0;
    }
    const tax = economy.split_tax_total ?? 0;
    const regear = economy.regear_paid;
    if (regear <= 0) {
      return tax > 0 ? 100 : 0;
    }
    return Math.min(999, Math.round((tax / regear) * 100));
  });

  protected readonly avgCompletedSplitValue = computed(() => {
    const economy = this.report()?.economy;
    const count = economy?.split_completed_count ?? 0;
    if (!economy || count <= 0) {
      return 0;
    }
    return Math.round(economy.split_completed / count);
  });

  protected pipelineSharePct(amount: number): number {
    const total = this.totalGrossPlusBags();
    if (total <= 0 || amount <= 0) {
      return 0;
    }
    return Math.round((amount / total) * 1000) / 10;
  }

  protected readonly avgLoot = computed(() => {
    const trends = this.trends();
    if (trends.length === 0) {
      return 0;
    }
    return Math.round(trends.reduce((acc, bucket) => acc + bucket.loot_in, 0) / trends.length);
  });

  protected readonly avgNet = computed(() => {
    const trends = this.trends();
    if (trends.length === 0) {
      return 0;
    }
    const total = trends.reduce((acc, bucket) => acc + (bucket.loot_in - bucket.outflow), 0);
    return Math.round(total / trends.length);
  });

  protected readonly avgWeeklyLoot = this.avgLoot;
  protected readonly avgWeeklyNet = this.avgNet;

  protected readonly flowCardTitle = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.dailyFlow')
      : this.t('bank.finance.weeklyFlow'),
  );

  protected readonly flowCardDescription = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.dailyFlowDescription')
      : this.t('bank.finance.weeklyFlowDescription'),
  );

  protected readonly avgLootBadgeLabel = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.avgDailyLoot')
      : this.t('bank.finance.avgWeeklyLoot'),
  );

  protected readonly netCardTitle = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.netDaily')
      : this.t('bank.finance.netWeekly'),
  );

  protected readonly netCardDescription = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.netDailyDescription')
      : this.t('bank.finance.netWeeklyDescription'),
  );

  protected readonly avgNetBadgeLabel = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.avgDailyNet')
      : this.t('bank.finance.avgWeeklyNet'),
  );

  protected readonly activityCardTitle = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.dailyActivity')
      : this.t('bank.finance.weeklyActivity'),
  );

  protected readonly activityCardDescription = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.dailyActivityDescription')
      : this.t('bank.finance.weeklyActivityDescription'),
  );

  protected readonly timeColumnLabel = computed(() =>
    this.granularity() === 'day'
      ? this.t('bank.finance.day')
      : this.t('bank.finance.week'),
  );

  protected readonly regearCoverageRatio = computed(() => {
    const trends = this.trends();
    const lost = trends.reduce((acc, bucket) => acc + (bucket.silver_lost || 0), 0);
    if (lost <= 0) {
      return 0;
    }
    const paid = trends.reduce((acc, bucket) => acc + (bucket.regear_paid || 0), 0);
    return Math.min(999, Math.round((paid / lost) * 100));
  });

  protected readonly allMemberRows = computed<readonly ReportMemberRow[]>(() => {
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
      .sort((a, b) => b.split_earnings + b.regear_silver - (a.split_earnings + a.regear_silver));
  });

  protected readonly memberRows = computed<readonly ReportMemberRow[]>(() => {
    const query = this.memberSearch().trim().toLowerCase();
    const rows = this.allMemberRows();
    const filtered = query
      ? rows.filter(
          (r) =>
            r.username.toLowerCase().includes(query) ||
            (r.albion_name?.toLowerCase().includes(query) ?? false),
        )
      : rows;
    return filtered.slice(0, 30);
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

  protected readonly splitEconomicsOption = computed<EChartsOption>(() => {
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
          name: this.t('bank.finance.memberNetDistributed'),
          type: 'bar',
          stack: 'split',
          data: trends.map((b) => b.net_distributed ?? b.loot_in),
          itemStyle: { color: palette.lootIn },
          barMaxWidth: 22,
        },
        {
          name: this.t('bank.finance.guildTaxEarned'),
          type: 'bar',
          stack: 'split',
          data: trends.map((b) => b.tax_in ?? 0),
          itemStyle: { color: palette.regearPaid },
          barMaxWidth: 22,
        },
        {
          name: this.t('bank.finance.repairSpent'),
          type: 'bar',
          stack: 'split',
          data: trends.map((b) => b.repair_cost ?? 0),
          itemStyle: { color: palette.silverLost, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 22,
        },
      ],
    };
  });

  protected readonly taxVsRegearOption = computed<EChartsOption>(() => {
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
          name: this.t('bank.finance.guildTaxEarned'),
          type: 'bar',
          data: trends.map((b) => b.tax_in ?? 0),
          itemStyle: { color: palette.regearPaid, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
          barGap: '18%',
          barCategoryGap: '40%',
        },
        {
          name: this.t('bank.finance.regearPaid'),
          type: 'bar',
          data: trends.map((b) => Math.abs(b.regear_paid || 0)),
          itemStyle: { color: palette.outflow, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
      ],
    };
  });

  protected readonly flowOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();
    const surface = this.chrome().surface;
    const zoomable = trends.length > 10;

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

  protected readonly splitEconomicsTableHead = computed(() => [
    this.timeColumnLabel(),
    this.t('bank.finance.grossLoot'),
    this.t('bank.finance.repairSpent'),
    this.t('bank.finance.guildTaxEarned'),
    this.t('bank.finance.memberNetDistributed'),
  ]);

  protected readonly splitEconomicsTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      this.formatAmount(bucket.gross_loot ?? bucket.loot_in),
      this.formatAmount(bucket.repair_cost ?? 0),
      this.formatAmount(bucket.tax_in ?? 0),
      this.formatAmount(bucket.net_distributed ?? bucket.loot_in),
    ]),
  );

  protected readonly taxVsRegearTableHead = computed(() => [
    this.timeColumnLabel(),
    this.t('bank.finance.guildTaxEarned'),
    this.t('bank.finance.regearPaid'),
    this.t('bank.finance.netResult'),
  ]);

  protected readonly taxVsRegearTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => {
      const tax = bucket.tax_in ?? 0;
      const regear = Math.abs(bucket.regear_paid || 0);
      return [
        this.formatWeek(bucket.week_start),
        this.formatAmount(tax),
        this.formatAmount(regear),
        this.formatSigned(tax - regear),
      ];
    }),
  );

  protected readonly flowTableHead = computed(() => [
    this.timeColumnLabel(),
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
    this.timeColumnLabel(),
    this.t('bank.finance.netResult'),
  ]);

  protected readonly netTableRows = computed<ChartTableRow[]>(() =>
    this.trends().map((bucket) => [
      this.formatWeek(bucket.week_start),
      this.formatSigned(bucket.loot_in - bucket.outflow),
    ]),
  );

  protected readonly lossTableHead = computed(() => [
    this.timeColumnLabel(),
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
    this.timeColumnLabel(),
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
      rows.push(line(this.t('bank.finance.taxesTitle')));
      rows.push(line(this.t('common.label'), this.t('common.amount')));
      rows.push(line(this.t('bank.finance.grossLoot'), report.economy.split_gross_loot ?? 0));
      rows.push(line(this.t('bank.finance.bagsSilver'), report.economy.split_bags_total ?? 0));
      rows.push(line(this.t('bank.finance.repairSpent'), report.economy.split_repair_total ?? 0));
      rows.push(line(this.t('bank.finance.preTaxPool'), report.economy.split_completed));
      rows.push(line(this.t('bank.finance.guildTaxEarned'), report.economy.split_tax_total ?? 0));
      rows.push(
        line(
          this.t('bank.finance.memberNetDistributed'),
          report.economy.split_net_distributed ?? 0,
        ),
      );
      rows.push(
        line(this.t('bank.finance.treasuryNet'), report.economy.guild_treasury_net ?? 0),
      );
      rows.push('');

      rows.push(line(this.t('bank.finance.weeklyFlow')));
      rows.push(
        line(
          this.t('bank.finance.week'),
          this.t('bank.finance.grossLoot'),
          this.t('bank.finance.repairSpent'),
          this.t('bank.finance.guildTaxEarned'),
          this.t('bank.finance.memberNetDistributed'),
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
            bucket.gross_loot ?? bucket.loot_in,
            bucket.repair_cost ?? 0,
            bucket.tax_in ?? 0,
            bucket.net_distributed ?? bucket.loot_in,
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
          this.t('bank.finance.totalReceived'),
          this.t('bank.finance.silverLost'),
          this.t('bank.finance.netCombatBalance'),
          this.t('bank.finance.bankPending'),
          this.t('bank.finance.siphoned'),
        ),
      );
      for (const member of this.allMemberRows()) {
        rows.push(
          line(
            member.username,
            member.split_earnings,
            member.regear_silver,
            member.split_earnings + member.regear_silver,
            member.silver_lost,
            member.split_earnings + member.regear_silver - member.silver_lost,
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

    const blob = new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
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
    return this.translate.locale();
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
