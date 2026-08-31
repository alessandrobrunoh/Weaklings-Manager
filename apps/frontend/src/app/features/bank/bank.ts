import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
  BankAnalyticsSummary,
  GuildReport,
  PaginatedData,
  TransactionStatus,
  TransactionView,
  WithdrawRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

type BankViewMode = 'personal' | 'guild' | 'finance';

export interface BankTableRow {
  id: number;
  to_user_id: number;
  to_username: string;
  amount: number;
  status: TransactionStatus;
  count: number;
  created_at: string;
  transactions: TransactionView[];
}

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 10, search: '', sort: null, columnFilters: {} };
}

/**
 * Guild Bank ledger page.
 *
 * Surfaces the caller's pending/requested totals plus a server-paginated,
 * filterable transaction list. Members can request withdrawals; officers can
 * review, select, and accept/reject requested transactions grouped by player.
 */
@Component({
  selector: 'app-bank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    PageHeader,
    PageStack,
    DataTable,
    DataTableCell,
    Dialog,
    Icon,
    StatCard,
    TooltipDirective,
    ViewToggle,
  ],
  styles: `
    .finance-overview { display: grid; gap: 1rem; }
    .finance-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
    .finance-heading h2 { margin: 0; color: var(--color-text); font-size: 0.875rem; font-weight: 510; letter-spacing: -0.012em; }
    .finance-heading p { margin: 0; color: var(--color-text-tertiary); font-size: 0.75rem; }
    .finance-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: var(--color-surface); }
    .finance-metric { min-inline-size: 0; padding: 0.875rem 1rem; border-inline-end: 1px solid var(--color-border); }
    .finance-metric:last-child { border-inline-end: 0; }
    .finance-metric__label { margin: 0; color: var(--color-text-tertiary); font-size: 0.6875rem; font-weight: 510; letter-spacing: 0.035em; text-transform: uppercase; }
    .finance-metric__value { margin: 0.5rem 0 0; color: var(--color-text); font-family: var(--font-mono); font-size: 1.25rem; letter-spacing: -0.02em; }
    .finance-metric__detail { margin: 0.25rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
    .finance-panel { min-inline-size: 0; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .finance-panel__header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.75rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-panel__title { margin: 0; color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 510; }
    .finance-list { margin: 0; padding: 0; list-style: none; }
    .finance-list__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; padding: 0.625rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-list__row:last-child { border-block-end: 0; }
    .finance-list__label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
    .finance-list__meta { display: block; margin-block-start: 0.125rem; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-list__amount { color: var(--color-text); font-family: var(--font-mono); font-size: 0.75rem; }
    .finance-note { margin: 0; padding: 0.75rem 0.875rem; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-tertiary); font-size: 0.75rem; line-height: 1.5; }
    @media (max-width: 72rem) { .finance-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .finance-metric:nth-child(2) { border-inline-end: 0; } .finance-metric:nth-child(-n + 2) { border-block-end: 1px solid var(--color-border); } .finance-panels { grid-template-columns: 1fr; } }
    @media (max-width: 40rem) { .finance-metrics { grid-template-columns: 1fr; } .finance-metric, .finance-metric:nth-child(2) { border-inline-end: 0; border-block-end: 1px solid var(--color-border); } .finance-metric:last-child { border-block-end: 0; } }
  `,
  template: `
    <app-page-header [title]="t('bank.title')" [subtitle]="t('bank.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('bank.refreshTooltip')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (viewMode() === 'personal') {
        <button
          type="button"
          class="btn btn--tonal btn--sm"
          (click)="requestWithdrawal()"
          [appTooltip]="t('bank.requestTooltip')"
          tooltipPosition="bottom"
        >
          {{ t('bank.withdraw.request') }}
        </button>
      }

      @if (canAccept() || canViewFinance()) {
        <app-view-toggle
          pageTabs
          [options]="viewOptions()"
          [active]="viewMode()"
          (activeChange)="setViewMode($event)"
        />
      }
    </app-page-header>

    <app-page-stack>
      @if (viewMode() === 'finance') {
        <section class="finance-overview" [attr.aria-label]="t('bank.finance.ariaLabel')">
          <div class="finance-heading">
            <div>
              <h2>{{ t('bank.finance.heading') }}</h2>
              <p>{{ t('bank.finance.description') }}</p>
            </div>
            @if (financeLoading()) {
              <span class="chip chip--neutral">{{ t('bank.finance.loading') }}</span>
            }
          </div>

          @if (financeSummary(); as summary) {
            <div class="finance-metrics">
              <div class="finance-metric">
                <p class="finance-metric__label">{{ t('bank.finance.openLiability') }}</p>
                <p class="finance-metric__value">{{ formatAmount(summary.outstanding_total) }}</p>
                <p class="finance-metric__detail">{{ t('bank.finance.creditsOwed', { count: summary.outstanding_count }) }}</p>
              </div>
              <div class="finance-metric">
                <p class="finance-metric__label">{{ t('bank.finance.awaitingApproval') }}</p>
                <p class="finance-metric__value">{{ formatAmount(summary.requested_total) }}</p>
                <p class="finance-metric__detail">{{ t('bank.finance.requestedWithdrawals', { count: summary.requested_count }) }}</p>
              </div>
              <div class="finance-metric">
                <p class="finance-metric__label">{{ t('bank.finance.paidOut') }}</p>
                <p class="finance-metric__value">{{ formatAmount(summary.paid_out_total) }}</p>
                <p class="finance-metric__detail">{{ t('bank.finance.settledPayouts', { count: summary.paid_out_count }) }}</p>
              </div>
              <div class="finance-metric">
                <p class="finance-metric__label">{{ t('bank.finance.donatedBack') }}</p>
                <p class="finance-metric__value">{{ formatAmount(summary.donated_total) }}</p>
                <p class="finance-metric__detail">{{ t('bank.finance.memberDonations', { count: summary.donated_count }) }}</p>
              </div>
            </div>

            <div class="finance-panels">
              <section class="finance-panel" aria-labelledby="finance-type-heading">
                <header class="finance-panel__header">
                  <h3 id="finance-type-heading" class="finance-panel__title">{{ t('bank.finance.creditsBySource') }}</h3>
                </header>
                <ul class="finance-list">
                  @for (line of summary.transaction_types; track line.label) {
                    <li class="finance-list__row">
                      <span class="finance-list__label">{{ line.label }}<span class="finance-list__meta">{{ line.transaction_count }} ledger entries</span></span>
                      <span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span>
                    </li>
                  }
                </ul>
              </section>

              <section class="finance-panel" aria-labelledby="finance-destination-heading">
                <header class="finance-panel__header">
                  <h3 id="finance-destination-heading" class="finance-panel__title">{{ t('bank.finance.fundDestinations') }}</h3>
                </header>
                <ul class="finance-list">
                  @for (line of summary.destinations.slice(0, 6); track line.label) {
                    <li class="finance-list__row">
                      <span class="finance-list__label">{{ line.label }}<span class="finance-list__meta">{{ line.transaction_count }} entries</span></span>
                      <span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span>
                    </li>
                  }
                </ul>
              </section>

              <section class="finance-panel" aria-labelledby="finance-period-heading">
                <header class="finance-panel__header">
                  <h3 id="finance-period-heading" class="finance-panel__title">{{ t('bank.finance.lastThirtyDays') }}</h3>
                </header>
                @if (financeReport(); as report) {
                  <ul class="finance-list">
                    <li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.lootCreated') }}</span><span class="finance-list__amount">{{ formatAmount(report.economy.loot_in) }}</span></li>
                    <li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.memberOutflow') }}</span><span class="finance-list__amount">{{ formatAmount(report.economy.outflow_total) }}</span></li>
                    <li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.regearPaid') }}</span><span class="finance-list__amount">{{ formatAmount(report.economy.regear_paid) }}</span></li>
                    <li class="finance-list__row"><span class="finance-list__label">{{ t('bank.finance.siphonedNet') }}<span class="finance-list__meta">{{ t('bank.finance.siphonedDetail') }}</span></span><span class="finance-list__amount">{{ formatAmount(report.economy.siphoned_net) }}</span></li>
                  </ul>
                } @else {
                  <p class="finance-note">{{ t('bank.finance.reportPermission') }}</p>
                }
              </section>
            </div>

            <p class="finance-note">{{ t('bank.finance.ledgerNote') }}</p>
          } @else if (!financeLoading()) {
            <p class="finance-note">{{ t('bank.finance.unavailable') }}</p>
          }
        </section>
      } @else {
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Bank summary">
        <app-stat-card
          [label]="t('bank.balance.pending')"
          [value]="formatAmount(balance()?.pending_total)"
          [sub]="(balance()?.pending_count ?? 0) + ' ' + t('common.total')"
          icon="bank"
          tone="warning"
        />
        <app-stat-card
          [label]="t('bank.balance.requested')"
          [value]="formatAmount(balance()?.requested_total)"
          [sub]="(balance()?.requested_count ?? 0) + ' ' + t('common.total')"
          icon="bank"
          tone="primary"
        />
        <app-stat-card
          [label]="t('bank.balance.payouts')"
          [value]="formatAmount(totalPaidOut())"
          icon="sparkles"
          tone="success"
        />
        <app-stat-card
          [label]="t('bank.stat.transactions')"
          [value]="transactionTotal()"
          icon="list"
          tone="neutral"
        />
      </section>

      @for (key of [tableKey()]; track key) {
        <app-data-table
          [columns]="transactionColumns()"
          [rows]="displayedRows()"
          [loading]="loading()"
          [error]="transactionsLoadFailed()"
          (retry)="loadTransactions()"
          [trackBy]="trackRow"
          [serverMode]="true"
          [totalItems]="transactionTotal()"
          [pageSize]="10"
          [rowClickable]="canAccept() && viewMode() === 'guild'"
          emptyIcon="bank"
          [emptyLabel]="'bank.transactions.empty'"
          (rowClick)="onRowClick($event)"
          (pageChange)="onTableChange($event)"
        >
          <ng-template dataTableCell="status" let-row>
            <span class="chip" [class]="statusChipClass(row.status)">
              <app-icon [name]="statusIcon(row.status)" size="0.875rem" />
              {{ statusLabel(row.status) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="amount" let-row>
            <span
              class="font-semibold mono"
              [class.text-success]="row.status === 'withdrawn'"
              [class.text-warning]="row.status === 'requested'"
              [class.text-error]="row.status === 'rejected'"
              style="font-variant-numeric: tabular-nums"
            >
              {{ formatAmount(row.amount) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="created_at" let-row>
            <span style="color: var(--color-text-secondary)">
              {{ formatDate(row.created_at) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="to_username" let-row>
            <div class="flex items-center gap-2 min-w-0">
              <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="sm" />
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="font-medium text-sm truncate">{{ row.to_username }}</span>
                @if (row.count > 1) {
                  <span
                    class="chip chip--info font-bold mono text-xs px-1.5 py-0.5"
                    [appTooltip]="row.count + ' ' + t('bank.withdraw.requestCount', { count: row.count })"
                    tooltipPosition="top"
                  >
                    {{ row.count }}
                  </span>
                }
              </div>
            </div>
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (row.status === 'requested' && canAccept()) {
              <div class="flex justify-end gap-1" (click)="$event.stopPropagation()">
                <button
                  type="button"
                  class="btn btn--success btn--icon btn--sm"
                  [title]="t('bank.actions.accept_title')"
                  [attr.aria-label]="t('bank.actions.accept_title')"
                  (click)="openPlayerReview(row)"
                >
                  <app-icon name="check" size="1rem" />
                </button>
                <button
                  type="button"
                  class="btn btn--error btn--icon btn--sm"
                  [title]="t('bank.actions.reject_title')"
                  [attr.aria-label]="t('bank.actions.reject_title')"
                  (click)="openPlayerReview(row)"
                >
                  <app-icon name="close" size="1rem" />
                </button>
              </div>
            } @else {
              <span style="color: var(--color-text-disabled)">{{ t('bank.actions.none') }}</span>
            }
          </ng-template>
        </app-data-table>
      }
      }
    </app-page-stack>

    @if (reviewingPlayer(); as row) {
      <app-dialog
        [title]="t('bank.withdraw.playerDialogTitle', { player: row.to_username })"
        [subtitle]="t('bank.withdraw.playerDialogSubtitle')"
        size="md"
        (closed)="closePlayerReview()"
      >
        <div class="space-y-4">
          <!-- Summary card -->
          <div
            class="rounded-xl p-3.5 border flex items-center justify-between"
            style="background: var(--color-surface-2); border-color: var(--color-border)"
          >
            <div class="flex items-center gap-3">
              @if (row.to_user_id > 0) {
                <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="md" />
              } @else {
                <div
                  class="flex h-10 w-10 items-center justify-center rounded-full"
                  style="background: var(--color-surface-3)"
                >
                  <app-icon name="bank" size="1.25rem" />
                </div>
              }
              <div>
                <p class="font-semibold text-sm" style="color: var(--color-text)">
                  {{ row.to_username }}
                </p>
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  {{ selectedTxCount() }} / {{ row.transactions.length }}
                  {{ t('bank.withdraw.selectedCount', { count: selectedTxCount() }) }}
                </p>
              </div>
            </div>
            <div class="text-right">
              <p class="text-xs font-semibold uppercase" style="color: var(--color-text-secondary)">
                {{ t('bank.withdraw.selectedTotal') }}
              </p>
              <p class="mono text-2xl font-bold text-success">
                {{ formatAmount(selectedTxTotal()) }}
              </p>
            </div>
          </div>

          <!-- Transaction checklist -->
          <div
            class="rounded-xl border overflow-hidden"
            style="border-color: var(--color-border)"
          >
            <div
              class="px-3 py-2 border-b flex items-center justify-between text-xs font-semibold uppercase tracking-wider"
              style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary)"
            >
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  class="checkbox"
                  [checked]="allTxsSelected()"
                  (change)="toggleAllTxs($event)"
                />
                <span>{{ t('bank.withdraw.selectAll') }} ({{ row.transactions.length }})</span>
              </label>
              <span>{{ t('bank.withdraw.transactionsList') }}</span>
            </div>
            <div class="max-h-60 overflow-y-auto divide-y" style="border-color: var(--color-border)">
              @for (tx of row.transactions; track tx.id) {
                <label
                  class="p-2.5 flex items-center justify-between gap-3 text-sm cursor-pointer hover:bg-surface-2 transition-colors select-none"
                  style="background: var(--color-surface-1)"
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      class="checkbox"
                      [checked]="isTxSelected(tx.id)"
                      (change)="toggleTx(tx.id, $event)"
                    />
                    <div class="min-w-0">
                      <p class="font-medium text-xs truncate" style="color: var(--color-text)">
                        @if (row.to_user_id === 0) {
                          {{ tx.to_username }} ·
                        }
                        Transazione #{{ tx.id }}
                      </p>
                      <p class="text-xs" style="color: var(--color-text-secondary)">
                        {{ formatDate(tx.created_at) }}
                      </p>
                    </div>
                  </div>
                  <span class="mono font-bold text-warning">
                    {{ formatAmount(tx.amount) }}
                  </span>
                </label>
              }
            </div>
          </div>

          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('bank.withdraw.confirmWarning') }}
          </p>
        </div>

        <div dialogFooter class="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="btn btn--ghost"
            (click)="closePlayerReview()"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger flex items-center gap-1.5"
            [disabled]="selectedTxCount() === 0 || loading()"
            (click)="rejectSelectedTxs()"
          >
            <app-icon name="close" size="1rem" />
            {{ t('bank.withdraw.rejectSelected') }} ({{ selectedTxCount() }})
          </button>
          <button
            type="button"
            class="btn btn--primary flex items-center gap-1.5"
            [disabled]="selectedTxCount() === 0 || loading()"
            (click)="acceptSelectedTxs()"
          >
            <app-icon name="check" size="1rem" />
            {{ t('bank.withdraw.acceptSelected') }} ({{ selectedTxCount() }})
          </button>
        </div>
      </app-dialog>
    }


  `,
})
export class Bank {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  protected readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly transactionTotal = signal(0);
  protected readonly loading = signal(false);
  protected readonly transactionsLoadFailed = signal(false);
  protected readonly viewMode = signal<BankViewMode>('personal');
  protected readonly financeSummary = signal<BankAnalyticsSummary | null>(null);
  protected readonly financeReport = signal<GuildReport | null>(null);
  protected readonly financeLoading = signal(false);
  protected readonly statusFilter = signal<TransactionStatus | ''>('');

