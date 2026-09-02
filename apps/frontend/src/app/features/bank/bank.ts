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
    StatCard,
    TooltipDirective,
  ],
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
        >{{ t('bank.reviewRequests') }}</a>
      }

      <button
        type="button"
        class="btn btn--tonal btn--sm"
        [disabled]="(balance()?.pending_total ?? 0) <= 0"
        (click)="confirmWithdrawalOpen.set(true)"
        [appTooltip]="t('bank.requestTooltip')"
        tooltipPosition="bottom"
      >
        {{ t('bank.withdraw.request') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="grid grid-cols-2 gap-3 sm:max-w-md" [attr.aria-label]="t('bank.personalSummary')">
        <app-stat-card
          [label]="t('bank.balance.pending')"
          [value]="formatAmount(balance()?.pending_total)"
          [sub]="t('bank.creditsAvailable', { count: balance()?.pending_count ?? 0 })"
          icon="bank"
          tone="primary"
        />
        <app-stat-card
          [label]="t('bank.balance.requested')"
          [value]="formatAmount(balance()?.requested_total)"
          [sub]="t('bank.withdrawalsInReview', { count: balance()?.requested_count ?? 0 })"
          icon="alert"
          tone="warning"
        />
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
      </app-data-table>
    </app-page-stack>

    @if (confirmWithdrawalOpen()) {
      <app-dialog
        [title]="t('bank.withdraw.request')"
        [subtitle]="t('bank.withdraw.requestConfirmSubtitle')"
        icon="bank"
        size="sm"
        (closed)="confirmWithdrawalOpen.set(false)"
      >
        <div class="space-y-3">
          <p class="text-sm" style="color: var(--color-text)">
            {{ t('bank.withdraw.requestConfirmBody') }}
            <span class="font-mono font-bold text-success">{{ formatAmount(balance()?.pending_total) }}</span>
          </p>
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('bank.withdraw.requestConfirmHint') }}
          </p>
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
            {{ t('common.confirm') }}
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

  protected readonly confirmWithdrawalOpen = signal(false);
  protected readonly withdrawing = signal(false);

  protected readonly trackRow = (row: TransactionView): number => row.id;

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => [
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
        { label: this.t('bank.status.donated'), value: 'donated' },
      ],
    },
    {
      key: 'amount',
      label: 'common.amount',
      sortable: true,
      accessor: (row) => Number(row.amount) || 0,
      align: 'right',
    },
    {
      key: 'created_at',
      label: 'common.date',
      sortable: true,
      accessor: (row) => row.created_at,
    },
  ]);

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
        // Keep the optional flattened filter visible to older query deserializers.
        split_id: '',
      };
      if (query.search.trim()) {
        params['search'] = query.search.trim();
      }
      if (query.sort) {
        params['sort'] = query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const status = query.columnFilters['status'] as TransactionStatus;
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
