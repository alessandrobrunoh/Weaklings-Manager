import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
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
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
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
  guild_tenant_id?: string | null;
  guild_name?: string | null;
}

/** Status tabs of the queue. `all` drops the status filter. */
type StatusTab = 'requested' | 'pending' | 'withdrawn' | 'rejected' | 'all';

const STATUS_TABS: readonly StatusTab[] = ['requested', 'pending', 'withdrawn', 'rejected', 'all'];

const STATUS_TAB_LABEL: Record<StatusTab, TranslationKey> = {
  requested: 'bank.status.requested',
  pending: 'bank.status.pending',
  withdrawn: 'bank.status.withdrawn',
  rejected: 'bank.status.rejected',
  all: 'common.all',
};

function parseStatusTab(value: string | null): StatusTab {
  return (STATUS_TABS as readonly string[]).includes(value ?? '') ? (value as StatusTab) : 'requested';
}

function statusFilter(tab: StatusTab): TransactionStatus | null {
  return tab === 'all' ? null : tab;
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
 * two separate, unambiguous places. Status tabs pick the slice; each player's
 * requests are one row. The primary row action pays the player's requests out,
 * and the row menu holds review and reject. Pay and reject both confirm first.
 */
@Component({
  selector: 'app-admin-withdrawals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    Checkbox,
    Dialog,
    DataTable,
    DataTableCell,
    ErrorState,
    Icon,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    StatusChip,
    SummaryBand,
    Tabs,
    TooltipDirective,
  ],
  styles: [COMPACT_FEATURE_STYLES],
  template: `
    <app-page-header [title]="t('admin.withdrawals.title')" [subtitle]="t('bank.queue.description')">
      <app-tabs
        pageTabs
        [options]="tabOptions()"
        [active]="statusTab()"
        [ariaLabel]="t('admin.withdrawals.tabsLabel')"
        (activeChange)="onStatusChange($event)"
      />
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="refresh()">
        <app-icon name="refresh" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      @if (summaryFailed()) {
        <app-error-state
          [message]="t('common.error')"
          [retryLabel]="t('common.retry')"
          (retry)="loadSummary()"
        />
      } @else if (summaryLoaded()) {
        <app-summary-band [ariaLabel]="t('bank.queue.ariaLabel')" [items]="summaryItems()" />
      } @else {
        <app-loading variant="summary" [label]="t('common.loading')" />
      }

      <app-data-table
        [columns]="columns()"
        [rows]="pagedRows()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="loadRows()"
        [trackBy]="trackRow"
        [serverMode]="true"
        [totalItems]="displayedRows().length"
        [rowClickable]="true"
        [stickyFirstColumn]="true"
        [ariaLabel]="t('admin.withdrawals.title')"
        [searchPlaceholder]="t('admin.withdrawals.search')"
        [itemLabel]="t('admin.withdrawals.itemLabel')"
        emptyIcon="bank"
        [emptyTitle]="t('admin.withdrawals.empty')"
        [emptySubtitle]="t('admin.withdrawals.emptyHint')"
        (rowClick)="onRowClick($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="status" let-row>
          <app-status-chip
            [value]="row.status"
            [label]="statusLabel(row.status)"
            [icon]="statusIcon(row.status)"
          />
        </ng-template>

        <ng-template dataTableCell="amount" let-row>
          <span class="num font-semibold">{{ formatAmount(row.amount) }}</span>
        </ng-template>

        <ng-template dataTableCell="guild" let-row>
          <span class="whitespace-nowrap text-xs">{{ row.guild_name || '—' }}</span>
        </ng-template>

        <ng-template dataTableCell="created_at" let-row>
          <span class="text-xs text-[var(--color-text-secondary)]">{{ formatDate(row.created_at) }}</span>
        </ng-template>

        <ng-template dataTableCell="to_username" let-row>
          <div class="flex min-w-0 items-center gap-2.5">
            <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="sm" />
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate text-xs font-medium text-(--color-text)">{{ row.to_username }}</span>
              @if (row.count > 1) {
                <span
                  class="chip chip--neutral num"
                  [appTooltip]="t('bank.withdraw.requestCount', { count: row.count })"
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
            <div class="flex items-center justify-end gap-1.5">
              <button type="button" class="btn btn--primary btn--sm" (click)="askConfirm(row, 'pay')">
                {{ t('admin.withdrawals.payOut') }}
              </button>
              <app-menu
                appearance="ghost"
                align="end"
                [label]="t('admin.withdrawals.rowActions', { player: row.to_username })"
                [items]="rowMenuItems()"
                (itemSelect)="onRowMenu(row, $event)"
              />
            </div>
          } @else {
            <span class="text-xs text-[var(--color-text-disabled)]">{{ t('bank.actions.none') }}</span>
          }
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (confirmation(); as c) {
      <app-dialog
        [title]="
          c.action === 'pay'
            ? t('admin.withdrawals.confirmPayTitle', { player: c.row.to_username })
            : t('admin.withdrawals.confirmRejectTitle', { player: c.row.to_username })
        "
        [subtitle]="t('bank.withdraw.requestCount', { count: c.row.count })"
        size="sm"
        (closed)="closeConfirm()"
      >
        <p class="text-sm">
          {{
            c.action === 'pay'
              ? t('bank.withdraw.confirmAcceptAll', { amount: formatAmount(c.row.amount) })
              : t('bank.withdraw.confirmRejectAll', { amount: formatAmount(c.row.amount) })
          }}
        </p>
        <div dialogFooter class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          @if (c.action === 'pay') {
            <button type="button" class="btn btn--primary" [disabled]="loading()" (click)="confirmAction()">
              {{ t('admin.withdrawals.payOut') }}
            </button>
          } @else {
            <button type="button" class="btn btn--danger" [disabled]="loading()" (click)="confirmAction()">
              {{ t('bank.withdraw.reject') }}
            </button>
          }
        </div>
      </app-dialog>
    }

    @if (reviewingPlayer(); as row) {
      <app-dialog
        [title]="t('bank.withdraw.playerDialogTitle', { player: row.to_username })"
        [subtitle]="t('bank.withdraw.playerDialogSubtitle')"
        size="md"
        (closed)="closePlayerReview()"
      >
        <div class="flex flex-col gap-4">
          <div
            class="flex items-center justify-between gap-3 rounded-md border p-3"
            style="background: var(--color-surface-2); border-color: var(--color-border)"
          >
            <div class="flex items-center gap-3">
              @if (row.to_user_id > 0) {
                <app-avatar [userId]="row.to_user_id" [username]="row.to_username" size="md" />
              } @else {
                <app-icon name="bank" size="1.25rem" />
              }
              <div>
                <p class="text-sm font-semibold">{{ row.to_username }}</p>
                <p class="text-xs text-[var(--color-text-secondary)]">
                  {{ selectedTxCount() }} / {{ row.transactions.length }}
                  {{ t('bank.withdraw.selectedCount', { count: selectedTxCount() }) }}
                </p>
              </div>
            </div>
            <div class="text-right">
              <p class="text-xs font-semibold text-[var(--color-text-secondary)]">
                {{ t('bank.withdraw.selectedTotal') }}
              </p>
              <p class="num text-2xl font-semibold">{{ formatAmount(selectedTxTotal()) }}</p>
            </div>
          </div>

          <div class="overflow-hidden rounded-md border" style="border-color: var(--color-border)">
            <div
              class="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)]"
              style="border-color: var(--color-border); background: var(--color-surface-2)"
            >
              <app-checkbox
                inputId="wd-select-all"
                [label]="t('bank.withdraw.selectAll') + ' (' + row.transactions.length + ')'"
                [checked]="allTxsSelected()"
                (checkedChange)="toggleAllTxs($event)"
              />
              <span>{{ t('bank.withdraw.transactionsList') }}</span>
            </div>
            <div class="max-h-60 divide-y overflow-y-auto" style="border-color: var(--color-border)">
              @for (tx of row.transactions; track tx.id) {
                <div class="flex items-center justify-between gap-3 p-2.5">
                  <app-checkbox
                    [inputId]="'wd-tx-' + tx.id"
                    [label]="txLabel(row, tx)"
                    [hint]="formatDate(tx.created_at)"
                    [checked]="isTxSelected(tx.id)"
                    (checkedChange)="setTx(tx.id, $event)"
                  />
                  <span class="num shrink-0 text-sm font-semibold">{{ formatAmount(tx.amount) }}</span>
                </div>
              }
            </div>
          </div>

          <p
            class="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 text-sm font-medium"
            style="color: var(--color-text)"
            role="note"
          >
            {{ t('bank.withdraw.confirmWarning') }}
          </p>
        </div>

        <div dialogFooter class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="closePlayerReview()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="selectedTxCount() === 0 || loading()"
            (click)="rejectSelectedTxs()"
          >
            {{ t('bank.withdraw.rejectSelected') }} ({{ selectedTxCount() }})
          </button>
          <button
            type="button"
            class="btn btn--primary"
            [disabled]="selectedTxCount() === 0 || loading()"
            (click)="acceptSelectedTxs()"
          >
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

  /** Rows of the active status tab, fetched with the table's search and sort. */
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);

  /** Every `requested` transaction, unfiltered: feeds the summary band. */
  private readonly queue = signal<TransactionView[]>([]);
  protected readonly summaryLoaded = signal(false);
  protected readonly summaryFailed = signal(false);
  /** Transaction counts per status tab, from the API's `total_items`. */
  protected readonly tabCounts = signal<Partial<Record<StatusTab, number>>>({});

  protected readonly statusTab = signal<StatusTab>(parseStatusTab(this.route.snapshot.queryParamMap.get('status')));

  protected readonly pendingPayoutSilver = computed(() =>
    this.queue().reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
  );

  protected readonly playersAwaitingCount = computed(() => new Set(this.queue().map((tx) => tx.to_user_id)).size);

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const payout = this.pendingPayoutSilver();
    return [
      {
        label: this.t('admin.withdrawals.summary.toPay'),
        value: this.formatAmount(payout),
        hint: this.t('admin.withdrawals.summary.toPayHint'),
        tone: payout > 0 ? 'warning' : 'default',
      },
      {
        label: this.t('admin.withdrawals.summary.players'),
        value: this.playersAwaitingCount(),
        hint: this.t('admin.withdrawals.summary.playersHint'),
      },
    ];
  });

  protected readonly tabOptions = computed<TabOption[]>(() => {
    const counts = this.tabCounts();
    return STATUS_TABS.map((id) => ({
      id,
      label: this.t(STATUS_TAB_LABEL[id]),
      count: counts[id] ?? null,
    }));
  });

  protected readonly reviewingPlayer = signal<WithdrawalQueueRow | null>(null);
  protected readonly selectedTxIds = signal<ReadonlySet<number>>(new Set<number>());
  protected readonly confirmation = signal<{ action: 'pay' | 'reject'; row: WithdrawalQueueRow } | null>(null);

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

  protected readonly trackRow = (row: WithdrawalQueueRow): unknown =>
    `${row.guild_tenant_id ?? ''}-${row.to_user_id}-${row.status}-${row.id}`;

  private readonly tableQuery = signal<DataTablePageChange>(
    parseDataTableQuery(this.route.snapshot.queryParamMap, { defaultPageSize: 10 }),
  );

  protected readonly columns = computed<readonly DataTableColumn<WithdrawalQueueRow>[]>(() => [
    { key: 'to_username', label: 'common.player', sortable: true, searchable: true, accessor: (row) => row.to_username },
    ...(this.transactions().some((tx) => !!tx.guild_tenant_id)
      ? [
          {
            key: 'guild',
            label: 'bank.guild',
            sortable: true,
            accessor: (row: WithdrawalQueueRow) => row.guild_name ?? '',
          } satisfies DataTableColumn<WithdrawalQueueRow>,
        ]
      : []),
    { key: 'status', label: 'common.status', sortable: true, accessor: (row) => row.status },
    { key: 'amount', label: 'common.amount', sortable: true, accessor: (row) => row.amount, align: 'right' },
    { key: 'created_at', label: 'common.date', sortable: true, accessor: (row) => row.created_at },
    { key: 'actions', label: 'common.actions', sortable: false, align: 'right', accessor: () => null },
  ]);

  /** Row menu of a requested player: review opens the dialog, reject confirms. */
  protected readonly rowMenuItems = computed<MenuItem[]>(() => [
    { id: 'review', label: this.t('bank.actions.review') },
    { id: 'reject', label: this.t('bank.withdraw.reject'), danger: true, separatorBefore: true },
  ]);

  protected readonly displayedRows = computed<WithdrawalQueueRow[]>(() => {
    const raw = this.transactions();
    const result: WithdrawalQueueRow[] = [];
    const requestedByPlayer = new Map<string, WithdrawalQueueRow>();

    for (const tx of raw) {
      if (tx.status === 'requested') {
        const groupKey = `${tx.guild_tenant_id ?? ''}:${tx.to_user_id}`;
        const existing = requestedByPlayer.get(groupKey);
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
            guild_tenant_id: tx.guild_tenant_id,
            guild_name: tx.guild_name,
          };
          requestedByPlayer.set(groupKey, row);
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
          guild_tenant_id: tx.guild_tenant_id,
          guild_name: tx.guild_name,
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

  private rowsRequest = 0;

  constructor() {
    void this.refresh().then(() => this.checkQueryParams());
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

  protected async refresh(): Promise<void> {
    await Promise.all([this.loadRows(), this.loadSummary()]);
  }

  /** Status tab picked: reset to page 1 and reload. The URL carries the tab so a link restores it. */
  protected onStatusChange(id: string): void {
    if (!(STATUS_TABS as readonly string[]).includes(id) || id === this.statusTab()) {
      return;
    }
    this.statusTab.set(id as StatusTab);
    // Writing `page=1` makes the table reset its own page; its `pageChange` then matches the query below and is ignored.
    this.tableQuery.update((query) => ({ ...query, page: 1 }));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { status: id, page: '1' },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.loadRows();
  }

  protected onTableChange(event: DataTablePageChange): void {
    const current = this.tableQuery();
    if (sameTableQuery(current, event)) {
      return;
    }
    this.tableQuery.set(event);
    void this.loadRows();
  }

  protected onRowClick(row: WithdrawalQueueRow): void {
    if (row.status === 'requested') {
      this.openPlayerReview(row);
    }
  }

  protected onRowMenu(row: WithdrawalQueueRow, id: string): void {
    if (id === 'review') {
      this.openPlayerReview(row);
    } else if (id === 'reject') {
      this.askConfirm(row, 'reject');
    }
  }

  protected askConfirm(row: WithdrawalQueueRow, action: 'pay' | 'reject'): void {
    this.confirmation.set({ action, row });
  }

  protected closeConfirm(): void {
    this.confirmation.set(null);
  }

  protected async confirmAction(): Promise<void> {
    const current = this.confirmation();
    if (!current) {
      return;
    }
    this.closeConfirm();
    const body: WithdrawRequest = {
      transaction_ids: current.row.transactions.map((tx) => tx.id),
      guild_tenant_id: current.row.guild_tenant_id ?? undefined,
    };
    if (current.action === 'pay') {
      await this.mutate('api/bank/transactions/withdraw/accept', 'admin.withdrawals.paidToast', body);
    } else {
      await this.mutate('api/bank/transactions/withdraw/reject', 'admin.withdrawals.rejectedToast', body);
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

  protected setTx(id: number, checked: boolean): void {
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

  protected toggleAllTxs(checked: boolean): void {
    const row = this.reviewingPlayer();
    if (!row) return;
    this.selectedTxIds.set(checked ? new Set(row.transactions.map((t) => t.id)) : new Set<number>());
  }

  protected txLabel(row: WithdrawalQueueRow, tx: TransactionView): string {
    const number = this.t('admin.withdrawals.transactionNo', { id: tx.id });
    return row.to_user_id === 0 ? `${tx.to_username} · ${number}` : number;
  }

  protected async acceptSelectedTxs(): Promise<void> {
    const ids = Array.from(this.selectedTxIds());
    if (ids.length === 0) return;
    const guildTenantId = this.reviewingPlayer()?.guild_tenant_id ?? undefined;
    this.closePlayerReview();
    await this.mutate('api/bank/transactions/withdraw/accept', 'admin.withdrawals.paidToast', {
      transaction_ids: ids,
      guild_tenant_id: guildTenantId,
    });
  }

  protected async rejectSelectedTxs(): Promise<void> {
    const ids = Array.from(this.selectedTxIds());
    if (ids.length === 0) return;
    const guildTenantId = this.reviewingPlayer()?.guild_tenant_id ?? undefined;
    this.closePlayerReview();
    await this.mutate('api/bank/transactions/withdraw/reject', 'admin.withdrawals.rejectedToast', {
      transaction_ids: ids,
      guild_tenant_id: guildTenantId,
    });
  }

  protected async acceptSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/accept', 'admin.withdrawals.paidToast', {
      transaction_ids: [id],
      guild_tenant_id: this.guildTenantIdForTx(id),
    });
  }

  protected async rejectSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/reject', 'admin.withdrawals.rejectedToast', {
      transaction_ids: [id],
      guild_tenant_id: this.guildTenantIdForTx(id),
    });
  }

  private guildTenantIdForTx(id: number): string | undefined {
    return this.transactions().find((tx) => tx.id === id)?.guild_tenant_id ?? undefined;
  }

  /** Table rows of the active tab. Only the newest request wins, so a fast tab change cannot show stale rows. */
  protected async loadRows(): Promise<void> {
    const request = ++this.rowsRequest;
    this.loading.set(this.transactions().length === 0);
    this.loadFailed.set(false);
    try {
      const data = await this.fetchTransactions({
        status: statusFilter(this.statusTab()),
        limit: GROUPING_FETCH_LIMIT,
        query: this.tableQuery(),
      });
      if (request === this.rowsRequest) {
        this.transactions.set(data.items);
      }
    } catch {
      if (request === this.rowsRequest) {
        this.loadFailed.set(true);
        this.toasts.error(this.t('common.error'));
      }
    } finally {
      if (request === this.rowsRequest) {
        this.loading.set(false);
      }
    }
  }

  /** Summary band and tab counts. Unaffected by search, sort or the active tab. */
  protected async loadSummary(): Promise<void> {
    this.summaryFailed.set(false);
    try {
      const [queue, pending, withdrawn, rejected, all] = await Promise.all([
        this.fetchTransactions({ status: 'requested', limit: GROUPING_FETCH_LIMIT }),
        this.fetchTransactions({ status: 'pending', limit: 1 }),
        this.fetchTransactions({ status: 'withdrawn', limit: 1 }),
        this.fetchTransactions({ status: 'rejected', limit: 1 }),
        this.fetchTransactions({ status: null, limit: 1 }),
      ]);
      this.queue.set(queue.items);
      this.tabCounts.set({
        requested: queue.total_items,
        pending: pending.total_items,
        withdrawn: withdrawn.total_items,
        rejected: rejected.total_items,
        all: all.total_items,
      });
      this.summaryLoaded.set(true);
    } catch {
      this.summaryFailed.set(true);
      this.toasts.error(this.t('common.error'));
    }
  }

  private fetchTransactions(options: {
    status: TransactionStatus | null;
    limit: number;
    query?: DataTablePageChange;
  }): Promise<PaginatedData<TransactionView>> {
    const params: Record<string, string | number | boolean> = {
      page: 1,
      limit: options.limit,
      global: true,
    };
    const query = options.query;
    if (query?.search.trim()) {
      params['search'] = query.search.trim();
    }
    if (query?.sort) {
      params['sort'] = query.sort.columnKey;
      params['order'] = query.sort.direction;
    }
    if (options.status) {
      params['status'] = options.status;
    }
    return firstValueFrom(this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', params));
  }

  private async mutate(path: string, successKey: TranslationKey, body: WithdrawRequest): Promise<void> {
    try {
      await firstValueFrom(this.api.post<TransactionView[]>(path, body));
    } catch {
      this.toasts.error(this.t('common.error'));
      return;
    }
    this.toasts.success(this.t(successKey));
    await this.refresh();
  }

  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    const lang = this.translate.locale();
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
      Number.isFinite(numeric) ? numeric : 0,
    );
  }

  protected formatDate(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleDateString(this.translate.locale());
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

function sameTableQuery(a: DataTablePageChange, b: DataTablePageChange): boolean {
  return (
    a.page === b.page &&
    a.pageSize === b.pageSize &&
    a.search === b.search &&
    a.sort?.columnKey === b.sort?.columnKey &&
    a.sort?.direction === b.sort?.direction
  );
}
