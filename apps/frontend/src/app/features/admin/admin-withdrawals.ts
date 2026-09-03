import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  PaginatedData,
  TransactionStatus,
  TransactionView,
  WithdrawRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
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
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

export interface WithdrawalQueueRow {
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
 * Grouping (collapsing every `requested` transaction per player into one
 * queue row) has to happen across the whole matching result, not just one
 * table page, or a player's requests split across pages would show up as
 * several separate rows. This fetch limit stands in for "the whole matching
 * dataset"; pagination is then done client-side over the grouped rows.
 */
const GROUPING_FETCH_LIMIT = 500;

/**
 * Officer withdrawal review queue.
 *
 * Split out of `/bank` (which is now a member's own ledger only) so
 * "see my split earnings" and "review the guild's withdrawal requests" are
 * two separate, unambiguous places instead of one page that changes shape
 * depending on who's looking at it. Grouped by player: select the requests
 * to honor, then accept or reject the batch.
 */
@Component({
  selector: 'app-admin-withdrawals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, PageHeader, PageStack, DataTable, DataTableCell, Dialog, Icon, TooltipDirective],
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
    <app-page-header [title]="t('admin.withdrawals.title')" [subtitle]="t('bank.queue.description')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- KPI Row: 4 Modern Cards -->
      <section class="grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4" [attr.aria-label]="t('bank.queue.ariaLabel')">
        <!-- Card 1: Total Pending Payout -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                Pending Payout
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-success mt-1">
                {{ formatCompact(pendingPayoutSilver()) }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                Silver to trade to members
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
              <app-icon name="bank" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 2: Requests in Queue -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                Pending Requests
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ pendingRequestsCount() }}
              </p>
              <p class="text-xs text-warning mt-1 truncate flex items-center gap-1.5">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                Awaiting officer review
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
              <app-icon name="alert" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 3: Players Awaiting -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                Players Waiting
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                {{ playersAwaitingCount() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                Unique guild members
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-primary)] border border-[var(--color-primary)]">
              <app-icon name="users" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 4: Total Queue Entries -->
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
            <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              <app-icon name="coins" size="1.25rem" />
            </div>
          </div>
        </article>
      </section>

      <app-data-table
        [columns]="columns()"
        [rows]="pagedRows()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="loadTransactions()"
        [trackBy]="trackRow"
        [serverMode]="true"
        [totalItems]="displayedRows().length"
        [pageSize]="10"
        [rowClickable]="true"
        searchPlaceholder="Search withdrawals..."
        itemLabel="withdrawals"
        emptyIcon="bank"
        emptyTitle="No withdrawal requests"
        emptySubtitle="There are no withdrawal requests matching the selected filters."
        [tabs]="withdrawalTabs()"
        [activeTab]="statusFilter()"
        (tabChange)="onTabSelect($event)"
        (rowClick)="onRowClick($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="status" let-row>
          @switch (row.status) {
            @case ('withdrawn') {
              <span class="status-pill status-pill--withdrawn">
                <app-icon name="check" size="0.75rem" />
                {{ statusLabel(row.status) }}
              </span>
            }
            @case ('requested') {
              <span class="status-pill status-pill--requested">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                {{ statusLabel(row.status) }}
              </span>
            }
            @case ('pending') {
              <span class="status-pill status-pill--pending">
                <app-icon name="info" size="0.75rem" />
                {{ statusLabel(row.status) }}
              </span>
            }
            @case ('rejected') {
              <span class="status-pill status-pill--rejected">
                <app-icon name="close" size="0.75rem" />
                {{ statusLabel(row.status) }}
              </span>
            }
            @default {
              <span class="status-pill status-pill--pending">
                {{ statusLabel(row.status) }}
              </span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="amount" let-row>
          <span
            class="font-mono text-sm font-semibold"
            [class.text-success]="row.status === 'withdrawn' || row.status === 'pending'"
            [class.text-warning]="row.status === 'requested'"
            [class.text-error]="row.status === 'rejected'"
          >
            {{ formatAmount(row.amount) }}
          </span>
        </ng-template>

        <ng-template dataTableCell="created_at" let-row>
          <span class="text-xs text-[var(--color-text-secondary)]">
            {{ formatDate(row.created_at) }}
          </span>
        </ng-template>

        <ng-template dataTableCell="to_username" let-row>
          <div class="flex items-center gap-2.5 min-w-0">
            <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="sm" />
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="font-medium text-xs text-(--color-text) truncate">{{ row.to_username }}</span>
              @if (row.count > 1) {
                <span
                  class="rounded-full bg-[var(--color-surface-2)] text-[var(--color-primary)] border border-[var(--color-primary)] px-1.5 py-0.2 text-[0.625rem] font-mono font-bold"
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
          @if (row.status === 'requested') {
            <div class="flex justify-end" (click)="$event.stopPropagation()">
              <button type="button" class="btn btn--primary btn--sm inline-flex items-center gap-1" (click)="openPlayerReview(row)">
                <span>{{ t('bank.actions.review') }}</span>
                &rarr;
              </button>
            </div>
          } @else {
            <span class="text-xs text-[var(--color-text-disabled)]">{{ t('bank.actions.none') }}</span>
          }
        </ng-template>
      </app-data-table>
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
          <div class="rounded-xl border overflow-hidden" style="border-color: var(--color-border)">
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
          <button type="button" class="btn btn--ghost" (click)="closePlayerReview()">
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
export class AdminWithdrawals {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly transactionTotal = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly statusFilter = signal<TransactionStatus | ''>('requested');

  protected readonly pendingPayoutSilver = computed(() => {
    return this.transactions()
      .filter((t) => t.status === 'requested')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  });

  protected readonly pendingRequestsCount = computed(() => {
    return this.transactions().filter((t) => t.status === 'requested').length;
  });

  protected readonly playersAwaitingCount = computed(() => {
    const set = new Set<number>();
    for (const t of this.transactions()) {
      if (t.status === 'requested') set.add(t.to_user_id);
    }
    return set.size;
  });

  protected readonly reviewingPlayer = signal<WithdrawalQueueRow | null>(null);
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

  protected readonly trackRow = (row: WithdrawalQueueRow): unknown => `${row.to_user_id}-${row.status}-${row.id}`;

  protected readonly withdrawalTabs = computed<DataTableTab[]>(() => [
    {
      id: 'requested',
      label: this.t('bank.status.requested'),
      dotClass: 'bg-[var(--color-warning)] animate-pulse',
      count: this.pendingRequestsCount(),
    },
    {
      id: '',
      label: this.t('common.all'),
      count: this.displayedRows().length,
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

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

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

  protected readonly columns = computed<readonly DataTableColumn<WithdrawalQueueRow>[]>(() => [
    { key: 'to_username', label: 'common.player', sortable: true, searchable: true, accessor: (row) => row.to_username },
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
    { key: 'amount', label: 'common.amount', sortable: true, accessor: (row) => row.amount, align: 'right' },
    { key: 'created_at', label: 'common.date', sortable: true, accessor: (row) => row.created_at },
    { key: 'actions', label: 'common.actions', sortable: false, align: 'right', accessor: () => null },
  ]);

  protected readonly displayedRows = computed<WithdrawalQueueRow[]>(() => {
    const raw = this.transactions();
    const result: WithdrawalQueueRow[] = [];
    const requestedByPlayer = new Map<number, WithdrawalQueueRow>();

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
          const row: WithdrawalQueueRow = {
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

  /**
   * `app-data-table` in `serverMode` expects only the current page's rows —
   * `displayedRows()` already holds every grouped row matching the current
   * filters (see `GROUPING_FETCH_LIMIT`), so pagination here is just an
   * in-memory slice; it needs no extra network round-trip.
   */
  protected readonly pagedRows = computed<WithdrawalQueueRow[]>(() => {
    const rows = this.displayedRows();
    const query = this.tableQuery();
    const start = (query.page - 1) * query.pageSize;
    return rows.slice(start, start + query.pageSize);
  });

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.loadTransactions().then(() => this.checkQueryParams());
  }

  private async checkQueryParams(): Promise<void> {
    const action = this.route.snapshot.queryParamMap.get('action');
    const idParam = this.route.snapshot.queryParamMap.get('id');

    if (action && idParam) {
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

  protected async refreshNow(): Promise<void> {
    await this.loadTransactions();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.loadTransactions();
  }

  protected onRowClick(row: WithdrawalQueueRow): void {
    if (row.status === 'requested') {
      this.openPlayerReview(row);
    }
  }

  protected openPlayerReview(row: WithdrawalQueueRow): void {
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
    this.selectedTxIds.set(checked ? new Set(row.transactions.map((t) => t.id)) : new Set<number>());
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

  protected async loadTransactions(): Promise<void> {
    this.loading.set(this.transactions().length === 0);
    this.loadFailed.set(false);
    try {
      const query = this.tableQuery();
      // Always fetch the whole matching dataset (not just one table page) so
      // grouping-by-player below is correct across every page — pagination
      // for display is then done client-side in `pagedRows()`.
      const params: Record<string, string | number | boolean> = {
        page: 1,
        limit: GROUPING_FETCH_LIMIT,
        global: true,
      };
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
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async mutate(path: string, successKey: TranslationKey, body: WithdrawRequest): Promise<void> {
    try {
      await firstValueFrom(this.api.post<TransactionView[]>(path, body));
      this.toasts.success(this.translate.t(successKey));
      await this.loadTransactions();
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
      donated: 'bank.status.donated',
    };
    return this.t(keyMap[status]);
  }
}
