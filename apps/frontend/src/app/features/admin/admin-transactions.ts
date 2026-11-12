import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateTransactionRequest,
  PaginatedData,
  TransactionStatus,
  TransactionView,
  UpdateTransactionRequest,
  UserProfile,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { DataTableFooterCell } from '../../shared/components/data-table/data-table-footer-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';

const STATUSES: readonly TransactionStatus[] = [
  'pending',
  'requested',
  'rejected',
  'withdrawn',
  'donated',
];
const DEFAULT_TYPE = 'manual_adjustment';
/** The backend caps one page at 1000 rows; the ledger is read in as few pages as possible. */
const LEDGER_PAGE_SIZE = 1000;

/** Which recipient/payer field the roster search dialog is currently filling. */
type RosterTarget = 'create-to' | 'create-from' | 'edit-to' | 'edit-from';

interface LedgerSummary {
  readonly outstanding: number;
  readonly outstandingCount: number;
  readonly paid: number;
  readonly paidCount: number;
  readonly donated: number;
  readonly donatedCount: number;
}

/** Rounds to cents so sums of decimal amounts do not drift. */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The local calendar day (`YYYY-MM-DD`) of an ISO timestamp, or `''` when it cannot be read. */
function localDay(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Full guild ledger, with manual create/edit/delete for administrators.
 *
 * `GET /api/bank/transactions?global=true` already backs the withdrawal queue and every
 * member's personal ledger. The endpoint filters by status, recipient name and split only, so
 * this page reads the whole ledger once and applies the member, type, status and date filters,
 * the sort and the totals on the client. That keeps the filters and the period totals exact
 * across pages. The filter state is mirrored to the URL, so a finance KPI can deep-link here.
 */
@Component({
  selector: 'app-admin-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    DataTableFooterCell,
    Dialog,
    FilterBar,
    Icon,
    Loading,
    Menu,
    PageHeader,
    Select,
    PageStack,
    RouterLink,
    SearchDialog,
    StatusChip,
    Stat,
    SummaryBand,
  ],
  template: `
    <app-page-header [title]="t('admin.transactions.title')" [subtitle]="t('admin.transactions.hint')">
      @if (canCreate()) {
        <button type="button" class="btn btn--primary" (click)="openCreate()">
          {{ t('admin.transactions.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="summary" [label]="t('common.loading')" />
      } @else if (!loadFailed()) {
        <app-summary-band [ariaLabel]="t('admin.transactions.summary.label')">
          <app-stat
            [label]="t('admin.transactions.summary.outstanding')"
            [value]="formatAmount(summary().outstanding)"
            tone="warning"
            [hint]="t('admin.transactions.summary.outstandingHint', { count: summary().outstandingCount })"
          />
          <app-stat
            [label]="t('admin.transactions.summary.paid')"
            [value]="formatAmount(summary().paid)"
            [hint]="t('admin.transactions.summary.paidHint', { count: summary().paidCount })"
          />
          <app-stat
            [label]="t('admin.transactions.summary.donated')"
            [value]="formatAmount(summary().donated)"
            [hint]="t('admin.transactions.summary.donatedHint', { count: summary().donatedCount })"
          />
        </app-summary-band>
      }

      <app-filter-bar
        [searchLabel]="t('admin.transactions.filters.member')"
        [searchPlaceholder]="t('admin.transactions.filters.memberPlaceholder')"
        [query]="memberQuery()"
        [activeCount]="activeFilterCount()"
        (queryChange)="onMemberChange($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('common.status') }}</span>
          <select class="select select--sm" (change)="onStatusFilter($event)">
            <option value="" [selected]="!statusFilter()">{{ t('admin.transactions.filters.allStatuses') }}</option>
            @for (status of statuses; track status) {
              <option [value]="status" [selected]="statusFilter() === status">{{ statusLabel(status) }}</option>
            }
          </select>
        </label>
        <label class="filter-field">
          <span class="filter-field__label">{{ t('admin.transactions.fields.type') }}</span>
          <select class="select select--sm" (change)="onTypeFilter($event)">
            <option value="" [selected]="!typeFilter()">{{ t('admin.transactions.filters.allTypes') }}</option>
            @for (type of typeOptions(); track type) {
              <option [value]="type" [selected]="typeFilter() === type">{{ type }}</option>
            }
          </select>
        </label>
        <label class="filter-field">
          <span class="filter-field__label">{{ t('admin.transactions.filters.dateFrom') }}</span>
          <input class="input input--sm" type="date" [value]="dateFrom()" (change)="onDateFilter('from', $event)" />
        </label>
        <label class="filter-field">
          <span class="filter-field__label">{{ t('admin.transactions.filters.dateTo') }}</span>
          <input class="input input--sm" type="date" [value]="dateTo()" (change)="onDateFilter('to', $event)" />
        </label>
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="filtered()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [hideSearch]="true"
        [syncUrl]="false"
        [bordered]="true"
        [stickyFirstColumn]="true"
        [pageSize]="25"
        [ariaLabel]="t('admin.transactions.tableLabel')"
        [footerLabel]="t('admin.transactions.totalRow')"
        emptyIcon="bank"
        [emptyLabel]="emptyKey()"
      >
        <ng-template dataTableCell="to_username" let-row>
          <span class="font-medium">{{ rowName(row) }}</span>
        </ng-template>
        <ng-template dataTableCell="amount" let-row>
          <span class="num font-semibold" [style.color]="amountColor(row.amount)">{{ formatSignedAmount(row.amount) }}</span>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <app-status-chip
            [value]="row.status"
            [label]="statusLabel(row.status)"
            [icon]="statusIcon(row.status)"
          />
        </ng-template>
        <ng-template dataTableCell="split_id" let-row>
          @if (row.split_id) {
            <a class="text-primary no-underline hover:underline" [routerLink]="['/splits', row.split_id]">
              #{{ row.split_id }}
            </a>
          } @else {
            <span style="color: var(--color-text-secondary)">&mdash;</span>
          }
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
        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end">
            <app-menu
              [items]="rowMenu(row)"
              [label]="t('admin.transactions.rowMenu', { name: rowName(row) })"
              (itemSelect)="onRowAction(row, $event)"
            />
          </div>
        </ng-template>
        <ng-template dataTableFooterCell="amount">
          <span class="num font-semibold" [style.color]="amountColor(netTotal())">{{ formatSignedAmount(netTotal()) }}</span>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('admin.transactions.create')" (closed)="closeCreate()">
        <form id="create-transaction-form" class="grid gap-4" (submit)="onCreate($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('validation.requiredLegend') }}</p>
          <p class="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 text-sm text-[var(--color-text)]">
            {{ t('admin.transactions.fields.amountHint') }}
          </p>
          <div class="block">
            <span id="create-transaction-recipient-label" class="label">
              {{ t('admin.transactions.fields.to') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <div
              class="mt-1"
              role="group"
              aria-labelledby="create-transaction-recipient-label"
              [attr.aria-invalid]="createRecipientError() ? 'true' : null"
              [attr.aria-describedby]="createRecipientError()
                ? 'create-transaction-recipient-required create-transaction-recipient-error'
                : 'create-transaction-recipient-required'"
            >
              <span id="create-transaction-recipient-required" class="sr-only">
                {{ t('validation.required') }}
              </span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ newToUserName() || t('admin.transactions.fields.pickUser') }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('create-to')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
            </div>
              @if (createRecipientError()) {
                <span id="create-transaction-recipient-error" class="mt-1 block text-xs text-error" role="alert">
                  {{ t('admin.transactions.fields.pickUser') }}
                </span>
              }
            </div>
          </div>

          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.from') }}</span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ newFromUserName() || t('admin.transactions.fields.guildBankLabel') }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('create-from')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
              @if (newFromUserId()) {
                <button type="button" class="btn btn--ghost btn--sm" (click)="clearNewFrom()">
                  <app-icon name="close" size="0.875rem" />
                </button>
              }
            </div>
          </label>

          <label class="block">
            <span class="label">{{ t('common.amount') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="number"
              min="-999999999"
              step="0.01"
              required
              [value]="newAmount() ?? ''"
              (input)="onNewAmount($event)"
            />
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label">{{ t('common.status') }}</span>
              <app-select
                [value]="newStatus()"
                [options]="statusOptions()"
                (valueChange)="onNewStatus($event)"
              />
            </label>
            <label class="block">
              <span class="label">{{ t('admin.transactions.fields.type') }}</span>
              <input class="input" type="text" [value]="newType()" (input)="onNewType($event)" />
            </label>
          </div>

          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.splitId') }}</span>
            <input
              class="input"
              type="number"
              min="1"
              [value]="newSplitId()"
              (input)="onNewSplitId($event)"
              [attr.placeholder]="t('admin.transactions.fields.splitIdPlaceholder')"
            />
          </label>

          <label class="flex items-center gap-2">
            <input type="checkbox" [checked]="newToGuildBank()" (change)="onNewToGuildBank($event)" />
            <span class="text-xs">{{ t('admin.transactions.fields.toGuildBank') }}</span>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-transaction-form"
            [disabled]="catalogSaving()"
          >
            {{ catalogSaving() ? t('common.loading') : t('admin.transactions.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (editTarget(); as target) {
      <app-dialog [title]="t('admin.transactions.editTitle')" (closed)="closeEdit()">
        <form id="edit-transaction-form" class="grid gap-4" (submit)="onEditSubmit($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('validation.requiredLegend') }}</p>
          <p class="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 text-sm text-[var(--color-text)]">
            {{ t('admin.transactions.fields.amountHint') }}
          </p>
          <div class="block">
            <span id="edit-transaction-recipient-label" class="label">
              {{ t('admin.transactions.fields.to') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <div
              class="mt-1"
              role="group"
              aria-labelledby="edit-transaction-recipient-label"
              [attr.aria-invalid]="editRecipientError() ? 'true' : null"
              [attr.aria-describedby]="editRecipientError()
                ? 'edit-transaction-recipient-required edit-transaction-recipient-error'
                : 'edit-transaction-recipient-required'"
            >
              <span id="edit-transaction-recipient-required" class="sr-only">
                {{ t('validation.required') }}
              </span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ editToUserName() }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('edit-to')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
            </div>
              @if (editRecipientError()) {
                <span id="edit-transaction-recipient-error" class="mt-1 block text-xs text-error" role="alert">
                  {{ t('admin.transactions.fields.pickUser') }}
                </span>
              }
            </div>
          </div>

          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.from') }}</span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ editFromUserName() || t('admin.transactions.fields.guildBankLabel') }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('edit-from')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
              @if (editFromUserId()) {
                <button type="button" class="btn btn--ghost btn--sm" (click)="clearEditFrom()">
                  <app-icon name="close" size="0.875rem" />
                </button>
              }
            </div>
          </label>

          <label class="block">
            <span class="label">{{ t('common.amount') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="number"
              min="-999999999"
              step="0.01"
              required
              [value]="editAmount() ?? ''"
              (input)="onEditAmount($event)"
            />
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label">{{ t('common.status') }}</span>
              <app-select
                [value]="editStatus()"
                [options]="statusOptions()"
                (valueChange)="onEditStatus($event)"
              />
            </label>
            <label class="block">
              <span class="label">{{ t('admin.transactions.fields.type') }}</span>
              <input class="input" type="text" [value]="editType()" (input)="onEditType($event)" />
            </label>
          </div>

          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.splitId') }}</span>
            <input
              class="input"
              type="number"
              min="1"
              [value]="editSplitId()"
              (input)="onEditSplitId($event)"
              [attr.placeholder]="t('admin.transactions.fields.splitIdPlaceholder')"
            />
          </label>

          <label class="flex items-center gap-2">
            <input type="checkbox" [checked]="editToGuildBank()" (change)="onEditToGuildBank($event)" />
            <span class="text-xs">{{ t('admin.transactions.fields.toGuildBank') }}</span>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeEdit()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="edit-transaction-form"
            [disabled]="editSaving()"
          >
            {{ editSaving() ? t('common.loading') : t('admin.transactions.save') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (deleteTarget(); as target) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteTarget.set(null)">
        <p>{{ t('common.confirm') }}</p>
        <p class="mt-2 font-medium">{{ rowName(target) }} &middot; {{ formatSignedAmount(target.amount) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="deleteTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="confirmDelete()">
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (showRosterSearch()) {
      <app-search-dialog
        [title]="t('admin.transactions.fields.pickUser')"
        [options]="rosterSearchOptions()"
        [loading]="searchingRoster()"
        (filterChange)="onRosterSearchFilter($event)"
        (select)="onRosterSelect($event)"
        (close)="showRosterSearch.set(false)"
      />
    }
  `,
})
export class AdminTransactions {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly statuses = STATUSES;
  protected readonly ledger = signal<TransactionView[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly catalogSaving = signal(false);
  protected readonly editSaving = signal(false);
  protected readonly deletingId = signal<number | null>(null);

  protected readonly createOpen = signal(false);
  protected readonly editTarget = signal<TransactionView | null>(null);
  protected readonly deleteTarget = signal<TransactionView | null>(null);
  protected readonly createRecipientError = signal(false);
  protected readonly editRecipientError = signal(false);

  protected readonly newToUserId = signal<number | null>(null);
  protected readonly newToUserName = signal('');
  protected readonly newFromUserId = signal<number | null>(null);
  protected readonly newFromUserName = signal('');
  protected readonly newAmount = signal<number | null>(null);
  protected readonly newStatus = signal<TransactionStatus>('pending');
  protected readonly newType = signal(DEFAULT_TYPE);
  protected readonly newSplitId = signal('');
  protected readonly newToGuildBank = signal(false);

  protected readonly editToUserId = signal<number | null>(null);
  protected readonly editToUserName = signal('');
  protected readonly editFromUserId = signal<number | null>(null);
  protected readonly editFromUserName = signal('');
  protected readonly editAmount = signal<number | null>(null);
  protected readonly editStatus = signal<TransactionStatus>('pending');
  protected readonly editType = signal('');
  protected readonly editSplitId = signal('');
  protected readonly editToGuildBank = signal(false);

  protected readonly showRosterSearch = signal(false);
  protected readonly rosterSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly searchingRoster = signal(false);
  private rosterSearchRequest = 0;
  private rosterTarget: RosterTarget = 'create-to';

  /** One query parameter of the entry URL, or of the matrix params the finance links use. */
  private readonly entry = (key: string): string =>
    this.route.snapshot.queryParamMap.get(key) ?? this.route.snapshot.paramMap.get(key) ?? '';

  /**
   * Ledger filters. The page owns them and mirrors them to the URL (`search` is the member
   * name, kept under its old key so existing links still work). Read once from the entry
   * snapshot: the page is the source of truth from then on.
   */
  protected readonly memberQuery = signal(this.entry('search').trim());
  protected readonly statusFilter = signal<TransactionStatus | ''>(this.entryStatus());
  protected readonly typeFilter = signal(this.entry('type'));
  protected readonly dateFrom = signal(this.entry('from'));
  protected readonly dateTo = signal(this.entry('to'));

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly trackById = (row: TransactionView): number => row.id;

  protected readonly canCreate = computed(() => this.auth.hasPermission('bank.transactions.create'));
  protected readonly canEdit = computed(() => this.auth.hasPermission('bank.transactions.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('bank.transactions.delete'));

  /** Ledger rows that match every filter, in the order the server returned them (newest first). */
  protected readonly filtered = computed<TransactionView[]>(() => {
    const member = this.memberQuery().trim().toLowerCase();
    const status = this.statusFilter();
    const type = this.typeFilter();
    const from = this.dateFrom();
    const to = this.dateTo();
    return this.ledger().filter((row) => {
      if (status && row.status !== status) {
        return false;
      }
      if (type && row.type !== type) {
        return false;
      }
      if (member) {
        const names = [row.to_username, row.to_label].map((name) => (name ?? '').toLowerCase());
        if (!names.some((name) => name.includes(member))) {
          return false;
        }
      }
      if (from || to) {
        const day = localDay(row.created_at);
        if ((from && day < from) || (to && day > to)) {
          return false;
        }
      }
      return true;
    });
  });

  /** Period totals of the filtered rows, split by what they mean for the Guild Bank. */
  protected readonly summary = computed<LedgerSummary>(() => {
    let outstanding = 0;
    let outstandingCount = 0;
    let paid = 0;
    let paidCount = 0;
    let donated = 0;
    let donatedCount = 0;
    for (const row of this.filtered()) {
      const amount = Number(row.amount) || 0;
      if (row.status === 'pending' || row.status === 'requested') {
        outstanding += amount;
        outstandingCount += 1;
      } else if (row.status === 'withdrawn') {
        paid += amount;
        paidCount += 1;
      } else if (row.status === 'donated') {
        donated += amount;
        donatedCount += 1;
      }
    }
    return {
      outstanding: roundCents(outstanding),
      outstandingCount,
      paid: roundCents(paid),
      paidCount,
      donated: roundCents(donated),
      donatedCount,
    };
  });

  /** Signed sum of every filtered row, shown in the totals row. */
  protected readonly netTotal = computed(() =>
    roundCents(this.filtered().reduce((sum, row) => sum + (Number(row.amount) || 0), 0)),
  );

  /** Types present in the ledger, plus the one the filter already names. */
  protected readonly typeOptions = computed<string[]>(() => {
    const types = new Set(this.ledger().map((row) => row.type).filter(Boolean));
    const current = this.typeFilter();
    if (current) {
      types.add(current);
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  });

  protected readonly activeFilterCount = computed(
    () =>
      [
        this.memberQuery().trim(),
        this.statusFilter(),
        this.typeFilter(),
        this.dateFrom(),
        this.dateTo(),
      ].filter(Boolean).length,
  );

  protected readonly emptyKey = computed<TranslationKey>(() =>
    this.activeFilterCount() > 0 && this.ledger().length > 0
      ? 'admin.transactions.noMatches'
      : 'admin.transactions.empty',
  );

  protected readonly columns = computed<DataTableColumn<TransactionView>[]>(() => [
    {
      key: 'to_username',
      label: 'admin.transactions.fields.to',
      sortable: true,
      accessor: (row) => this.rowName(row),
    },
    {
      key: 'amount',
      label: 'common.amount',
      sortable: true,
      align: 'right',
      accessor: (row) => Number(row.amount) || 0,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (row) => row.status,
    },
    { key: 'split_id', label: 'admin.transactions.fields.splitId', accessor: (row) => row.split_id },
    { key: 'created_at', label: 'common.date', sortable: true, accessor: (row) => row.created_at },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  constructor() {
    void this.load();
  }

  /** Reads the whole ledger in pages of up to 1000 rows. Filters then run on the client. */
  protected async load(): Promise<void> {
    this.loading.set(this.ledger().length === 0);
    this.loadFailed.set(false);
    try {
      const rows: TransactionView[] = [];
      let total = Number.POSITIVE_INFINITY;
      for (let page = 1; rows.length < total; page += 1) {
        const data = await firstValueFrom(
          this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', {
            global: true,
            page,
            limit: LEDGER_PAGE_SIZE,
          }),
        );
        rows.push(...data.items);
        total = data.total_items;
        if (data.items.length === 0) {
          break;
        }
      }
      this.ledger.set(rows);
    } catch {
      this.loadFailed.set(true);
      this.ledger.set([]);
      this.toasts.error(this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  protected onMemberChange(value: string): void {
    this.memberQuery.set(value);
    this.syncUrl();
  }

  protected onStatusFilter(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.statusFilter.set(STATUSES.includes(value as TransactionStatus) ? (value as TransactionStatus) : '');
    this.syncUrl();
  }

  protected onTypeFilter(event: Event): void {
    this.typeFilter.set((event.target as HTMLSelectElement).value);
    this.syncUrl();
  }

  protected onDateFilter(bound: 'from' | 'to', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (bound === 'from') {
      this.dateFrom.set(value);
    } else {
      this.dateTo.set(value);
    }
    this.syncUrl();
  }

  protected clearFilters(): void {
    this.memberQuery.set('');
    this.statusFilter.set('');
    this.typeFilter.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.syncUrl();
  }

  protected onRowAction(row: TransactionView, id: string): void {
    if (id === 'edit') {
      this.openEdit(row);
    } else if (id === 'delete') {
      this.askDelete(row);
    }
  }

  protected rowMenu(row: TransactionView): MenuItem[] {
    const items: MenuItem[] = [];
    if (this.canEdit()) {
      items.push({ id: 'edit', label: this.t('common.edit') });
    }
    if (this.canDelete()) {
      items.push({
        id: 'delete',
        label: this.t('common.delete'),
        danger: true,
        disabled: this.deletingId() === row.id,
        separatorBefore: items.length > 0,
      });
    }
    return items;
  }

  /** The recipient as the ledger shows it: the guild bank label, or the member's name. */
  protected rowName(row: TransactionView): string {
    return row.to_guild_bank ? row.to_label : row.to_username;
  }

  protected openCreate(): void {
    this.newToUserId.set(null);
    this.newToUserName.set('');
    this.createRecipientError.set(false);
    this.newFromUserId.set(null);
    this.newFromUserName.set('');
    this.newAmount.set(null);
    this.newStatus.set('pending');
    this.newType.set(DEFAULT_TYPE);
    this.newSplitId.set('');
    this.newToGuildBank.set(false);
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  protected clearNewFrom(): void {
    this.newFromUserId.set(null);
    this.newFromUserName.set('');
  }

  protected onNewAmount(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.newAmount.set(Number.isFinite(value) ? value : null);
  }
  protected statusOptions(): SelectOption[] {
    return this.statuses.map((status) => ({
      value: status,
      label: this.statusLabel(status),
    }));
  }

  protected onNewStatus(value: string): void {
    this.newStatus.set(value as TransactionStatus);
  }
  protected onNewType(event: Event): void {
    this.newType.set((event.target as HTMLInputElement).value);
  }
  protected onNewSplitId(event: Event): void {
    this.newSplitId.set((event.target as HTMLInputElement).value);
  }
  protected onNewToGuildBank(event: Event): void {
    this.newToGuildBank.set((event.target as HTMLInputElement).checked);
  }

  protected async onCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const toUserId = this.newToUserId();
    const amount = this.newAmount();
    if (!toUserId) {
      this.createRecipientError.set(true);
      this.toasts.error(this.t('admin.transactions.fields.pickUser'));
      return;
    }
    this.createRecipientError.set(false);
    if (amount === null || amount === 0) {
      this.toasts.error(this.t('validation.nonZero'));
      return;
    }
    this.catalogSaving.set(true);
    try {
      const payload: CreateTransactionRequest = {
        to_user_id: toUserId,
        amount,
        status: this.newStatus(),
        type: this.newType().trim() || undefined,
        split_id: this.newSplitId() ? Number(this.newSplitId()) : undefined,
        to_guild_bank: this.newToGuildBank(),
        from_user_id: this.newFromUserId() ?? undefined,
      };
      await firstValueFrom(this.api.post<TransactionView>('api/bank/transactions', payload));
      this.closeCreate();
      await this.load();
      this.toasts.success(this.t('admin.transactions.created'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.catalogSaving.set(false);
    }
  }

  protected openEdit(row: TransactionView): void {
    this.editTarget.set(row);
    this.editRecipientError.set(false);
    this.editToUserId.set(row.to_user_id);
    this.editToUserName.set(row.to_username);
    this.editFromUserId.set(row.from_user_id);
    this.editFromUserName.set(row.from_user_id ? row.from_label : '');
    this.editAmount.set(Number(row.amount));
    this.editStatus.set(row.status);
    this.editType.set(row.type);
    this.editSplitId.set(row.split_id ? String(row.split_id) : '');
    this.editToGuildBank.set(row.to_guild_bank);
  }

  protected closeEdit(): void {
    this.editTarget.set(null);
  }

  protected clearEditFrom(): void {
    this.editFromUserId.set(null);
    this.editFromUserName.set('');
  }

  protected onEditAmount(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.editAmount.set(Number.isFinite(value) ? value : null);
  }
  protected onEditStatus(value: string): void {
    this.editStatus.set(value as TransactionStatus);
  }
  protected onEditType(event: Event): void {
    this.editType.set((event.target as HTMLInputElement).value);
  }
  protected onEditSplitId(event: Event): void {
    this.editSplitId.set((event.target as HTMLInputElement).value);
  }
  protected onEditToGuildBank(event: Event): void {
    this.editToGuildBank.set((event.target as HTMLInputElement).checked);
  }

  protected async onEditSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const target = this.editTarget();
    const toUserId = this.editToUserId();
    const amount = this.editAmount();
    if (!target) {
      return;
    }
    if (!toUserId) {
      this.editRecipientError.set(true);
      return;
    }
    this.editRecipientError.set(false);
    if (amount === null || amount === 0) {
      this.toasts.error(this.t('validation.nonZero'));
      return;
    }
    this.editSaving.set(true);
    try {
      const payload: UpdateTransactionRequest = {
        to_user_id: toUserId,
        from_user_id: this.editFromUserId(),
        amount,
        status: this.editStatus(),
        type: this.editType().trim() || undefined,
        split_id: this.editSplitId() ? Number(this.editSplitId()) : null,
        to_guild_bank: this.editToGuildBank(),
        guild_tenant_id: target.guild_tenant_id ?? undefined,
      };
      await firstValueFrom(
        this.api.patch<TransactionView>(`api/bank/transactions/${target.id}`, payload),
      );
      this.closeEdit();
      await this.load();
      this.toasts.success(this.t('admin.transactions.updated'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.editSaving.set(false);
    }
  }

  protected askDelete(row: TransactionView): void {
    this.deleteTarget.set(row);
  }

  protected async confirmDelete(): Promise<void> {
    const target = this.deleteTarget();
    this.deleteTarget.set(null);
    if (!target) {
      return;
    }
    this.deletingId.set(target.id);
    try {
      const path = target.guild_tenant_id
        ? `api/bank/transactions/${target.id}?guild_tenant_id=${encodeURIComponent(target.guild_tenant_id)}`
        : `api/bank/transactions/${target.id}`;
      await firstValueFrom(this.api.delete(path));
      await this.load();
      this.toasts.success(this.t('admin.transactions.deleted'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.deletingId.set(null);
    }
  }

  protected openRosterSearch(target: RosterTarget): void {
    this.rosterTarget = target;
    this.rosterSearchOptions.set([]);
    this.showRosterSearch.set(true);
  }

  protected async onRosterSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const request = ++this.rosterSearchRequest;
    const query = filters.search.trim();
    if (!query) {
      this.rosterSearchOptions.set([]);
      this.searchingRoster.set(false);
      return;
    }
    this.searchingRoster.set(true);
    try {
      // The transaction endpoints take local user ids, so search app members (the users
      // endpoint matches the Discord name and the linked Albion character name, any guild)
      // rather than the Albion guild roster, whose ids are opaque Albion strings.
      const usersPage = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          username: query,
          limit: 25,
        }),
      );
      if (request === this.rosterSearchRequest) {
        this.rosterSearchOptions.set(
          usersPage.items.map((member) => ({ id: String(member.id), title: member.username })),
        );
      }
    } catch {
      if (request === this.rosterSearchRequest) {
        this.toasts.error(this.t('common.error'));
      }
    } finally {
      if (request === this.rosterSearchRequest) {
        this.searchingRoster.set(false);
      }
    }
  }

  protected onRosterSelect(opt: SearchDialogOption): void {
    const id = Number(opt.id);
    switch (this.rosterTarget) {
      case 'create-to':
        this.newToUserId.set(id);
        this.newToUserName.set(opt.title);
        this.createRecipientError.set(false);
        break;
      case 'create-from':
        this.newFromUserId.set(id);
        this.newFromUserName.set(opt.title);
        break;
      case 'edit-to':
        this.editToUserId.set(id);
        this.editToUserName.set(opt.title);
        this.editRecipientError.set(false);
        break;
      case 'edit-from':
        this.editFromUserId.set(id);
        this.editFromUserName.set(opt.title);
        break;
    }
    this.showRosterSearch.set(false);
  }

  /** Unsigned amount with up to two decimals, the form the create and edit dialogs accept. */
  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    return new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 2 }).format(
      Number.isFinite(numeric) ? numeric : 0,
    );
  }

  /**
   * Amount with an explicit sign. Positive is paid out by the Guild Bank to the member,
   * negative is paid back to the Guild Bank (see `admin.transactions.fields.amountHint`).
   */
  protected formatSignedAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    return new Intl.NumberFormat(this.translate.locale(), {
      maximumFractionDigits: 2,
      signDisplay: 'exceptZero',
    }).format(Number.isFinite(numeric) ? numeric : 0);
  }

  /** Colour follows the direction of the money; the sign carries the same meaning in text. */
  protected amountColor(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    if (numeric < 0) {
      return 'var(--color-success)';
    }
    if (numeric > 0) {
      return 'var(--color-info)';
    }
    return 'var(--color-text-secondary)';
  }

  protected formatDateDay(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleDateString(this.translate.locale(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  protected formatDateTime(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleTimeString(this.translate.locale(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
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

  private entryStatus(): TransactionStatus | '' {
    const status = this.entry('status');
    return STATUSES.includes(status as TransactionStatus) ? (status as TransactionStatus) : '';
  }

  /** Mirrors the filter state to the query string, replacing history so Back is not flooded. */
  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        search: this.memberQuery().trim() || null,
        status: this.statusFilter() || null,
        type: this.typeFilter() || null,
        from: this.dateFrom() || null,
        to: this.dateTo() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
