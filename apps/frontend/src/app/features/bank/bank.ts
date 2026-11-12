import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
  GuildBalanceBreakdown,
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
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { DataTableFooterCell } from '../../shared/components/data-table/data-table-footer-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import type { MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

export interface WithdrawalSelectableGroup {
  readonly key: string;
  readonly primaryId: number;
  readonly transactionIds: number[];
  readonly splitId: number | null;
  readonly status: TransactionStatus;
  readonly amount: number;
  readonly createdAt: string;
  readonly guildTenantId?: string | null;
  readonly guildName?: string | null;
}

type BankSection = 'movements' | 'balances';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Personal Guild Bank ledger.
 *
 * Purely "what do I have, what have I asked for" — a member's own split
 * earnings and their withdrawal requests. Reviewing and paying out the
 * *guild's* requests is a separate officer workspace at `/admin/withdrawals`;
 * this page used to switch shape depending on who was looking at it, which
 * made "where do I go to see/request my split" ambiguous. Now it only ever
 * shows one thing.
 *
 * Alliance tenants also get a per-guild balance table, switched in with tabs.
 */
@Component({
  selector: 'app-bank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    DataTableFooterCell,
    Dialog,
    ErrorState,
    FilterBar,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    Select,
    StatusChip,
    SummaryBand,
    Tabs,
    TooltipDirective,
  ],
  template: `
    <app-page-header
      [title]="t(isAlliance() ? 'bank.alliance.title' : 'bank.title')"
      [subtitle]="t(isAlliance() ? 'bank.alliance.subtitle' : 'bank.subtitle')"
      [menuItems]="menuItems()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onMenu($event)"
    >
      <button
        type="button"
        class="btn btn--primary btn--sm"
        [disabled]="(balance()?.pending_total ?? 0) <= 0"
        (click)="openWithdrawal()"
        [appTooltip]="t('bank.requestTooltip')"
        tooltipPosition="bottom"
      >
        <app-icon name="plus" size="0.875rem" />
        {{ t('bank.withdraw.request') }}
      </button>
    </app-page-header>

    <app-page-stack>
      @if (balanceFailed()) {
        <app-error-state
          [message]="t('common.error')"
          [retryLabel]="t('common.retry')"
          (retry)="loadBalance()"
        />
      } @else if (!balance()) {
        <app-loading variant="summary" [label]="t('common.loading')" />
      } @else {
        <app-summary-band [ariaLabel]="t('bank.personalSummary')" [items]="summaryItems()" />
      }

      @if (isAlliance()) {
        <app-tabs
          [ariaLabel]="t('bank.tabs.label')"
          [options]="sectionTabs()"
          [active]="activeSection()"
          (activeChange)="onSectionChange($event)"
        />
      }

      @if (activeSection() === 'movements') {
        <div class="space-y-3">
          <app-filter-bar
            [searchLabel]="t('bank.search.label')"
            [searchPlaceholder]="t('bank.search.placeholder')"
            [query]="search()"
            [activeCount]="activeFilterCount()"
            (queryChange)="onSearch($event)"
            (clear)="clearFilters()"
          >
            <label class="filter-field">
              <span class="filter-field__label">{{ t('common.status') }}</span>
              <select class="select select--sm" (change)="onStatusChange($event)">
                <option value="" [selected]="!status()">{{ t('common.all') }}</option>
                @for (option of statusOptions; track option) {
                  <option [value]="option" [selected]="status() === option">{{ statusLabel(option) }}</option>
                }
              </select>
            </label>
          </app-filter-bar>

          <app-data-table
            [ariaLabel]="t('bank.transactions.title')"
            [columns]="transactionColumns()"
            [rows]="transactions()"
            [loading]="loading()"
            [error]="transactionsLoadFailed()"
            (retry)="loadTransactions()"
            [trackBy]="trackRow"
            [serverMode]="true"
            [totalItems]="transactionTotal()"
            [pageSize]="10"
            [hideSearch]="true"
            [itemLabel]="t('bank.transactions.itemLabel')"
            [emptyLabel]="'bank.transactions.empty'"
            emptyIcon="bank"
            mobileLayout="stack"
            (pageChange)="onTableChange($event)"
          >
            <ng-template dataTableCell="transaction" let-row>
              <div class="min-w-[12rem]">
                <div class="flex flex-wrap items-center gap-2">
                  @if (row.split_id) {
                    <a
                      [routerLink]="['/splits', row.split_id]"
                      class="text-sm font-medium text-[var(--color-text)] hover:underline"
                    >
                      {{ t('bank.withdraw.split', { id: row.split_id }) }}
                    </a>
                  } @else {
                    <span class="text-sm font-medium text-[var(--color-text)]">
                      {{ transactionTypeLabel(row) }} #{{ row.id }}
                    </span>
                  }
                  @if (toNumber(row.amount) < 0) {
                    <span class="chip chip--neutral">{{ t('bank.type.clawback') }}</span>
                  }
                </div>
                <div class="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                  {{ row.from_label || t('bank.label.guildBank') }} &rarr;
                  {{ row.to_label || row.to_username || t('bank.label.member') }}
                </div>
              </div>
            </ng-template>

            <ng-template dataTableCell="guild" let-row>
              <span class="text-sm text-[var(--color-text)]">{{ row.guild_name || '—' }}</span>
            </ng-template>

            <ng-template dataTableCell="created_at" let-row>
              <div class="whitespace-nowrap">
                <div class="text-sm text-[var(--color-text)]">{{ formatDateDay(row.created_at) }}</div>
                <div class="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                  {{ formatDateTime(row.created_at) }}
                </div>
              </div>
            </ng-template>

            <ng-template dataTableCell="status" let-row>
              <app-status-chip
                [value]="row.status"
                [label]="statusLabel(row.status)"
                [icon]="statusIcon(row.status)"
              />
            </ng-template>

            <ng-template dataTableCell="amount" let-row>
              <span
                class="num text-sm font-semibold"
                [class.text-success]="toNumber(row.amount) > 0 && (row.status === 'withdrawn' || row.status === 'pending')"
                [class.text-warning]="toNumber(row.amount) > 0 && row.status === 'requested'"
                [class.text-error]="toNumber(row.amount) < 0 || row.status === 'rejected'"
              >{{ formatAmount(row.amount) }}</span>
              <span class="hint ml-1">{{ t('bank.unit.silver') }}</span>
            </ng-template>
          </app-data-table>
        </div>
      } @else {
        <app-data-table
          [ariaLabel]="t('bank.alliance.breakdown')"
          [columns]="balanceColumns()"
          [rows]="guildRows()"
          [trackBy]="trackGuild"
          [hideSearch]="true"
          [hidePageSize]="true"
          [emptyLabel]="'bank.balances.empty'"
          emptyIcon="bank"
        >
          <ng-template dataTableCell="pending" let-row>
            <span class="num text-sm font-semibold text-[var(--color-text)]">{{ formatAmount(row.pending_total) }}</span>
            <span class="hint ml-1">{{ t('bank.unit.silver') }}</span>
            <div class="hint">{{ t('bank.creditsAvailable', { count: row.pending_count }) }}</div>
          </ng-template>

          <ng-template dataTableCell="requested" let-row>
            <span class="num text-sm font-semibold text-[var(--color-text)]">{{ formatAmount(row.requested_total) }}</span>
            <span class="hint ml-1">{{ t('bank.unit.silver') }}</span>
            <div class="hint">{{ t('bank.withdrawalsInReview', { count: row.requested_count }) }}</div>
          </ng-template>

          <ng-template dataTableFooterCell="pending">
            <span class="num font-semibold">{{ formatAmount(balanceTotals().pending) }}</span>
          </ng-template>

          <ng-template dataTableFooterCell="requested">
            <span class="num font-semibold">{{ formatAmount(balanceTotals().requested) }}</span>
          </ng-template>
        </app-data-table>
      }
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
          @if (isAlliance() && pendingGuilds().length > 1) {
            <div class="space-y-1.5">
              <span id="withdrawal-guild-label" class="label">{{ t('bank.withdraw.chooseGuild') }}</span>
              <app-select
                ariaLabelledBy="withdrawal-guild-label"
                [value]="withdrawGuildId()"
                [options]="guildOptions()"
                (valueChange)="onWithdrawGuildChange($event)"
              />
            </div>
          }

          <!-- Net balance available for selected guild -->
          <div class="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
            <div>
              <span class="label">{{ t('bank.withdraw.netAvailable') }}</span>
              <p class="hint">
                {{ t('bank.creditsAvailable', { count: groupedRequestableCredits().length || withdrawalAvailableCount() }) }}
              </p>
            </div>
            <div class="text-right">
              <span class="num text-2xl font-bold text-success">
                {{ formatAmount(withdrawalAvailableBalance()) }}
              </span>
              <span class="hint block">{{ t('bank.unit.silver') }}</span>
            </div>
          </div>

          <fieldset class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <legend class="label">{{ t('bank.withdraw.selectCredits') }}</legend>
              @if (groupedRequestableCredits().length > 0) {
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  [disabled]="withdrawing() || loadingRequestableCredits()"
                  (click)="toggleSelectAllWithdrawalCredits()"
                >
                  <app-icon [name]="allSelectableCreditsSelected() ? 'close' : 'check'" size="0.75rem" />
                  {{ allSelectableCreditsSelected() ? t('bank.withdraw.deselectAll') : t('bank.withdraw.selectAll') }}
                </button>
              }
            </div>
            <p id="withdrawal-selection-hint" class="hint">
              {{ t('bank.withdraw.selectionHint') }}
            </p>

            @if (loadingRequestableCredits()) {
              <app-loading variant="lines" [rows]="3" [label]="t('common.loading')" />
            } @else if (requestableCreditsLoadFailed()) {
              <app-error-state
                [message]="t('bank.withdraw.creditsLoadFailed')"
                [retryLabel]="t('common.retry')"
                (retry)="retryRequestableCredits()"
              />
            } @else if (groupedRequestableCredits().length === 0) {
              <p class="py-3 text-sm text-[var(--color-text-secondary)]">
                {{ t('bank.withdraw.noCredits') }}
              </p>
            } @else {
              <div class="max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
                @for (group of groupedRequestableCredits(); track group.key) {
                  <label
                    [attr.for]="'withdrawal-credit-' + group.primaryId"
                    class="flex min-h-12 cursor-pointer select-none items-center gap-2.5 rounded-lg border p-2.5 transition-colors"
                    [class.border-[var(--color-primary)]]="isWithdrawalGroupSelected(group)"
                    [class.bg-[var(--color-surface-2)]]="isWithdrawalGroupSelected(group)"
                    [class.border-[var(--color-border)]]="!isWithdrawalGroupSelected(group)"
                    [class.bg-[var(--color-surface-1)]]="!isWithdrawalGroupSelected(group)"
                    [class.opacity-50]="!canSelectWithdrawalGroup(group)"
                    [class.cursor-not-allowed]="!canSelectWithdrawalGroup(group)"
                  >
                    <input
                      type="checkbox"
                      name="transaction_ids"
                      [id]="'withdrawal-credit-' + group.primaryId"
                      [checked]="isWithdrawalGroupSelected(group)"
                      [disabled]="withdrawing() || !canSelectWithdrawalGroup(group)"
                      aria-describedby="withdrawal-selection-hint"
                      class="size-4 accent-[var(--color-primary)] shrink-0"
                      (change)="toggleWithdrawalGroup(group)"
                    />
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
                        @if (group.splitId) {
                          <app-icon name="swords" size="0.875rem" class="text-[var(--color-primary)] shrink-0" />
                          <span>{{ t('bank.withdraw.split', { id: group.splitId }) }}</span>
                        } @else {
                          <app-icon name="coins" size="0.875rem" class="text-[var(--color-text-secondary)] shrink-0" />
                          <span>{{ t('bank.withdraw.credit', { id: group.primaryId }) }}</span>
                        }
                        @if (group.transactionIds.length > 1) {
                          <span class="chip chip--neutral">
                            {{ t('bank.withdraw.consolidatedHint', { count: group.transactionIds.length }) }}
                          </span>
                        }
                      </span>
                      <span class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                        <span>{{ statusLabel(group.status) }}</span>
                        <span>&middot;</span>
                        <span>{{ formatDateDay(group.createdAt) }}</span>
                        @if (!group.splitId) {
                          <span>&middot;</span>
                          <span>#{{ group.primaryId }}</span>
                        }
                      </span>
                    </span>
                    <span class="whitespace-nowrap text-right">
                      <span class="num block text-sm font-bold text-success">
                        +{{ formatAmount(group.amount) }}
                      </span>
                      <span class="hint block">{{ t('bank.unit.silver') }}</span>
                    </span>
                  </label>
                }
              </div>
            }
          </fieldset>

          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5"
            aria-live="polite"
            aria-atomic="true"
          >
            <span class="text-sm font-medium text-[var(--color-text)]">
              {{ t('bank.withdraw.selectedTotal') }}
              <span class="ml-1 text-xs text-[var(--color-text-secondary)]">
                ({{ t('bank.withdraw.selectedCount', { count: selectedGroupCount() }) }})
              </span>
            </span>
            <span class="num whitespace-nowrap text-base font-bold text-success">
              {{ formatAmount(withdrawalSelectionTotal()) }} {{ t('bank.unit.silver') }}
            </span>
          </div>

          <!-- Info Card -->
          <div class="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5">
            <app-icon name="info" size="1.125rem" class="mt-0.5 shrink-0 text-warning" />
            <div class="space-y-1 text-xs text-[var(--color-text-secondary)]">
              <p class="font-medium text-[var(--color-text)]">
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
            [disabled]="
              withdrawing() ||
              loadingRequestableCredits() ||
              requestableCreditsLoadFailed() ||
              selectedWithdrawalIds().length === 0
            "
            (click)="executeWithdrawal()"
          >
            <app-icon name="check" size="0.875rem" />
            {{ withdrawing() ? t('common.loading') : t('bank.withdraw.request') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Bank {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly translate = inject(TranslateService);

  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly balanceFailed = signal(false);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly transactionTotal = signal(0);
  protected readonly loading = signal(false);
  protected readonly transactionsLoadFailed = signal(false);

  /** Movement filters. The table's own search box is hidden; these drive the server query. */
  protected readonly search = signal('');
  protected readonly status = signal<TransactionStatus | ''>('');
  protected readonly statusOptions: readonly TransactionStatus[] = [
    'pending',
    'requested',
    'withdrawn',
    'rejected',
    'donated',
  ];
  protected readonly activeFilterCount = computed(
    () => (this.search().trim() ? 1 : 0) + (this.status() ? 1 : 0),
  );

  protected readonly section = signal<BankSection>('movements');

  protected readonly confirmWithdrawalOpen = signal(false);
  protected readonly withdrawing = signal(false);

  protected readonly isAlliance = computed(() => this.auth.profile()?.tenant_kind === 'alliance');
  protected readonly activeSection = computed<BankSection>(() =>
    this.isAlliance() ? this.section() : 'movements',
  );
  protected readonly pendingGuilds = computed<GuildBalanceBreakdown[]>(() =>
    (this.balance()?.guilds ?? []).filter((guild) => Number(guild.pending_total) > 0),
  );
  protected readonly guildRows = computed<readonly GuildBalanceBreakdown[]>(
    () => this.balance()?.guilds ?? [],
  );
  protected readonly balanceTotals = computed(() =>
    this.guildRows().reduce(
      (totals, guild) => ({
        pending: totals.pending + (Number(guild.pending_total) || 0),
        requested: totals.requested + (Number(guild.requested_total) || 0),
      }),
      { pending: 0, requested: 0 },
    ),
  );
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const balance = this.balance();
    if (!balance) {
      return [];
    }
    return [
      {
        label: this.t('bank.balance.available'),
        value: `${this.formatAmount(balance.pending_total)} ${this.t('bank.unit.silver')}`,
        hint: this.t('bank.creditsAvailable', { count: balance.pending_count }),
      },
      {
        label: this.t('bank.balance.requested'),
        value: `${this.formatAmount(balance.requested_total)} ${this.t('bank.unit.silver')}`,
        hint: this.t('bank.withdrawalsInReview', { count: balance.requested_count }),
        tone: balance.requested_count > 0 ? 'warning' : 'default',
      },
    ];
  });
  protected readonly sectionTabs = computed<TabOption[]>(() => [
    { id: 'movements', label: this.t('bank.tabs.movements'), count: this.transactionTotal() },
    { id: 'balances', label: this.t('bank.alliance.breakdown'), count: this.guildRows().length },
  ]);
  protected readonly menuItems = computed<MenuItem[]>(() => [
    { id: 'refresh', label: this.t('common.refreshNow'), icon: 'sparkles' },
    ...(this.canReviewRequests()
      ? [{ id: 'review', label: this.t('bank.reviewRequests'), icon: 'bank' as IconName }]
      : []),
  ]);
  protected readonly withdrawGuildId = signal('');
  protected readonly guildOptions = computed<SelectOption[]>(() =>
    this.pendingGuilds().map((guild) => ({
      value: guild.guild_tenant_id,
      label: `${guild.guild_name} — ${this.formatAmount(guild.pending_total)}`,
    })),
  );
  protected readonly requestableCredits = signal<TransactionView[]>([]);
  protected readonly selectedWithdrawalIds = signal<number[]>([]);
  protected readonly loadingRequestableCredits = signal(false);
  protected readonly requestableCreditsLoadFailed = signal(false);
  private readonly selectedGuildBalance = computed(() => {
    const guilds = this.balance()?.guilds ?? [];
    const guildTenantId = this.withdrawGuildId() || guilds[0]?.guild_tenant_id;
    return guilds.find((guild) => guild.guild_tenant_id === guildTenantId) ?? null;
  });

  /**
   * Consolidates requestable transactions by split_id so that even if legacy rows exist
   * for the same split (including negative adjustments), the user sees a single row per
   * Split with the updated net positive amount.
   */
  protected readonly groupedRequestableCredits = computed<WithdrawalSelectableGroup[]>(() => {
    const groups = new Map<string, WithdrawalSelectableGroup>();
    for (const credit of this.requestableCredits()) {
      const amount = Number(credit.amount) || 0;
      const key =
        credit.split_id != null
          ? `split:${credit.guild_tenant_id ?? ''}:${credit.split_id}`
          : `tx:${credit.guild_tenant_id ?? ''}:${credit.id}`;
      const existing = groups.get(key);
      if (existing) {
        if (amount > 0) {
          existing.transactionIds.push(credit.id);
          if (existing.transactionIds.length === 1) {
            (existing as { primaryId: number }).primaryId = credit.id;
          }
        }
        (existing as { amount: number }).amount =
          Math.round((existing.amount + amount) * 100) / 100;
        if (credit.status === 'pending') {
          (existing as { status: TransactionStatus }).status = 'pending';
        }
      } else {
        groups.set(key, {
          key,
          primaryId: credit.id,
          transactionIds: amount > 0 ? [credit.id] : [],
          splitId: credit.split_id ?? null,
          status: credit.status,
          amount,
          createdAt: credit.created_at,
          guildTenantId: credit.guild_tenant_id,
          guildName: credit.guild_name,
        });
      }
    }
    return [...groups.values()].filter((group) => group.amount > 0);
  });

  protected readonly withdrawalSelectionTotal = computed(() => {
    const selectedIds = new Set(this.selectedWithdrawalIds());
    return this.groupedRequestableCredits().reduce(
      (total, group) =>
        group.transactionIds.every((id) => selectedIds.has(id)) ? total + group.amount : total,
      0,
    );
  });
  protected readonly selectedGroupCount = computed(() => {
    const selectedIds = new Set(this.selectedWithdrawalIds());
    return this.groupedRequestableCredits().filter((group) =>
      group.transactionIds.every((id) => selectedIds.has(id)),
    ).length;
  });
  protected readonly allSelectableCreditsSelected = computed(() => {
    const groups = this.groupedRequestableCredits();
    if (groups.length === 0) {
      return false;
    }
    const selectedCount = this.selectedGroupCount();
    if (selectedCount === groups.length) {
      return true;
    }
    return (
      selectedCount > 0 &&
      groups.every(
        (group) => this.isWithdrawalGroupSelected(group) || !this.canSelectWithdrawalGroup(group),
      )
    );
  });
  protected readonly withdrawalAvailableBalance = computed(() =>
    this.isAlliance()
      ? Number(this.selectedGuildBalance()?.pending_total ?? 0)
      : Number(this.balance()?.pending_total ?? 0),
  );
  protected readonly withdrawalAvailableCount = computed(() =>
    this.isAlliance()
      ? (this.selectedGuildBalance()?.pending_count ?? 0)
      : (this.balance()?.pending_count ?? 0),
  );
  protected readonly trackRow = (row: TransactionView): string =>
    `${row.guild_tenant_id ?? ''}:${row.id}`;
  protected readonly trackGuild = (row: GuildBalanceBreakdown): string => row.guild_tenant_id;
  private requestableCreditsLoadSequence = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly tableQuery = signal<DataTablePageChange>(
    parseDataTableQuery(this.route.snapshot.queryParamMap, { defaultPageSize: 10 }),
  );

  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => {
    this.translate.dict();
    return [
      {
        key: 'transaction',
        label: 'bank.col.movement',
        sortable: false,
        accessor: (row) => row.id,
      },
      ...(this.isAlliance()
        ? [
            {
              key: 'guild',
              label: 'bank.guild',
              sortable: true,
              accessor: (row: TransactionView) => row.guild_name ?? '',
            } satisfies DataTableColumn<TransactionView>,
          ]
        : []),
      {
        key: 'created_at',
        label: 'common.date',
        sortable: true,
        accessor: (row) => row.created_at,
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
    ];
  });

  protected readonly balanceColumns = computed<DataTableColumn<GuildBalanceBreakdown>[]>(() => {
    this.translate.dict();
    return [
      {
        key: 'guild',
        label: 'bank.guild',
        sortable: false,
        accessor: (row) => row.guild_name,
      },
      {
        key: 'pending',
        label: 'bank.balance.available',
        sortable: false,
        accessor: (row) => Number(row.pending_total) || 0,
        align: 'right',
      },
      {
        key: 'requested',
        label: 'bank.balance.requested',
        sortable: false,
        accessor: (row) => Number(row.requested_total) || 0,
        align: 'right',
      },
    ];
  });

  protected formatDateDay(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString(this.translate.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  }

  protected formatDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
    });
    void this.load();
  }

  protected canReviewRequests(): boolean {
    return this.auth.hasPermission('bank.withdraw.accept');
  }

  protected onMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    } else if (id === 'review') {
      void this.router.navigate(['/admin/withdrawals']);
    }
  }

  protected onSectionChange(id: string): void {
    this.section.set(id === 'balances' ? 'balances' : 'movements');
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onStatusChange(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value as TransactionStatus | '');
    this.applyFilters();
  }

  protected clearFilters(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.search.set('');
    this.status.set('');
    this.applyFilters();
  }

  protected onWithdrawGuildChange(guildTenantId: string): void {
    this.withdrawGuildId.set(guildTenantId);
    this.selectedWithdrawalIds.set([]);
    void this.loadRequestableCredits(guildTenantId);
  }

  protected openWithdrawal(): void {
    const pending = this.pendingGuilds();
    if (!pending.some((guild) => guild.guild_tenant_id === this.withdrawGuildId()) && pending[0]) {
      this.withdrawGuildId.set(pending[0].guild_tenant_id);
    }
    const guildTenantId = this.isAlliance()
      ? this.withdrawGuildId() || pending[0]?.guild_tenant_id
      : undefined;
    this.selectedWithdrawalIds.set([]);
    this.confirmWithdrawalOpen.set(true);
    void this.loadRequestableCredits(guildTenantId);
  }

  protected isWithdrawalGroupSelected(group: WithdrawalSelectableGroup): boolean {
    const selectedIds = new Set(this.selectedWithdrawalIds());
    return group.transactionIds.length > 0 && group.transactionIds.every((id) => selectedIds.has(id));
  }

  protected canSelectWithdrawalGroup(group: WithdrawalSelectableGroup): boolean {
    if (this.isWithdrawalGroupSelected(group)) {
      return true;
    }
    return (
      this.toSilverCents(this.withdrawalSelectionTotal()) + this.toSilverCents(group.amount) <=
      this.toSilverCents(this.withdrawalAvailableBalance())
    );
  }

  protected toggleWithdrawalGroup(group: WithdrawalSelectableGroup): void {
    const groupIds = new Set(group.transactionIds);
    if (this.isWithdrawalGroupSelected(group)) {
      this.selectedWithdrawalIds.update((ids) => ids.filter((id) => !groupIds.has(id)));
      return;
    }
    if (!this.canSelectWithdrawalGroup(group)) {
      return;
    }
    this.selectedWithdrawalIds.update((ids) => {
      const next = new Set(ids);
      for (const id of group.transactionIds) {
        next.add(id);
      }
      return [...next];
    });
  }

  protected toggleSelectAllWithdrawalCredits(): void {
    if (this.allSelectableCreditsSelected()) {
      this.selectedWithdrawalIds.set([]);
      return;
    }

    const availableCents = this.toSilverCents(this.withdrawalAvailableBalance());
    let runningCents = 0;
    const nextIds: number[] = [];

    for (const group of this.groupedRequestableCredits()) {
      const groupCents = this.toSilverCents(group.amount);
      if (groupCents > 0 && runningCents + groupCents <= availableCents) {
        runningCents += groupCents;
        nextIds.push(...group.transactionIds);
      }
    }
    this.selectedWithdrawalIds.set(nextIds);
  }

  protected toNumber(value: number | string | null | undefined): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  protected transactionTypeLabel(row: TransactionView | string): string {
    const type = typeof row === 'string' ? row : row.type;
    if (typeof row !== 'string' && this.toNumber(row.amount) < 0) {
      return this.t('bank.type.clawback');
    }
    switch (type) {
      case 'split_credit':
      case 'split':
        return this.t('bank.type.splitCredit');
      case 'split_donation':
        return this.t('bank.type.splitDonation');
      case 'manual_adjustment':
        return this.t('bank.type.manualAdjustment');
      default:
        return type.replace(/_/g, ' ');
    }
  }

  protected retryRequestableCredits(): void {
    const pending = this.pendingGuilds();
    const guildTenantId = this.isAlliance()
      ? this.withdrawGuildId() || pending[0]?.guild_tenant_id
      : undefined;
    void this.loadRequestableCredits(guildTenantId);
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.loadTransactions();
  }

  protected async executeWithdrawal(): Promise<void> {
    if (this.withdrawing()) {
      return;
    }
    const pending = this.pendingGuilds();
    const guildTenantId =
      this.withdrawGuildId() || (pending.length === 1 ? pending[0]?.guild_tenant_id : '');
    if (this.isAlliance() && pending.length > 1 && !guildTenantId) {
      this.toasts.error(this.t('bank.withdraw.chooseGuild'));
      return;
    }
    const transactionIds = this.selectedWithdrawalIds();
    if (transactionIds.length === 0) {
      return;
    }
    this.withdrawing.set(true);
    this.confirmWithdrawalOpen.set(false);
    try {
      const body: WithdrawRequest = { transaction_ids: transactionIds };
      if (this.isAlliance() && guildTenantId) {
        body.guild_tenant_id = guildTenantId;
      }
      await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', body);
    } finally {
      this.withdrawing.set(false);
    }
  }

  private async loadRequestableCredits(guildTenantId?: string): Promise<void> {
    const sequence = ++this.requestableCreditsLoadSequence;
    this.requestableCredits.set([]);
    this.selectedWithdrawalIds.set([]);
    this.loadingRequestableCredits.set(true);
    this.requestableCreditsLoadFailed.set(false);
    try {
      const [pending, rejected] = await Promise.all([
        this.loadTransactionsByStatus('pending'),
        this.loadTransactionsByStatus('rejected'),
      ]);
      if (sequence !== this.requestableCreditsLoadSequence) {
        return;
      }
      this.requestableCredits.set(
        [...pending, ...rejected].filter(
          (transaction) =>
            (Number(transaction.amount) > 0 || transaction.split_id != null) &&
            (!this.isAlliance() || transaction.guild_tenant_id === guildTenantId),
        ),
      );
    } catch {
      if (sequence === this.requestableCreditsLoadSequence) {
        this.requestableCreditsLoadFailed.set(true);
      }
    } finally {
      if (sequence === this.requestableCreditsLoadSequence) {
        this.loadingRequestableCredits.set(false);
      }
    }
  }

  private async loadTransactionsByStatus(status: TransactionStatus): Promise<TransactionView[]> {
    const limit = 1000;
    const all: TransactionView[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', {
          page,
          limit,
          status,
        }),
      );
      all.push(...data.items);
      totalPages = data.total_pages;
      page += 1;
    } while (page <= totalPages);
    return all;
  }

  private toSilverCents(amount: number | string | null | undefined): number {
    const numeric = Number(amount ?? 0);
    return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
  }

  private async load(): Promise<void> {
    await Promise.all([this.loadBalance(), this.loadTransactions()]);
  }

  protected async loadBalance(): Promise<void> {
    this.balanceFailed.set(false);
    try {
      const data = await firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance'));
      this.balance.set(data);
    } catch {
      this.balanceFailed.set(true);
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
      const search = this.search().trim();
      if (search) {
        params['search'] = search;
      }
      if (query.sort) {
        params['sort'] = query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const status = this.status();
      if (status) {
        params['status'] = status;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', params),
      );
      this.transactions.set(data.items);
      this.transactionTotal.set(data.total_items);
    } catch {
      this.transactionsLoadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Any filter change resets the table to page 1. The table's page lives in its own state (kept
   * in sync with the URL), so the page is reset there too; the navigation may also make the table
   * emit `pageChange`, which only re-fetches the same page.
   */
  private applyFilters(): void {
    this.tableQuery.update((query) => ({ ...query, page: 1 }));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.loadTransactions();
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
    const lang = this.translate.locale();
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(
      Number.isFinite(numeric) ? numeric : 0,
    );
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
