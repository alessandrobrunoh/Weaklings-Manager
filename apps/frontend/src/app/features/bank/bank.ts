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
import { Avatar } from '../../shared/components/avatar/avatar';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import type { IconName } from '../../shared/components/icon/icon';

type ConfirmAll = 'accept' | 'reject';

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 10, search: '', sort: null, columnFilters: {} };
}

/**
 * Guild Bank ledger page.
 *
 * Surfaces the caller's pending/requested totals plus a server-paginated,
 * filterable transaction list. Members can request withdrawals; officers can
 * accept or reject them.
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
  template: `
    <app-page-header [title]="t('bank.title')" [subtitle]="t('bank.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="'Aggiorna saldo e transazioni'"
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
          [appTooltip]="'Richiedi il prelievo del tuo saldo'"
          tooltipPosition="bottom"
        >
          {{ t('bank.withdraw.request') }}
        </button>
      } @else if (canAccept()) {
        <button
          type="button"
          class="btn btn--outline btn--sm"
          [disabled]="(balance()?.requested_count ?? 0) === 0"
          (click)="confirmAll.set('reject')"
          [appTooltip]="'Rifiuta tutte le richieste pendenti'"
          tooltipPosition="bottom"
        >
          {{ t('bank.withdraw.reject') }}
        </button>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          [disabled]="(balance()?.requested_count ?? 0) === 0"
          (click)="openBatchAcceptDialog()"
          [appTooltip]="'Accetta e liquida tutte le richieste pendenti'"
          tooltipPosition="bottom"
        >
          {{ t('bank.withdraw.accept') }}
        </button>
      }

      @if (canAccept()) {
        <app-view-toggle
          pageTabs
          [options]="viewOptions()"
          [active]="viewMode()"
          (activeChange)="setViewMode($event)"
        />
      }
    </app-page-header>

    <app-page-stack>
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
          [rows]="transactions()"
          [loading]="loading()"
          [error]="transactionsLoadFailed()"
          (retry)="loadTransactions()"
          [trackBy]="trackTransaction"
          [serverMode]="true"
          [totalItems]="transactionTotal()"
          [pageSize]="10"
          emptyIcon="bank"
          [emptyLabel]="'bank.transactions.empty'"
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
            <div class="flex items-center gap-2">
              <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="sm" />
              <span class="font-medium text-sm">{{ row.to_username }}</span>
            </div>
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (row.status === 'requested' && canAccept()) {
              <div class="flex justify-end gap-1">
                <button
                  type="button"
                  class="btn btn--success btn--icon btn--sm"
                  [title]="t('bank.actions.accept_title')"
                  [attr.aria-label]="t('bank.actions.accept_title')"
                  (click)="openAcceptDialog(row)"
                >
                  <app-icon name="check" size="1rem" />
                </button>
                <button
                  type="button"
                  class="btn btn--error btn--icon btn--sm"
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
    </app-page-stack>

    @if (confirmAcceptTransactions(); as txList) {
      <app-dialog
        [title]="t('bank.withdraw.confirmTitle')"
        [subtitle]="t('bank.withdraw.confirmSubtitle')"
        size="md"
        (closed)="confirmAcceptTransactions.set(null)"
      >
        <div class="space-y-4">
          <div
            class="rounded-xl p-3.5 border flex items-center justify-between"
            style="background: var(--color-surface-2); border-color: var(--color-border)"
          >
            <div>
              <p class="text-xs font-semibold uppercase" style="color: var(--color-text-secondary)">
                {{ t('bank.withdraw.totalPayout') }}
              </p>
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ txList.length }} {{ t('bank.stat.transactions') }}
              </p>
            </div>
            <p class="mono text-2xl font-bold text-success">
              {{ formatAmount(calculateTotal(txList)) }}
            </p>
          </div>

          <div
            class="rounded-xl border overflow-hidden"
            style="border-color: var(--color-border)"
          >
            <div
              class="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider"
              style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary)"
            >
              {{ t('bank.withdraw.transactionsList') }}
            </div>
            <div class="max-h-60 overflow-y-auto divide-y" style="border-color: var(--color-border)">
              @for (tx of txList; track tx.id) {
                <div
                  class="p-2.5 flex items-center justify-between gap-3 text-sm"
                  style="background: var(--color-surface-1)"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <app-avatar [userId]="tx.to_user_id" [username]="tx.to_username" size="sm" />
                    <div class="min-w-0">
                      <p class="font-medium truncate text-sm" style="color: var(--color-text)">
                        {{ tx.to_username }}
                      </p>
                      <p class="text-xs" style="color: var(--color-text-secondary)">
                        {{ formatDate(tx.created_at) }}
                      </p>
                    </div>
                  </div>
                  <span class="mono font-bold text-warning">
                    {{ formatAmount(tx.amount) }}
                  </span>
                </div>
              }
            </div>
          </div>

          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('bank.withdraw.confirmWarning') }}
          </p>
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn--ghost"
            (click)="confirmAcceptTransactions.set(null)"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary flex items-center gap-2"
            (click)="executeAcceptTransactions(txList)"
          >
            <app-icon name="check" size="1rem" />
            {{ t('bank.withdraw.confirmAction') }} ({{ txList.length }})
          </button>
        </div>
      </app-dialog>
    }

    @if (confirmAll(); as action) {
      <app-dialog [title]="t('common.confirm')" (closed)="confirmAll.set(null)">
        <p>
          {{
            action === 'accept'
              ? translate.t('bank.withdraw.confirmAcceptAll', { amount: confirmAmount() })
              : translate.t('bank.withdraw.confirmRejectAll', { amount: confirmAmount() })
          }}
        </p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="confirmAll.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn"
            [class.btn--primary]="action === 'accept'"
            [class.btn--danger]="action === 'reject'"
            (click)="runConfirmAll(action)"
          >
            {{ action === 'accept' ? t('bank.withdraw.accept') : t('bank.withdraw.reject') }}
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
  protected readonly viewMode = signal<'personal' | 'guild'>('personal');
  protected readonly statusFilter = signal<TransactionStatus | ''>('');
  protected readonly confirmAll = signal<ConfirmAll | null>(null);
  protected readonly confirmAcceptTransactions = signal<TransactionView[] | null>(null);
  protected readonly tableKey = computed(() => `${this.viewMode()}:${this.statusFilter()}`);
  protected readonly viewOptions = computed<ViewToggleOption[]>(() => [
    { id: 'personal', label: this.t('bank.view.personal') },
    { id: 'guild', label: this.t('bank.view.guild') },
  ]);
  protected readonly trackTransaction = (tx: TransactionView): unknown => tx.id;
  protected readonly confirmAmount = computed(() =>
    this.formatAmount(this.balance()?.requested_total),
  );

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly totalPaidOut = computed(() =>
    this.transactions()
      .filter((t) => t.status === 'withdrawn')
      .reduce((acc, t) => acc + Number(t.amount || 0), 0),
  );

  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => {
    const baseColumns: DataTableColumn<TransactionView>[] = [
      {
        key: 'status',
        label: 'common.status',
        sortable: true,
        accessor: (tx) => tx.status,
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
        accessor: (tx) => tx.amount,
        align: 'right',
      },
      {
        key: 'created_at',
        label: 'common.date',
        sortable: true,
        accessor: (tx) => tx.created_at,
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
    await this.load();
  }

  protected t = (key: TranslationKey) => this.translate.t(key);

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

  protected setViewMode(next: string): void {
    if (next !== 'personal' && next !== 'guild') return;
    if (this.viewMode() === next) return;
    this.viewMode.set(next);
    this.statusFilter.set(next === 'guild' ? 'requested' : '');
    this.tableQuery.set(emptyPageChange());
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

  protected async requestWithdrawal(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', { all: true });
  }

  protected async runConfirmAll(action: ConfirmAll): Promise<void> {
    this.confirmAll.set(null);
    if (action === 'accept') {
      await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', {
        all: true,
      });
      return;
    }
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', {
      all: true,
    });
  }

  protected openBatchAcceptDialog(): void {
    const requested = this.transactions().filter((t) => t.status === 'requested');
    if (requested.length > 0) {
      this.confirmAcceptTransactions.set(requested);
    } else {
      this.confirmAll.set('accept');
    }
  }

  protected openAcceptDialog(tx: TransactionView): void {
    this.confirmAcceptTransactions.set([tx]);
  }

  protected calculateTotal(txList: TransactionView[]): number {
    return txList.reduce((acc, t) => acc + Number(t.amount || 0), 0);
  }

  protected async executeAcceptTransactions(txList: TransactionView[]): Promise<void> {
    const ids = txList.map((t) => t.id);
    this.confirmAcceptTransactions.set(null);
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', {
      transaction_ids: ids,
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

  protected formatAmount(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return '0';
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
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