  protected readonly reviewingPlayer = signal<BankTableRow | null>(null);
  protected readonly selectedTxIds = signal<ReadonlySet<number>>(new Set<number>());

  protected readonly selectedTxCount = computed(() => this.selectedTxIds().size);
  protected readonly selectedTxTotal = computed(() => {
    const row = this.reviewingPlayer();
    if (!row) {
      return 0;
    }
    return row.transactions
      .filter((t) => this.selectedTxIds().has(t.id))
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  });
  protected readonly allTxsSelected = computed(() => {
    const row = this.reviewingPlayer();
    if (!row || row.transactions.length === 0) {
      return false;
    }
    return row.transactions.every((t) => this.selectedTxIds().has(t.id));
  });

  protected readonly tableKey = computed(() => `${this.viewMode()}:${this.statusFilter()}`);
  protected readonly viewOptions = computed<ViewToggleOption[]>(() => {
    const options: ViewToggleOption[] = [{ id: 'personal', label: this.t('bank.view.personal') }];
    if (this.canAccept()) {
      options.push({ id: 'guild', label: this.t('bank.view.guild') });
    }
    if (this.canViewFinance()) {
      options.push({ id: 'finance', label: this.t('bank.view.finance') });
    }
    return options;
  });
  protected readonly trackRow = (row: BankTableRow): unknown => `${row.to_user_id}-${row.status}-${row.id}`;

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly totalPaidOut = computed(() =>
    this.transactions()
      .filter((t) => t.status === 'withdrawn')
      .reduce((acc, t) => acc + Number(t.amount || 0), 0),
  );

