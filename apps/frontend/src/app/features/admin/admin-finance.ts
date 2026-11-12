import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
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
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { DataTableFooterCell } from '../../shared/components/data-table/data-table-footer-cell';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import type { MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import {
  Stat,
  type StatTone,
  SummaryBand,
} from '../../shared/components/summary-band/summary-band';

/** Preset windows, plus the escape hatch to arbitrary dates. */
type PeriodId = '7' | '30' | '90' | 'custom';
type SectionTabId = 'all' | 'position' | 'taxes' | 'flow' | 'combat' | 'origin' | 'members';
type OriginView = 'sources' | 'destinations' | 'types';

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

/** One figure of a summary band, already formatted. */
interface FinanceStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Context line: the count, the split, or the state in words. */
  readonly detail: string;
  readonly tone: StatTone;
  /** Movement against the previous window, arrow included ("▲ +12%"). */
  readonly delta?: string;
}

/** One row of the ledger breakdown table (sources, destinations or transaction types). */
interface OriginRow {
  readonly key: string;
  readonly label: string;
  readonly amount: number;
  readonly entries: number;
  /** Share of the absolute total, 0 to 1. */
  readonly share: number;
}

/** Minimal shape of an ECharts tooltip callback payload. */
interface TooltipParam {
  readonly seriesName?: string;
  readonly name?: string;
  readonly axisValueLabel?: string;
  readonly value?: unknown;
  readonly color?: string;
}

const ORIGIN_COLUMNS: readonly DataTableColumn<OriginRow>[] = [
  { key: 'label', label: 'common.label' },
  {
    key: 'amount',
    label: 'common.amount',
    align: 'right',
    sortable: true,
    accessor: (row) => row.amount,
    comparator: (a, b) => a.amount - b.amount,
  },
  {
    key: 'entries',
    label: 'bank.finance.ledgerEntriesShort',
    align: 'right',
    sortable: true,
    accessor: (row) => row.entries,
    comparator: (a, b) => a.entries - b.entries,
  },
  {
    key: 'share',
    label: 'bank.finance.share',
    align: 'right',
    accessor: (row) => row.share,
  },
];

const MEMBER_COLUMNS: readonly DataTableColumn<ReportMemberRow>[] = [
  {
    key: 'member',
    label: 'bank.finance.member',
    sortable: true,
    searchable: true,
    accessor: (row) => `${row.username} ${row.albion_name ?? ''}`,
    comparator: (a, b) => a.username.localeCompare(b.username),
  },
  {
    key: 'split_earnings',
    label: 'bank.finance.splitEarnings',
    align: 'right',
    sortable: true,
    accessor: (row) => row.split_earnings,
    comparator: (a, b) => a.split_earnings - b.split_earnings,
  },
  {
    key: 'regear_silver',
    label: 'bank.finance.regearSilver',
    align: 'right',
    sortable: true,
    accessor: (row) => row.regear_silver,
    comparator: (a, b) => a.regear_silver - b.regear_silver,
  },
  {
    key: 'received',
    label: 'bank.finance.totalReceived',
    align: 'right',
    sortable: true,
    accessor: (row) => row.split_earnings + row.regear_silver,
    comparator: (a, b) =>
      a.split_earnings + a.regear_silver - (b.split_earnings + b.regear_silver),
  },
  {
    key: 'silver_lost',
    label: 'bank.finance.silverLost',
    align: 'right',
    sortable: true,
    accessor: (row) => row.silver_lost,
    comparator: (a, b) => a.silver_lost - b.silver_lost,
  },
  {
    key: 'net',
    label: 'bank.finance.netCombatBalance',
    align: 'right',
    sortable: true,
    accessor: (row) => row.split_earnings + row.regear_silver - row.silver_lost,
    comparator: (a, b) =>
      a.split_earnings + a.regear_silver - a.silver_lost -
      (b.split_earnings + b.regear_silver - b.silver_lost),
  },
  {
    key: 'bank_pending',
    label: 'bank.finance.bankPending',
    align: 'right',
    sortable: true,
    accessor: (row) => row.bank_pending,
    comparator: (a, b) => a.bank_pending - b.bank_pending,
  },
  {
    key: 'siphoned',
    label: 'bank.finance.siphoned',
    align: 'right',
    sortable: true,
    accessor: (row) => row.siphoned,
    comparator: (a, b) => a.siphoned - b.siphoned,
  },
  { key: 'actions', label: 'common.actions' },
];

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
 * every section says which one it is reading:
 *
 * - `GET /api/bank/admin/summary` is the **whole ledger**, every row ever
 *   written, and ignores the period filter. It answers "what does the bank owe
 *   and what has it settled".
 * - `GET /api/intel/report?from&to` is **window-scoped** silver flow and split
 *   economics. It answers "what happened in this period" (including how much the
 *   guild earned in taxes, how much was spent on repairs, and net payouts), and
 *   is fetched twice — once for the selected window and once for the window
 *   immediately before it, which is what makes period-over-period deltas possible.
 *
 * Each section tab shows one summary band and then one chart or one table.
 */
