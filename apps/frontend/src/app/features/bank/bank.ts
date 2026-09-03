import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
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
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  type DataTableTab,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 10, search: '', sort: null, columnFilters: {} };
}

/**
 * Personal Guild Bank ledger.
 *
 * Purely "what do I have, what have I asked for" — a member's own split
 * earnings and their withdrawal requests. Reviewing and paying out the
 * *guild's* requests is a separate officer workspace at `/admin/withdrawals`;
 * this page used to switch shape depending on who was looking at it, which
 * made "where do I go to see/request my split" ambiguous. Now it only ever
 * shows one thing.
 */
@Component({
  selector: 'app-bank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    Icon,
    PageHeader,
    PageStack,
    RouterLink,
    TooltipDirective,
  ],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .status-pill--withdrawn {
      background: var(--color-success-container);
      color: var(--color-success);
      border: 1px solid var(--color-success);
    }
    .status-pill--requested {
      background: var(--color-warning-container);
      color: var(--color-warning);
      border: 1px solid var(--color-warning);
    }
    .status-pill--pending {
      background: var(--color-surface-2);
      color: var(--color-primary);
      border: 1px solid var(--color-primary);
    }
    .status-pill--rejected {
      background: var(--color-error-container);
      color: var(--color-error);
      border: 1px solid var(--color-error);
    }
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

      @if (canReviewRequests()) {
        <a
          routerLink="/admin/withdrawals"
          class="btn btn--ghost btn--sm"
          [appTooltip]="t('bank.reviewRequestsTooltip')"
          tooltipPosition="bottom"
        >
          <app-icon name="bank" size="0.875rem" />
          {{ t('bank.reviewRequests') }}
        </a>
      }

      <button
        type="button"
        class="btn btn--primary btn--sm"
        [disabled]="(balance()?.pending_total ?? 0) <= 0"
        (click)="confirmWithdrawalOpen.set(true)"
        [appTooltip]="t('bank.requestTooltip')"
        tooltipPosition="bottom"
      >
        <app-icon name="plus" size="0.875rem" />
        {{ t('bank.withdraw.request') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- KPI Row: 4 modern cards -->
      <section class="grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4" [attr.aria-label]="t('bank.personalSummary')">
        <!-- Card 1: Available credits -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('bank.balance.pending') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ formatCompact(balance()?.pending_total) }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                {{ t('bank.creditsAvailable', { count: balance()?.pending_count ?? 0 }) }}
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
              <app-icon name="bank" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 2: In Review / Requested -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('bank.balance.requested') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ formatCompact(balance()?.requested_total) }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                {{ t('bank.withdrawalsInReview', { count: balance()?.requested_count ?? 0 }) }}
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
              <app-icon name="alert" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 3: Total Withdrawn -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('bank.status.withdrawn') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ formatCompact(totalWithdrawn()) }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                {{ t('bank.balance.payouts') }}
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              <app-icon name="coins" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 4: Ledger Entries -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('bank.transactions.title') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ transactionTotal() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                {{ t('bank.queue.entryCount', { count: transactionTotal() }) }}
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-primary)] border border-[var(--color-primary)]">
              <app-icon name="users" size="1.25rem" />
            </div>
          </div>
        </article>
      </section>

      <app-data-table
        [columns]="transactionColumns()"
        [rows]="transactions()"
        [loading]="loading()"
        [error]="transactionsLoadFailed()"
        (retry)="loadTransactions()"
        [trackBy]="trackRow"
        [serverMode]="true"
        [totalItems]="transactionTotal()"
        [pageSize]="10"
        searchPlaceholder="Search transactions..."
        itemLabel="transactions"
        emptyIcon="bank"
        emptyTitle="No transactions found"
        emptySubtitle="There are no transactions matching the selected filters."
        [tabs]="bankTabs()"
        [activeTab]="statusFilter()"
        (tabChange)="onTabSelect($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="transaction" let-row>
          <div class="min-w-[200px]">
            <span class="text-sm font-semibold text-[var(--color-text)]">
              @if (row.type === 'split') {
                Split #{{ row.split_id || row.id }} Payout
              } @else if (row.type === 'withdrawal') {
                Withdrawal to {{ row.to_username || row.to_label }}
              } @else {
                {{ row.type || 'Transaction' }} #{{ row.id }}
              }
            </span>
            <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
              {{ row.from_label || 'Guild Bank' }} &rarr; {{ row.to_label || row.to_username || 'Member' }}
            </div>
          </div>
        </ng-template>

        <ng-template dataTableCell="created_at" let-row>
          <div class="whitespace-nowrap">
            <div class="text-xs font-medium text-[var(--color-text)]">
              {{ formatDateDay(row.created_at) }}
            </div>
            <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
              {{ formatDateTime(row.created_at) }}
            </div>
          </div>
        </ng-template>

        <ng-template dataTableCell="type" let-row>
          <div class="inline-flex items-center gap-1.5 text-xs text-[var(--color-text)] whitespace-nowrap">
            <app-icon
              [name]="row.type === 'split' ? 'swords' : row.type === 'withdrawal' ? 'bank' : 'coins'"
              size="0.875rem"
              class="text-[var(--color-text-tertiary)] shrink-0"
            />
            <span class="capitalize">{{ row.type }}</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          <div class="whitespace-nowrap">
            @switch (row.status) {
              @case ('withdrawn') {
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
                  <app-icon name="check" size="0.75rem" />
                  <span>Paid out</span>
                </span>
              }
              @case ('requested') {
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
                  <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                  <span>Requested</span>
                </span>
              }
              @case ('pending') {
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-info-container)] text-[var(--color-info)] border border-[var(--color-info)]">
                  <app-icon name="info" size="0.75rem" />
                  <span>Pending</span>
                </span>
              }
              @case ('rejected') {
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-error-container)] text-error border border-[var(--color-error)]">
                  <app-icon name="close" size="0.75rem" />
                  <span>Rejected</span>
                </span>
              }
              @default {
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] border border-[var(--color-border)]">
                  <span>{{ statusLabel(row.status) }}</span>
                </span>
              }
            }
          </div>
        </ng-template>

        <ng-template dataTableCell="amount" let-row>
          <div class="whitespace-nowrap text-right">
            <span
              class="font-mono text-sm font-semibold"
              [class.text-success]="row.status === 'withdrawn' || row.status === 'pending'"
              [class.text-warning]="row.status === 'requested'"
              [class.text-error]="row.status === 'rejected'"
            >
              {{ formatAmount(row.amount) }}
            </span>
            <span class="text-[10px] font-mono text-[var(--color-text-tertiary)] uppercase ml-1">silver</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <div class="inline-flex items-center justify-end gap-1.5 whitespace-nowrap text-right">
            @if (row.split_id) {
              <a
                [routerLink]="['/splits', row.split_id]"
                class="px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] border border-[var(--color-border)] rounded-md transition-all no-underline"
              >
                Split
              </a>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (confirmWithdrawalOpen()) {
      <app-dialog
        [title]="t('bank.withdraw.request')"
        [subtitle]="t('bank.withdraw.requestConfirmSubtitle')"
        icon="bank"
        size="md"
        (closed)="confirmWithdrawalOpen.set(false)"
      >
        <div class="space-y-4">
          <!-- Balance Summary Banner -->
          <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 flex items-center justify-between">
            <div>
              <span class="text-xs uppercase tracking-wider text-[var(--color-text-secondary)] font-semibold">
                {{ t('bank.balance.pending') }}
              </span>
              <p class="text-xs text-[var(--color-text-secondary)] mt-0.5">
                {{ t('bank.creditsAvailable', { count: balance()?.pending_count ?? 0 }) }}
              </p>
            </div>
            <div class="text-right">
              <span class="font-mono text-2xl font-bold text-success">
                {{ formatAmount(balance()?.pending_total) }}
              </span>
              <span class="block text-[0.6875rem] font-mono text-[var(--color-text-secondary)] uppercase">
                silver
              </span>
            </div>
          </div>

          <!-- Info Card -->
          <div class="p-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-start gap-3">
            <app-icon name="info" size="1.125rem" class="text-warning flex-shrink-0 mt-0.5" />
            <div class="text-xs text-[var(--color-text-secondary)] space-y-1">
              <p class="text-[var(--color-text)] font-medium">
                {{ t('bank.withdraw.requestConfirmBody') }}
              </p>
              <p>
                {{ t('bank.withdraw.requestConfirmHint') }}
              </p>
            </div>
          </div>
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="confirmWithdrawalOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="withdrawing()"
            (click)="executeWithdrawal()"
          >
            <app-icon name="check" size="0.875rem" />
            {{ withdrawing() ? t('common.loading') : t('common.confirm') }}
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

  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly transactionTotal = signal(0);
  protected readonly loading = signal(false);
  protected readonly transactionsLoadFailed = signal(false);
  protected readonly statusFilter = signal<TransactionStatus | ''>('');

  protected readonly totalWithdrawn = computed(() => {
    return this.transactions()
      .filter((t) => t.status === 'withdrawn')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  });

  protected readonly confirmWithdrawalOpen = signal(false);
  protected readonly withdrawing = signal(false);

  protected readonly trackRow = (row: TransactionView): number => row.id;

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => [
    {
      key: 'transaction',
      label: 'bank.transactions.title',
      sortable: false,
      accessor: (row) => row.id,
    },
    {
      key: 'created_at',
      label: 'common.date',
      sortable: true,
      accessor: (row) => row.created_at,
    },
    {
      key: 'type',
      label: 'common.type',
      sortable: true,
      accessor: (row) => row.type,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (row) => row.status,
    },
    {
      key: 'amount',
      label: 'common.amount',
      sortable: true,
      accessor: (row) => Number(row.amount) || 0,
      align: 'right',
    },
    {
      key: 'actions',
      label: 'common.actions',
      sortable: false,
      accessor: (row) => row.id,
      align: 'right',
    },
  ]);

  protected readonly bankTabs = computed<DataTableTab[]>(() => [
    {
      id: '',
      label: this.t('common.all'),
      count: this.transactionTotal(),
    },
    {
      id: 'requested',
      label: this.t('bank.status.requested'),
      dotClass: 'bg-[var(--color-warning)] animate-pulse',
      count: this.balance()?.requested_count,
    },
    {
      id: 'pending',
      label: this.t('bank.status.pending'),
      dotClass: 'bg-[var(--color-info)]',
      count: this.balance()?.pending_count,
    },
    {
      id: 'withdrawn',
      label: this.t('bank.status.withdrawn'),
      dotClass: 'bg-[var(--color-success)]',
    },
    {
      id: 'rejected',
      label: this.t('bank.status.rejected'),
      dotClass: 'bg-[var(--color-error)]',
    },
  ]);

  protected onTabSelect(tabId: string): void {
    this.setStatusFilter(tabId as TransactionStatus | '');
  }

  protected formatDateDay(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  protected formatDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected canReviewRequests(): boolean {
    return this.auth.hasPermission('bank.withdraw.accept');
  }

  protected setStatusFilter(status: TransactionStatus | ''): void {
    this.statusFilter.set(status);
    const query = this.tableQuery();
    const columnFilters = { ...query.columnFilters };
    if (status) {
      columnFilters['status'] = status;
    } else {
      delete columnFilters['status'];
    }
    this.tableQuery.set({ ...query, page: 1, columnFilters });
    void this.loadTransactions();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.loadTransactions();
  }

  protected async executeWithdrawal(): Promise<void> {
    if (this.withdrawing()) {
      return;
    }
    this.withdrawing.set(true);
    this.confirmWithdrawalOpen.set(false);
    try {
      await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', { all: true });
    } finally {
      this.withdrawing.set(false);
    }
  }

  private async load(): Promise<void> {
    await Promise.all([this.loadBalance(), this.loadTransactions()]);
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
      if (query.search.trim()) {
        params['search'] = query.search.trim();
      }
      if (query.sort) {
        params['sort'] = query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const filterStatus = this.statusFilter();
      const status = (filterStatus || query.columnFilters['status']) as TransactionStatus;
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

  protected formatCompact(value: number | string | null | undefined): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num) || num === 0) return '0';
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(2)}B`;
    }
    if (abs >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    }
    if (abs >= 1_000) {
      return `${(num / 1_000).toFixed(1)}k`;
    }
    return num.toLocaleString();
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
    const lang = this.translate.language() === 'it' ? 'it-IT' : this.translate.language() === 'es' ? 'es-ES' : 'en-US';
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
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
      case 'donated':
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
      case 'donated':
        return 'bank';
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
      donated: 'bank.status.donated',
    };
    return this.t(keyMap[status]);
  }
}