  protected readonly displayedRows = computed<BankTableRow[]>(() => {
    const raw = this.transactions();
    if (this.viewMode() === 'personal') {
      return raw.map((tx) => ({
        id: tx.id,
        to_user_id: tx.to_user_id,
        to_username: tx.to_username,
        amount: Number(tx.amount || 0),
        status: tx.status,
        count: 1,
        created_at: tx.created_at,
        transactions: [tx],
      }));
    }

    const result: BankTableRow[] = [];
    const requestedByPlayer = new Map<number, BankTableRow>();

    for (const tx of raw) {
      if (tx.status === 'requested') {
        const existing = requestedByPlayer.get(tx.to_user_id);
        if (existing) {
          existing.amount += Number(tx.amount || 0);
          existing.count += 1;
          existing.transactions.push(tx);
          if (new Date(tx.created_at) > new Date(existing.created_at)) {
            existing.created_at = tx.created_at;
          }
        } else {
          const row: BankTableRow = {
            id: tx.to_user_id,
            to_user_id: tx.to_user_id,
            to_username: tx.to_username,
            amount: Number(tx.amount || 0),
            status: tx.status,
            count: 1,
            created_at: tx.created_at,
            transactions: [tx],
          };
          requestedByPlayer.set(tx.to_user_id, row);
          result.push(row);
        }
      } else {
        result.push({
          id: tx.id,
          to_user_id: tx.to_user_id,
          to_username: tx.to_username,
          amount: Number(tx.amount || 0),
          status: tx.status,
          count: 1,
          created_at: tx.created_at,
          transactions: [tx],
        });
      }
    }

    return result;
  });