@Component({
  selector: 'app-admin-finance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    DataTable,
    DataTableCell,
    DataTableFooterCell,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    Stat,
    SummaryBand,
    Tabs,
  ],
  styles: [COMPACT_FEATURE_STYLES, `
    .fin-toolbar {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: var(--card-padding);
    }
    .fin-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem 1.25rem;
    }
    .fin-control {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      min-inline-size: 0;
    }
    .fin-control__label {
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      font-weight: 600;
    }
    .fin-dates {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.5rem;
    }
    .fin-date {
      inline-size: 9.5rem;
    }

    .fin-section {
      display: grid;
      gap: 0.75rem;
      min-inline-size: 0;
    }
    .fin-section__head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.5rem 0.75rem;
    }
    .fin-section__head .section-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .fin-scope {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-badges);
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      font-weight: 500;
    }
    .fin-jump {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
      font-size: var(--ui-text-sm);
    }
    .fin-jump a {
      color: var(--color-primary);
      font-weight: 500;
    }
    .fin-jump a:hover {
      text-decoration: underline;
    }

    .fin-card {
      display: flex;
      flex-direction: column;
      min-inline-size: 0;
      padding: var(--card-padding);
    }
    .fin-card__head {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      margin-block-end: 0.5rem;
    }
    .fin-empty {
      padding: 1.5rem 0;
      text-align: center;
    }
    .fin-stale {
      opacity: 0.55;
      transition: opacity 0.15s ease;
    }

    .fin-val--pos {
      color: var(--color-success);
      font-weight: 600;
    }
    .fin-val--neg {
      color: var(--color-error);
    }
    .fin-val--warn {
      color: var(--color-warning);
      font-weight: 600;
    }
    .fin-member-cell {
      display: flex;
      flex-direction: column;
      gap: 0.0625rem;
    }
    .fin-member-cell__sub {
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
    }
    .fin-member-link {
      color: var(--color-primary);
      font-weight: 500;
    }

    @media (prefers-reduced-motion: reduce) {
      .fin-stale {
        transition: none;
      }
    }
  `],
  template: `
    <app-page-header
      [title]="t('bank.finance.heading')"
      [subtitle]="t('bank.finance.description')"
      [menuItems]="headerMenu()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onHeaderMenu($event)"
    >
      <button type="button" class="btn btn--outline btn--sm" [disabled]="!summary()" (click)="exportCsv()">
        <app-icon name="list" size="0.875rem" />
        {{ t('bank.finance.exportCsv') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <div class="card fin-toolbar">
        <div class="fin-controls">
          <div class="fin-control">
            <span class="fin-control__label">{{ t('bank.finance.periodLabel') }}</span>
            <app-tabs
              variant="segmented"
              [options]="periodOptions()"
              [active]="period()"
              [ariaLabel]="t('bank.finance.periodLabel')"
              (activeChange)="onPeriodChange($event)"
            />
          </div>
          <div class="fin-control">
            <span class="fin-control__label">{{ t('bank.finance.granularityLabel') }}</span>
            <app-tabs
              variant="segmented"
              [options]="granularityOptions()"
              [active]="granularity()"
              [ariaLabel]="t('bank.finance.granularityLabel')"
              (activeChange)="onGranularityChange($event)"
            />
          </div>
        </div>

        @if (period() === 'custom') {
          <div class="fin-dates">
            <label class="filter-field">
              <span class="filter-field__label">{{ t('bank.finance.from') }}</span>
              <input
                class="input input--sm fin-date"
                type="date"
                [value]="customFrom()"
                [max]="customTo()"
                (change)="onCustomFrom($event)"
              />
            </label>
            <label class="filter-field">
              <span class="filter-field__label">{{ t('bank.finance.to') }}</span>
              <input
                class="input input--sm fin-date"
                type="date"
                [value]="customTo()"
                [min]="customFrom()"
                [max]="today()"
                (change)="onCustomTo($event)"
              />
            </label>
          </div>
        }

        <p class="hint" aria-live="polite">
          @if (busy()) {
            {{ t('bank.finance.reloading') }}
          } @else if (report(); as r) {
            <strong>{{ formatDate(r.from) }} → {{ formatDate(r.to) }}</strong>
            · {{ trackedWindowLabel() }}
            · {{ t('bank.finance.vsPrevious', { days: rangeDays() }) }}
          }
        </p>
      </div>

      <app-tabs
        [options]="sectionTabs()"
        [active]="activeSection()"
        [ariaLabel]="t('common.overview')"
        (activeChange)="onSectionChange($event)"
      />

      @if (summary(); as bank) {
        <!-- Bank position: whole ledger, independent of the period -->
        @if (show('position')) {
          <section class="fin-section" aria-labelledby="fin-position-title">
            <header class="fin-section__head">
              <div>
                <h2 class="section-title" id="fin-position-title">
                  {{ t('bank.finance.positionTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeAllTime') }}</span>
                </h2>
                <p class="hint">{{ t('bank.finance.positionDescription') }}</p>
              </div>
            </header>

            <app-summary-band [ariaLabel]="t('bank.finance.positionTitle')">
              @for (stat of positionStats(); track stat.key) {
                <app-stat
                  [label]="stat.label"
                  [value]="stat.value"
                  [hint]="stat.detail"
                  [tone]="stat.tone"
                />
              }
            </app-summary-band>

            <nav class="fin-jump" [attr.aria-label]="t('bank.finance.positionTitle')">
              <a [routerLink]="'/admin/transactions'" [queryParams]="{ status: 'pending' }">{{ t('bank.finance.openLiability') }}</a>
              <a [routerLink]="'/admin/transactions'" [queryParams]="{ status: 'requested' }">{{ t('bank.finance.awaitingApproval') }}</a>
              <a [routerLink]="'/admin/transactions'" [queryParams]="{ status: 'withdrawn' }">{{ t('bank.finance.paidOut') }}</a>
              <a [routerLink]="'/admin/transactions'" [queryParams]="{ status: 'donated' }">{{ t('bank.finance.donatedBack') }}</a>
            </nav>
          </section>
        }

        @if (report()) {
          <!-- Taxes, repairs and split economics in the selected window -->
          @if (show('taxes')) {
            <section class="fin-section" aria-labelledby="fin-taxes-title">
              <header class="fin-section__head">
                <div>
                  <h2 class="section-title" id="fin-taxes-title">
                    {{ t('bank.finance.taxesTitle') }}
                    <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="hint">{{ t('bank.finance.taxesDescription') }}</p>
                </div>
              </header>

              <app-summary-band [ariaLabel]="t('bank.finance.taxesTitle')">
                @for (stat of taxStats(); track stat.key) {
                  <app-stat
                    [label]="stat.label"
                    [value]="stat.value"
                    [hint]="stat.detail"
                    [tone]="stat.tone"
                    [delta]="stat.delta ?? ''"
                  />
                }
              </app-summary-band>

              <nav class="fin-jump" [attr.aria-label]="t('bank.finance.taxesTitle')">
                <a [routerLink]="'/splits'">{{ t('bank.finance.viewSplits') }}</a>
              </nav>

              <article class="card fin-card">
                <header class="fin-card__head">
                  <h3 class="section-title section-title--sm">{{ t('bank.finance.splitEconomicsChartTitle') }}</h3>
                  <p class="hint">{{ t('bank.finance.splitEconomicsChartSub') }}</p>
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
                  <p class="hint fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>
            </section>
          }

          <!-- Silver flow in the selected window -->
          @if (show('flow')) {
            <section class="fin-section" aria-labelledby="fin-flow-title">
              <header class="fin-section__head">
                <div>
                  <h2 class="section-title" id="fin-flow-title">
                    {{ t('bank.finance.flowTitle') }}
                    <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="hint">{{ t('bank.finance.flowDescription') }}</p>
                </div>
              </header>

              <app-summary-band [ariaLabel]="t('bank.finance.flowTitle')">
                @for (stat of flowStats(); track stat.key) {
                  <app-stat
                    [label]="stat.label"
                    [value]="stat.value"
                    [hint]="stat.detail"
                    [tone]="stat.tone"
                    [delta]="stat.delta ?? ''"
                  />
                }
              </app-summary-band>

              <nav class="fin-jump" [attr.aria-label]="t('bank.finance.flowTitle')">
                <a [routerLink]="'/admin/transactions'" [queryParams]="{ status: 'pending' }">{{ t('bank.finance.viewTransactions') }}</a>
              </nav>

              <article class="card fin-card">
                <header class="fin-card__head">
                  <h3 class="section-title section-title--sm">{{ flowCardTitle() }}</h3>
                  <p class="hint">{{ flowCardDescription() }}</p>
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
                  <p class="hint fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>
            </section>
          }

          <!-- Losses and recovery -->
          @if (show('combat')) {
            <section class="fin-section" aria-labelledby="fin-combat-title">
              <header class="fin-section__head">
                <div>
                  <h2 class="section-title" id="fin-combat-title">
                    {{ t('bank.finance.combatTitle') }}
                    <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                  </h2>
                  <p class="hint">{{ t('bank.finance.combatDescription') }}</p>
                </div>
              </header>

              <app-summary-band [ariaLabel]="t('bank.finance.combatTitle')">
                @for (stat of combatStats(); track stat.key) {
                  <app-stat
                    [label]="stat.label"
                    [value]="stat.value"
                    [hint]="stat.detail"
                    [tone]="stat.tone"
                    [delta]="stat.delta ?? ''"
                  />
                }
              </app-summary-band>

              <article class="card fin-card">
                <header class="fin-card__head">
                  <h3 class="section-title section-title--sm">{{ t('bank.finance.lossVsRegear') }}</h3>
                  <p class="hint">{{ t('bank.finance.coverageDetail') }}</p>
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
                  <p class="hint fin-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </article>
            </section>
          }
        } @else {
          <p class="hint">{{ t('bank.finance.reportPermission') }}</p>
        }

        <!-- Ledger breakdown: whole ledger, one table with a view switch -->
        @if (show('origin')) {
          <section class="fin-section" aria-labelledby="fin-origin-title">
            <header class="fin-section__head">
              <div>
                <h2 class="section-title" id="fin-origin-title">
                  {{ t('bank.finance.originTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeAllTime') }}</span>
                </h2>
                <p class="hint">{{ t('bank.finance.originDescription') }}</p>
              </div>
            </header>

            <app-tabs
              variant="segmented"
              [options]="originOptions()"
              [active]="originView()"
              [ariaLabel]="t('bank.finance.breakdownLabel')"
              (activeChange)="onOriginChange($event)"
            />

            <app-data-table
              [columns]="originColumns"
              [rows]="originRows()"
              [loading]="loading()"
              [trackBy]="trackOrigin"
              [syncUrl]="false"
              [hideSearch]="true"
              [hidePageSize]="true"
              [pageSize]="25"
              [ariaLabel]="t('bank.finance.originTitle')"
              emptyIcon="scan"
            >
              <ng-template dataTableCell="label" let-row>{{ row.label }}</ng-template>
              <ng-template dataTableCell="amount" let-row>
                <span class="mono">{{ formatAmount(row.amount) }}</span>
              </ng-template>
              <ng-template dataTableCell="entries" let-row>
                <span class="mono">{{ formatAmount(row.entries) }}</span>
              </ng-template>
              <ng-template dataTableCell="share" let-row>
                <span class="mono">{{ formatPercent(row.share) }}</span>
              </ng-template>
              <ng-template dataTableFooterCell="amount">
                <span class="mono">{{ formatAmount(originTotals().amount) }}</span>
              </ng-template>
              <ng-template dataTableFooterCell="entries">
                <span class="mono">{{ formatAmount(originTotals().entries) }}</span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- Per-member ledger: every figure traceable to a member -->
        @if (report() && show('members')) {
          <section class="fin-section" aria-labelledby="fin-members-title">
            <header class="fin-section__head">
              <div>
                <h2 class="section-title" id="fin-members-title">
                  {{ t('bank.finance.memberLedgerTitle') }}
                  <span class="fin-scope">{{ t('bank.finance.scopeWindow') }}</span>
                </h2>
                <p class="hint">{{ t('bank.finance.memberLedgerDescription') }}</p>
              </div>
            </header>

            <div [class.fin-stale]="busy()">
              <app-data-table
                [columns]="memberColumns"
                [rows]="allMemberRows()"
                [loading]="loading()"
                [trackBy]="trackMember"
                [syncUrl]="false"
                [pageSize]="25"
                [ariaLabel]="t('bank.finance.memberLedgerTitle')"
                [searchPlaceholder]="t('bank.finance.searchMemberPlaceholder')"
                [footerLabel]="t('bank.finance.allMembersTotal')"
                emptyIcon="users"
              >
                <ng-template dataTableCell="member" let-row>
                  <div class="fin-member-cell">
                    <span class="font-medium">{{ row.username }}</span>
                    @if (row.albion_name && row.albion_name !== row.username) {
                      <span class="fin-member-cell__sub">{{ row.albion_name }}</span>
                    }
                  </div>
                </ng-template>
                <ng-template dataTableCell="split_earnings" let-row>
                  <span class="mono">{{ formatAmount(row.split_earnings) }}</span>
                </ng-template>
                <ng-template dataTableCell="regear_silver" let-row>
                  <span class="mono">{{ formatAmount(row.regear_silver) }}</span>
                </ng-template>
                <ng-template dataTableCell="received" let-row>
                  <span class="mono fin-val--pos">{{ formatAmount(receivedOf(row)) }}</span>
                </ng-template>
                <ng-template dataTableCell="silver_lost" let-row>
                  <span class="mono">{{ formatAmount(row.silver_lost) }}</span>
                </ng-template>
                <ng-template dataTableCell="net" let-row>
                  <span
                    class="mono"
                    [class.fin-val--pos]="netOf(row) >= 0"
                    [class.fin-val--neg]="netOf(row) < 0"
                  >
                    {{ formatSigned(netOf(row)) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="bank_pending" let-row>
                  <span class="mono" [class.fin-val--warn]="row.bank_pending > 0">
                    {{ formatAmount(row.bank_pending) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="siphoned" let-row>
                  <span class="mono">{{ formatAmount(row.siphoned) }}</span>
                </ng-template>
                <ng-template dataTableCell="actions" let-row>
                  <a
                    class="fin-member-link"
                    [routerLink]="'/admin/transactions'"
                    [queryParams]="{ search: row.username }"
                  >
                    {{ t('bank.finance.viewTransactions') }}
                  </a>
                </ng-template>

                <ng-template dataTableFooterCell="split_earnings">
                  <span class="mono">{{ formatAmount(memberTotals().split) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="regear_silver">
                  <span class="mono">{{ formatAmount(memberTotals().regear) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="received">
                  <span class="mono">{{ formatAmount(memberTotals().received) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="silver_lost">
                  <span class="mono">{{ formatAmount(memberTotals().lost) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="net">
                  <span class="mono">{{ formatSigned(memberTotals().net) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="bank_pending">
                  <span class="mono">{{ formatAmount(memberTotals().pending) }}</span>
                </ng-template>
                <ng-template dataTableFooterCell="siphoned">
                  <span class="mono">{{ formatAmount(memberTotals().siphoned) }}</span>
                </ng-template>
              </app-data-table>
            </div>
          </section>
        }

        @if (report()?.data_quality; as quality) {
          <p class="hint">
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
        <p class="hint">{{ t('bank.finance.ledgerNote') }}</p>
      } @else if (loading()) {
        <app-loading variant="summary" [label]="t('bank.finance.loading')" />
      } @else {
        <app-error-state
          [message]="t('bank.finance.unavailable')"
          [retryLabel]="t('common.retry')"
          (retry)="loadFinance()"
        />
      }
    </app-page-stack>
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
  protected readonly originView = signal<OriginView>('sources');
  protected readonly customFrom = signal(toDateInput(new Date(Date.now() - 30 * MS_PER_DAY)));
  protected readonly customTo = signal(toDateInput(new Date()));

  /** True while any fetch is in flight; charts hold their last render instead of flashing. */
  protected readonly busy = computed(() => this.loading() || this.refreshing());

  protected readonly today = computed(() => toDateInput(new Date()));

  protected readonly headerMenu = computed<readonly MenuItem[]>(() => [
    { id: 'refresh', label: this.t('common.refreshNow'), icon: 'refresh', disabled: this.busy() },
  ]);

  protected readonly sectionTabs = computed<ReadonlyArray<TabOption & { id: SectionTabId }>>(() => [
    { id: 'all', label: this.t('bank.finance.navAll'), icon: 'dashboard' },
    { id: 'taxes', label: this.t('bank.finance.navTaxes'), icon: 'coins' },
    { id: 'position', label: this.t('bank.finance.navPosition'), icon: 'bank' },
    { id: 'flow', label: this.t('bank.finance.navFlow'), icon: 'activity' },
    { id: 'combat', label: this.t('bank.finance.navCombat'), icon: 'shield' },
    { id: 'origin', label: this.t('bank.finance.navOrigin'), icon: 'scan' },
    { id: 'members', label: this.t('bank.finance.navMembers'), icon: 'users' },
  ]);

  protected onSectionChange(id: string): void {
    const tab = this.sectionTabs().find((candidate) => candidate.id === id);
    if (tab) {
      this.activeSection.set(tab.id);
    }
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.loadFinance();
    }
  }

  /** A section shows on the overview tab and on its own tab. */
  protected show(id: Exclude<SectionTabId, 'all'>): boolean {
    const active = this.activeSection();
    return active === 'all' || active === id;
  }

  protected readonly periodOptions = computed<TabOption[]>(() => [
    { id: '7', label: this.t('bank.finance.period7') },
    { id: '30', label: this.t('bank.finance.period30') },
    { id: '90', label: this.t('bank.finance.period90') },
    { id: 'custom', label: this.t('bank.finance.periodCustom'), icon: 'calendar' },
  ]);

  protected readonly granularityOptions = computed<TabOption[]>(() => [
    { id: 'day', label: this.t('bank.finance.granularityDay') },
    { id: 'week', label: this.t('bank.finance.granularityWeek') },
  ]);

  protected readonly originOptions = computed<TabOption[]>(() => [
    { id: 'sources', label: this.t('bank.finance.topSourcesTitle') },
    { id: 'destinations', label: this.t('bank.finance.topDestinationsTitle') },
    { id: 'types', label: this.t('bank.finance.ledgerMix') },
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

  protected onOriginChange(id: string): void {
    this.originView.set(id as OriginView);
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

  /* -------------------------------- Stats ------------------------------ */

  /**
   * Whole-ledger position. The five figures are the ledger itself, so the
   * transaction links below the band walk back to the rows each one counts.
   */
  protected readonly positionStats = computed<FinanceStat[]>(() => {
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
      },
      {
        key: 'requested',
        label: this.t('bank.finance.awaitingApproval'),
        value: this.formatAmount(bank.requested_total),
        detail: this.t('bank.finance.requestedWithdrawals', { count: bank.requested_count }),
        tone: bank.requested_count > 0 ? 'warning' : 'default',
      },
      {
        key: 'paid',
        label: this.t('bank.finance.paidOut'),
        value: this.formatAmount(bank.paid_out_total),
        detail: this.t('bank.finance.settledPayouts', { count: bank.paid_out_count }),
        tone: 'success',
      },
      {
        key: 'donated',
        label: this.t('bank.finance.donatedBack'),
        value: this.formatAmount(bank.donated_total),
        detail: this.t('bank.finance.memberDonations', { count: bank.donated_count }),
        tone: 'default',
      },
      {
        key: 'volume',
        label: this.t('bank.finance.ledgerVolume'),
        value: this.formatAmount(bank.ledger_volume),
        detail: this.t('bank.finance.ledgerEntries', { count: bank.transaction_count }),
        tone: 'default',
      },
    ];
  });

  /** Split economics: what the guild earned, spent on repairs, and distributed. */
  protected readonly taxStats = computed<FinanceStat[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    const previous = this.previousReport()?.economy;
    const taxTotal = economy.split_tax_total ?? 0;
    const repairTotal = economy.split_repair_total ?? 0;
    const grossLoot = economy.split_gross_loot ?? economy.split_completed;
    const netDistributed = economy.split_net_distributed ?? economy.split_completed;
    const treasuryNet = this.treasuryNetOf(economy, taxTotal);
    const previousTreasuryNet = previous
      ? this.treasuryNetOf(previous, previous.split_tax_total ?? 0)
      : undefined;
    const coverage = this.taxToRegearCoveragePct();

    return [
      {
        key: 'gross_loot',
        label: this.t('bank.finance.grossLoot'),
        value: this.formatAmount(grossLoot),
        detail: this.t('bank.finance.grossLootBagsDetail', {
          count: economy.split_completed_count ?? 0,
          bags: this.formatCompact(economy.split_bags_total ?? 0),
        }),
        tone: 'default',
        delta: this.buildDelta(grossLoot, previous?.split_gross_loot ?? previous?.split_completed),
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
        delta: this.buildDelta(repairTotal, previous?.split_repair_total),
      },
      {
        key: 'guild_tax',
        label: this.t('bank.finance.guildTaxEarned'),
        value: this.formatAmount(taxTotal),
        detail: this.t('bank.finance.guildTaxEarnedDetail', {
          pct: economy.split_avg_fee_pct ?? 0,
          pending: this.formatCompact(economy.split_pending_tax_total ?? 0),
        }),
        tone: 'success',
        delta: this.buildDelta(taxTotal, previous?.split_tax_total),
      },
      {
        key: 'member_net',
        label: this.t('bank.finance.memberNetDistributed'),
        value: this.formatAmount(netDistributed),
        detail: this.t('bank.finance.memberNetDistributedDetail', {
          pct: this.memberShareOfPoolPct(),
        }),
        tone: 'default',
        delta: this.buildDelta(netDistributed, previous?.split_net_distributed ?? previous?.split_completed),
      },
      {
        key: 'treasury_net',
        label: this.t('bank.finance.treasuryNet'),
        value: this.formatSigned(treasuryNet),
        detail: this.t('bank.finance.treasuryNetHint'),
        tone: treasuryNet >= 0 ? 'success' : 'danger',
        delta: this.buildDelta(treasuryNet, previousTreasuryNet),
      },
      {
        key: 'tax_regear_cov',
        label: this.t('bank.finance.taxRegearCoverage'),
        value: `${coverage}%`,
        detail: this.t('bank.finance.taxRegearCoverageDetail'),
        tone: coverage >= 100 ? 'success' : 'warning',
      },
    ];
  });

  /** Window-scoped flow, each figure carrying its movement against the prior window. */
  protected readonly flowStats = computed<FinanceStat[]>(() => {
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
        detail:
          this.granularity() === 'day'
            ? this.t('bank.finance.perDay', { value: this.formatCompact(this.avgLoot()) })
            : this.t('bank.finance.perWeek', { value: this.formatCompact(this.avgLoot()) }),
        tone: 'success',
        delta: this.buildDelta(economy.loot_in, previous?.loot_in),
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
        delta: this.buildDelta(economy.outflow_total, previous?.outflow_total),
      },
      {
        key: 'net',
        label: this.t('bank.finance.netCashFlow'),
        value: this.formatSigned(economy.net),
        detail: this.t('bank.finance.netDetail'),
        tone: economy.net >= 0 ? 'success' : 'danger',
        delta: this.buildDelta(economy.net, previous?.net),
      },
      {
        key: 'pending',
        label: this.t('bank.finance.bankPending'),
        value: this.formatAmount(economy.bank_pending),
        detail: this.t('bank.finance.bankPendingDetail'),
        tone: economy.bank_pending > 0 ? 'warning' : 'default',
        delta: this.buildDelta(economy.bank_pending, previous?.bank_pending),
      },
    ];
  });

  protected readonly combatStats = computed<FinanceStat[]>(() => {
    const report = this.report();
    if (!report) {
      return [];
    }
    const previous = this.previousReport();
    const lost = report.overview.silver_lost;
    const coverage = this.regearCoverageRatio();
    return [
      {
        key: 'lost',
        label: this.t('bank.finance.silverLost'),
        value: this.formatAmount(lost),
        detail: this.t('bank.finance.acrossFights', { count: report.overview.fights }),
        tone: 'danger',
        delta: this.buildDelta(lost, previous?.overview.silver_lost),
      },
      {
        key: 'regear',
        label: this.t('bank.finance.regearPaid'),
        value: this.formatAmount(report.economy.regear_paid),
        detail: this.t('bank.finance.regearOpenDetail', {
          value: this.formatCompact(report.economy.regear_open),
        }),
        tone: 'default',
        delta: this.buildDelta(report.economy.regear_paid, previous?.economy.regear_paid),
      },
      {
        key: 'coverage',
        label: this.t('bank.finance.regearCoverage'),
        value: `${coverage}%`,
        detail: this.t('bank.finance.coverageDetail'),
        tone: coverage >= 80 ? 'success' : 'default',
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
        ),
      },
    ];
  });

  /** Guild treasury: taxes and donations in, regears out. */
  private treasuryNetOf(economy: GuildReport['economy'], taxTotal: number): number {
    return (
      economy.guild_treasury_net ??
      taxTotal + (economy.bank_donated ?? 0) - economy.regear_paid - economy.outflow_other
    );
  }

  /**
   * Percentage movement against the previous window, with the arrow built in so
   * the figure reads the same without colour. Returns `undefined` when there is
   * nothing to compare with.
   */
  private buildDelta(current: number, previous: number | undefined): string | undefined {
    if (previous === undefined || previous === 0) {
      return undefined;
    }
    const change = ((current - previous) / Math.abs(previous)) * 100;
    if (!Number.isFinite(change)) {
      return undefined;
    }
    const rounded = Math.round(change);
    if (rounded === 0) {
      return '0%';
    }
    return `${rounded > 0 ? '▲ +' : '▼ −'}${Math.abs(rounded)}%`;
  }

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

  protected readonly avgLoot = computed(() => {
    const trends = this.trends();
    if (trends.length === 0) {
      return 0;
    }
    return Math.round(trends.reduce((acc, bucket) => acc + bucket.loot_in, 0) / trends.length);
  });

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

  /* ------------------------------- Tables ------------------------------ */

  protected readonly originColumns = ORIGIN_COLUMNS;
  protected readonly memberColumns = MEMBER_COLUMNS;

  protected readonly trackOrigin = (row: OriginRow): string => row.key;
  protected readonly trackMember = (row: ReportMemberRow): number => row.user_id;

  /** Ledger breakdown for the selected view, largest movement first. */
  protected readonly originRows = computed<OriginRow[]>(() => {
    const bank = this.summary();
    if (!bank) {
      return [];
    }
    const view = this.originView();
    const lines =
      view === 'sources'
        ? bank.sources
        : view === 'destinations'
          ? bank.destinations
          : bank.transaction_types;
    const ordered = [...lines].sort(
      (a, b) => Math.abs(toNumber(b.total_amount)) - Math.abs(toNumber(a.total_amount)),
    );
    const absTotal = ordered.reduce((acc, line) => acc + Math.abs(toNumber(line.total_amount)), 0);
    return ordered.map((line, index) => {
      const amount = toNumber(line.total_amount);
      return {
        key: `${view}-${index}`,
        label: line.label,
        amount,
        entries: toNumber(line.transaction_count),
        share: absTotal > 0 ? Math.abs(amount) / absTotal : 0,
      };
    });
  });

  protected readonly originTotals = computed(() =>
    this.originRows().reduce(
      (acc, row) => ({ amount: acc.amount + row.amount, entries: acc.entries + row.entries }),
      { amount: 0, entries: 0 },
    ),
  );

  /**
   * Every member with any movement in the ledger or the window. The table
   * handles search, sort and paging; the totals row sums this full set.
   */
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

  protected readonly memberTotals = computed(() => {
    const totals = { split: 0, regear: 0, received: 0, lost: 0, net: 0, pending: 0, siphoned: 0 };
    for (const row of this.allMemberRows()) {
      totals.split += row.split_earnings;
      totals.regear += row.regear_silver;
      totals.received += row.split_earnings + row.regear_silver;
      totals.lost += row.silver_lost;
      totals.net += row.split_earnings + row.regear_silver - row.silver_lost;
      totals.pending += row.bank_pending;
      totals.siphoned += row.siphoned;
    }
    return totals;
  });

  protected receivedOf(row: ReportMemberRow): number {
    return row.split_earnings + row.regear_silver;
  }

  protected netOf(row: ReportMemberRow): number {
    return row.split_earnings + row.regear_silver - row.silver_lost;
  }

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
  private axisTooltip(): Record<string, unknown> {
    return {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (input: unknown) => {
        const params = toParamList(input);
        const header = escapeHtml(params[0]?.axisValueLabel ?? params[0]?.name ?? '');
        const rows = params
          .map((param) => {
            const raw = toNumber(param.value as number);
            const key = `<span style="display:inline-block;width:12px;height:2px;border-radius:var(--radius-hairline);background:${
              param.color ?? 'currentColor'
            };vertical-align:middle;margin-inline-end:6px"></span>`;
            return `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin-top:3px">
              <span style="opacity:0.75">${key}${escapeHtml(param.seriesName ?? '')}</span>
              <strong style="font-variant-numeric:tabular-nums">${escapeHtml(this.formatAmount(raw))}</strong>
            </div>`;
          })
          .join('');
        return `<div style="font-size: 12px;opacity:0.7;margin-bottom:2px">${header}</div>${rows}`;
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
      tooltip: this.axisTooltip(),
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
      tooltip: this.axisTooltip(),
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

  protected readonly lossRegearOption = computed<EChartsOption>(() => {
    const trends = this.trends();
    const palette = this.palette();

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      legend: { top: 0, left: 0 },
      tooltip: this.axisTooltip(),
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

  protected formatPercent(fraction: number): string {
    return new Intl.NumberFormat(this.getLocale(), {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(fraction);
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
