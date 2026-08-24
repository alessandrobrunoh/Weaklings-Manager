import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import type { IconName } from '../../shared/components/icon/icon';

const TRANSACTIONS_LOAD_LIMIT = 1000;

/**
 * Guild Bank ledger page.
 *
 * Surfaces the caller's pending/requested totals (live-computed by the backend
 * from the `transactions` table) plus a paginated, filterable transaction list.
 * Members can request withdrawals; officers/admins can accept (pay out) them.
 */
@Component({
  selector: 'app-bank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading, DataTable, DataTableCell, Icon, ViewToggle],
  styles: [
    `
    `,
  ],
  template: `
    <app-page-header [title]="t('bank.title')" [subtitle]="t('bank.subtitle')">
      @if (viewMode() === 'personal') {
        <button type="button" class="btn btn--tonal" (click)="requestWithdrawal()">
          {{ t('bank.withdraw.request') }}
        </button>
      } @else if (canAccept()) {
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" (click)="rejectWithdrawals()">
            {{ t('bank.withdraw.reject') }}
          </button>
          <button type="button" class="btn btn--primary" (click)="acceptWithdrawals()">
            {{ t('bank.withdraw.accept') }}
          </button>
        </div>
      }
    </app-page-header>

    <!-- Balance cards -->
    <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="card p-5">
        <p
          class="text-xs font-medium uppercase tracking-wider"
          style="color: var(--color-text-secondary)"
        >
          {{ t('bank.balance.pending') }}
        </p>
        <p class="mt-1 text-2xl font-semibold" style="color: var(--color-text)">
          {{ formatAmount(balance()?.pending_total) }}
        </p>
        <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
          {{ balance()?.pending_count ?? 0 }} {{ t('common.total') }}
        </p>
      </div>
      <div class="card p-5">
        <p
          class="text-xs font-medium uppercase tracking-wider"
          style="color: var(--color-text-secondary)"
        >
          {{ t('bank.balance.requested') }}
        </p>
        <p class="mt-1 text-2xl font-semibold" style="color: var(--color-text)">
          {{ formatAmount(balance()?.requested_total) }}
        </p>
        <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
          {{ balance()?.requested_count ?? 0 }} {{ t('common.total') }}
        </p>
      </div>
    </div>

    <!-- Transactions -->
    <section class="card p-5">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <h2 class="text-base font-semibold" style="color: var(--color-text)">
            {{ t('bank.transactions.title') }}
          </h2>
          @if (canAccept()) {
            <app-view-toggle [options]="viewOptions()" [active]="viewMode()" (activeChange)="setViewMode($event)" />
          }
        </div>
        <label class="flex items-center gap-2">
          <span class="label" style="margin-bottom: 0">{{ t('common.status') }}</span>
          <select
            class="select"
            style="width: auto"
            [value]="statusFilter()"
            (change)="onStatusChange($event)"
          >
            <option value="">{{ t('common.all') }}</option>
            <option value="pending">{{ t('bank.balance.pending') }}</option>
            <option value="requested">{{ t('bank.balance.requested') }}</option>
            <option value="rejected">{{ t('bank.status.rejected') }}</option>
            <option value="withdrawn">{{ t('bank.balance.payouts') }}</option>
          </select>
        </label>
      </div>

      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (filteredTransactions().length === 0) {
        <app-empty-state [message]="t('bank.transactions.empty')" icon="bank" />
      } @else {
        <app-data-table
          [columns]="transactionColumns()"
          [rows]="filteredTransactions()"
          [trackBy]="trackTransaction"
          [pageSize]="10"
        >
          <ng-template dataTableCell="status" let-row>
            <span class="chip" [class]="statusChipClass(row.status)">
              <app-icon [name]="statusIcon(row.status)" size="0.875rem" />
              {{ statusLabel(row.status) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="amount" let-row>
            <span
              class="font-semibold"
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
            <div class="flex items-center gap-2">
              <span
                class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
                style="
                  background-color: var(--color-primary-container);
                  color: var(--color-primary);
                "
                >{{ row.to_username.charAt(0).toUpperCase() }}</span
              >
              <span class="font-medium text-sm">{{ row.to_username }}</span>
            </div>
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (row.status === 'requested' && canAccept()) {
              <div class="flex justify-end gap-1">
                <button
                  type="button"
                  class="btn btn--success btn--icon"
                  [title]="t('bank.actions.accept_title')"
                  [attr.aria-label]="t('bank.actions.accept_title')"
                  (click)="acceptSingle(row.id)"
                >
                  <app-icon name="check" size="1rem" />
                </button>
                <button
                  type="button"
                  class="btn btn--error btn--icon"
                  [title]="t('bank.actions.reject_title')"
                  [attr.aria-label]="t('bank.actions.reject_title')"
                  (click)="rejectSingle(row.id)"
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
    </section>
  `,
})
export class Bank {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly loading = signal(false);
  protected readonly statusFilter = signal<TransactionStatus | ''>('');
  protected readonly viewMode = signal<'personal' | 'guild'>('personal');
  protected readonly viewOptions = computed<ViewToggleOption[]>(() => [
    { id: 'personal', label: this.t('bank.view.personal') },
    { id: 'guild', label: this.t('bank.view.guild') },
  ]);
  protected readonly trackTransaction = (tx: TransactionView): unknown => tx.id;