  protected readonly transactionColumns = computed<DataTableColumn<BankTableRow>[]>(() => {
    const baseColumns: DataTableColumn<BankTableRow>[] = [
      {
        key: 'status',
        label: 'common.status',
        sortable: true,
        accessor: (row) => row.status,
        filterOptions: [
          { label: this.t('bank.status.pending'), value: 'pending' },
          { label: this.t('bank.status.requested'), value: 'requested' },
          { label: this.t('bank.status.rejected'), value: 'rejected' },
          { label: this.t('bank.status.withdrawn'), value: 'withdrawn' },
        ],
      },
      {
        key: 'amount',
        label: 'common.amount',
        sortable: true,
        accessor: (row) => row.amount,
        align: 'right',
      },
      {
        key: 'created_at',
        label: 'common.date',
        sortable: true,
        accessor: (row) => row.created_at,
      },
    ];

    if (this.viewMode() === 'guild') {
      return [
        {
          key: 'to_username',
          label: 'common.player',
          sortable: true,
          searchable: true,
          accessor: (row) => row.to_username,
        },
        ...baseColumns,
        {
          key: 'actions',
          label: 'common.actions',
          sortable: false,
          align: 'right',
          accessor: () => null,
        },
      ];
    }

    return baseColumns;
  });

  protected async refreshNow(): Promise<void> {
    if (this.viewMode() === 'finance') {
      await this.loadFinance();
      return;
    }
    await this.load();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    if (this.canAccept()) {
      this.viewMode.set('guild');
      this.statusFilter.set('requested');
    }
    void this.load().then(() => this.checkQueryParams());
  }