  /** Dynamic columns based on view mode - guild view includes player name and actions */
  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => {
    const baseColumns: DataTableColumn<TransactionView>[] = [
      {
        key: 'status',
        label: 'common.status',
        sortable: true,
        accessor: (tx) => tx.status,
        comparator: (a, b) => a.status.localeCompare(b.status),
      },
      {
        key: 'amount',
        label: 'common.amount',
        sortable: true,
        accessor: (tx) => tx.amount,
        comparator: (a, b) => a.amount - b.amount,
        align: 'right',
      },
      {
        key: 'created_at',
        label: 'common.date',
        sortable: true,
        searchable: true,
        accessor: (tx) => tx.created_at,
        comparator: (a, b) => a.created_at.localeCompare(b.created_at),
      },
    ];

    if (this.viewMode() === 'guild') {
      return [
        {
          key: 'to_username',
          label: 'common.player',
          sortable: true,
          searchable: true,
          accessor: (tx) => tx.to_username,
          comparator: (a, b) => a.to_username.localeCompare(b.to_username),
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

  /** Client-side filtered transactions based on status filter */
  protected readonly filteredTransactions = computed(() => {
    const filter = this.statusFilter();
    const allTransactions = this.transactions();
    if (!filter) {
      return allTransactions;
    }
    return allTransactions.filter((tx) => tx.status === filter);
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    // Officers/Admins land directly on the guild-wide request queue so the
    // accept/reject actions are immediately reachable.
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
        
        // Remove query params after processing
        void this.router.navigate([], {
          queryParams: { action: null, id: null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }
    }
  }

  protected canAccept(): boolean {
    return this.auth.hasPermission('bank.withdraw.accept');
  }

  protected onStatusChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as TransactionStatus | '';
    this.statusFilter.set(value);
  }

  protected setViewMode(next: string): void {
    if (next !== 'personal' && next !== 'guild') return;
    if (this.viewMode() === next) return;
    this.viewMode.set(next);
    if (next === 'guild') {
      this.statusFilter.set('requested');
    }
    void this.loadTransactions();
  }

  protected async requestWithdrawal(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', { all: true });
  }

  /**
   * Pays out every currently-requested withdrawal, guild-wide, in one action.
   *
   * There is no per-row selection step before this — `all: true` is the whole
   * request — so the confirm is the only thing standing between one click and
   * moving every pending payout at once. It states the actual amount rather
   * than a bare "Confirm", since that is the number that makes the stakes
   * legible.
   */
  protected async acceptWithdrawals(): Promise<void> {
    const amount = this.formatAmount(this.balance()?.requested_total);
    if (!window.confirm(this.t('bank.withdraw.confirmAcceptAll').replace('{amount}', amount))) {
      return;
    }
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', {
      all: true,
    });
  }

  /** Rejects every currently-requested withdrawal, guild-wide. See `acceptWithdrawals`. */
  protected async rejectWithdrawals(): Promise<void> {
    const amount = this.formatAmount(this.balance()?.requested_total);
    if (!window.confirm(this.t('bank.withdraw.confirmRejectAll').replace('{amount}', amount))) {
      return;
    }
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', {
      all: true,
    });
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

  private async loadBalance(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance'));
      this.balance.set(data);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async loadTransactions(): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string | number | boolean> = {
        limit: TRANSACTIONS_LOAD_LIMIT,
      };
      if (this.viewMode() === 'guild') {
        params['global'] = true;
      }
      const data = await firstValueFrom(
        this.api.get<{ items: TransactionView[] }>('api/bank/transactions', params),
      );
      this.transactions.set(data.items);
    } catch (error) {
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

  /** Formats a silver amount with locale-aware grouping and no decimals. */
  protected formatAmount(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return '0';
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  }

  /** Formats an ISO timestamp as a localized date string. */
  protected formatDate(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleDateString();
  }

  /** Maps a transaction status to its semantic chip class. */
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

  /** Maps a transaction status to a representative icon. */
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

  /** Returns the localized status label shown inside the chip. */
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