  private async checkQueryParams(): Promise<void> {
    const action = this.route.snapshot.queryParamMap.get('action');
    const idParam = this.route.snapshot.queryParamMap.get('id');

    if (action && idParam && this.canAccept()) {
      const id = parseInt(idParam, 10);
      if (!isNaN(id)) {
        if (action === 'accept') {
          await this.acceptSingle(id);
        } else if (action === 'reject') {
          await this.rejectSingle(id);
        }

        void this.router.navigate([], {
          queryParams: { action: null, id: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      }
    }
  }

  protected canAccept(): boolean {
    return this.auth.hasPermission('bank.withdraw.accept');
  }

  protected canViewFinance(): boolean {
    return this.auth.hasPermission('bank.view_others');
  }

  protected setViewMode(next: string): void {
    if (next !== 'personal' && next !== 'guild' && next !== 'finance') return;
    if (this.viewMode() === next) return;
    this.viewMode.set(next);
    this.statusFilter.set(next === 'guild' ? 'requested' : '');
    this.tableQuery.set(emptyPageChange());
    if (next === 'finance') {
      void this.loadFinance();
      return;
    }
    void this.loadTransactions();
  }

  protected onStatusChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as TransactionStatus | '';
    this.statusFilter.set(value);
    this.tableQuery.set(emptyPageChange());
    void this.loadTransactions();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.loadTransactions();
  }

  protected onRowClick(row: BankTableRow): void {
    if (row.status === 'requested' && this.canAccept()) {
      this.openPlayerReview(row);
    }
  }

  protected openPlayerReview(row: BankTableRow): void {
    this.reviewingPlayer.set(row);
    this.selectedTxIds.set(new Set(row.transactions.map((t) => t.id)));
  }

  protected closePlayerReview(): void {
    this.reviewingPlayer.set(null);
    this.selectedTxIds.set(new Set());
  }

  protected isTxSelected(id: number): boolean {
    return this.selectedTxIds().has(id);
  }

  protected toggleTx(id: number, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedTxIds.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  protected toggleAllTxs(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const row = this.reviewingPlayer();
    if (!row) return;
    this.selectedTxIds.set(
      checked ? new Set(row.transactions.map((t) => t.id)) : new Set<number>(),
    );
  }

  protected async acceptSelectedTxs(): Promise<void> {
    const ids = Array.from(this.selectedTxIds());
    if (ids.length === 0) return;
    this.closePlayerReview();
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', {
      transaction_ids: ids,
    });
  }

  protected async rejectSelectedTxs(): Promise<void> {
    const ids = Array.from(this.selectedTxIds());
    if (ids.length === 0) return;
    this.closePlayerReview();
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', {
      transaction_ids: ids,
    });
  }


  protected async requestWithdrawal(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', { all: true });
  }


  protected async acceptSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', {
      transaction_ids: [id],
    });
  }

  protected async rejectSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', {
      transaction_ids: [id],
    });
  }

  private async load(): Promise<void> {
    await Promise.all([this.loadBalance(), this.loadTransactions()]);
  }

  private async loadFinance(): Promise<void> {
    if (!this.canViewFinance()) {
      return;
    }
    this.financeLoading.set(true);
    const [bankResult, reportResult] = await Promise.allSettled([
      firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary')),
      firstValueFrom(this.api.get<GuildReport>('api/intel/report')),
    ]);
    if (bankResult.status === 'fulfilled') {
      this.financeSummary.set(bankResult.value);
    } else {
      this.financeSummary.set(null);
      this.toasts.error(this.t('common.error'));
    }
    this.financeReport.set(reportResult.status === 'fulfilled' ? reportResult.value : null);
    this.financeLoading.set(false);
  }

  private async loadBalance(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance'));
      this.balance.set(data);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async loadTransactions(): Promise<void> {
    this.loading.set(this.transactions().length === 0);
    this.transactionsLoadFailed.set(false);
    try {
      const query = this.tableQuery();
      const params: Record<string, string | number | boolean> = {
        page: query.page,
        limit: query.pageSize,
      };
      if (this.viewMode() === 'guild') {
        params['global'] = true;
      }
      if (query.search.trim()) {
        params['search'] = query.search.trim();
      }
      if (query.sort) {
        params['sort'] = query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const status = (query.columnFilters['status'] as TransactionStatus) || this.statusFilter();
      if (status) {
        params['status'] = status;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', params),
      );
      this.transactions.set(data.items);
      this.transactionTotal.set(data.total_items);
    } catch (error) {
      this.transactionsLoadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async mutate(
    path: string,
    successKey: TranslationKey,
    body: WithdrawRequest,
  ): Promise<void> {
    try {
      await firstValueFrom(this.api.post<TransactionView[]>(path, body));
      this.toasts.success(this.translate.t(successKey));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
      Number.isFinite(numeric) ? numeric : 0,
    );
  }

  protected formatDate(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleDateString();
  }

  protected statusChipClass(status: TransactionStatus): string {
    switch (status) {
      case 'pending':
        return 'chip--info';
      case 'requested':
        return 'chip--warning';
      case 'rejected':
        return 'chip--error';
      case 'withdrawn':
        return 'chip--success';
      default:
        return '';
    }
  }

  protected statusIcon(status: TransactionStatus): IconName {
    switch (status) {
      case 'pending':
        return 'info';
      case 'requested':
        return 'alert';
      case 'rejected':
        return 'close';
      case 'withdrawn':
        return 'check';
      default:
        return 'info';
    }
  }

  protected statusLabel(status: TransactionStatus): string {
    const keyMap: Record<TransactionStatus, TranslationKey> = {
      pending: 'bank.status.pending',
      requested: 'bank.status.requested',
      rejected: 'bank.status.rejected',
      withdrawn: 'bank.status.withdrawn',
    };
    return this.t(keyMap[status]);
  }
}

