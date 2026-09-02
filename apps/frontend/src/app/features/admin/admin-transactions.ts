import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  CreateTransactionRequest,
  PaginatedData,
  TransactionStatus,
  TransactionView,
  UpdateTransactionRequest,
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
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';

const STATUSES: readonly TransactionStatus[] = [
  'pending',
  'requested',
  'rejected',
  'withdrawn',
  'donated',
];
const DEFAULT_TYPE = 'manual_adjustment';

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 25, search: '', sort: null, columnFilters: {} };
}

/** Which recipient/payer field the roster search dialog is currently filling. */
type RosterTarget = 'create-to' | 'create-from' | 'edit-to' | 'edit-from';

/**
 * Full guild ledger, with manual create/edit/delete for administrators.
 *
 * `GET /api/bank/transactions?global=true` already backs the withdrawal queue and every
 * member's personal ledger; this page reuses the same endpoint for the raw table and adds
 * the three `bank.transactions.*` mutation endpoints on top, for one-off corrections that
 * don't go through the split-completion or withdrawal flows.
 */
@Component({
  selector: 'app-admin-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, Icon, PageHeader, PageStack, RouterLink, SearchDialog],
  template: `
    <app-page-header [title]="t('admin.transactions.title')" [subtitle]="t('admin.transactions.hint')">
      @if (canCreate()) {
        <button type="button" class="btn btn--primary" (click)="openCreate()">
          {{ t('admin.transactions.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <app-data-table
        [columns]="columns()"
        [rows]="items()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [serverMode]="true"
        [totalItems]="total()"
        [pageSize]="25"
        emptyIcon="bank"
        [emptyLabel]="'admin.transactions.empty'"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="to_username" let-row>
          <span class="font-medium">{{ row.to_guild_bank ? row.to_label : row.to_username }}</span>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <span class="chip" [class]="statusChipClass(row.status)">
            <app-icon [name]="statusIcon(row.status)" size="0.875rem" />
            {{ statusLabel(row.status) }}
          </span>
        </ng-template>
        <ng-template dataTableCell="amount" let-row>
          <span class="font-semibold mono" style="font-variant-numeric: tabular-nums">
            {{ formatAmount(row.amount) }}
          </span>
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
          <span style="color: var(--color-text-secondary)">{{ formatDate(row.created_at) }}</span>
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end gap-2">
            @if (canEdit()) {
              <button type="button" class="btn btn--outline btn--sm" (click)="openEdit(row)">
                {{ t('common.edit') }}
              </button>
            }
            @if (canDelete()) {
              <button
                type="button"
                class="btn btn--danger btn--sm"
                [disabled]="deletingId() === row.id"
                (click)="askDelete(row)"
              >
                {{ t('common.delete') }}
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('admin.transactions.create')" (closed)="closeCreate()">
        <form id="create-transaction-form" class="grid gap-4" (submit)="onCreate($event)">
          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.to') }}</span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ newToUserName() || t('admin.transactions.fields.pickUser') }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('create-to')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
            </div>
          </label>

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
            <span class="label">{{ t('common.amount') }}</span>
            <input
              class="input"
              type="number"
              min="0.01"
              step="0.01"
              required
              [value]="newAmount() ?? ''"
              (input)="onNewAmount($event)"
            />
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label">{{ t('common.status') }}</span>
              <select class="select" [value]="newStatus()" (change)="onNewStatus($event)">
                @for (status of statuses; track status) {
                  <option [value]="status">{{ statusLabel(status) }}</option>
                }
              </select>
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
          <label class="block">
            <span class="label">{{ t('admin.transactions.fields.to') }}</span>
            <div class="flex items-center gap-2">
              <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] truncate">
                <span class="truncate">{{ editToUserName() }}</span>
              </div>
              <button type="button" class="btn btn--outline btn--sm" (click)="openRosterSearch('edit-to')">
                {{ t('admin.transactions.fields.pick') }}
              </button>
            </div>
          </label>

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
            <span class="label">{{ t('common.amount') }}</span>
            <input
              class="input"
              type="number"
              min="0.01"
              step="0.01"
              required
              [value]="editAmount() ?? ''"
              (input)="onEditAmount($event)"
            />
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label">{{ t('common.status') }}</span>
              <select class="select" [value]="editStatus()" (change)="onEditStatus($event)">
                @for (status of statuses; track status) {
                  <option [value]="status">{{ statusLabel(status) }}</option>
                }
              </select>
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
        <p class="mt-2 font-medium">{{ target.to_username }} &middot; {{ formatAmount(target.amount) }}</p>
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

  protected readonly statuses = STATUSES;
  protected readonly items = signal<TransactionView[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly catalogSaving = signal(false);
  protected readonly editSaving = signal(false);
  protected readonly deletingId = signal<number | null>(null);

  protected readonly createOpen = signal(false);
  protected readonly editTarget = signal<TransactionView | null>(null);
  protected readonly deleteTarget = signal<TransactionView | null>(null);

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
  private rosterTarget: RosterTarget = 'create-to';

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly trackById = (row: TransactionView): number => row.id;

  protected readonly canCreate = computed(() => this.auth.hasPermission('bank.transactions.create'));
  protected readonly canEdit = computed(() => this.auth.hasPermission('bank.transactions.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('bank.transactions.delete'));

  protected readonly columns = computed<DataTableColumn<TransactionView>[]>(() => [
    { key: 'to_username', label: 'admin.transactions.fields.to', accessor: (row) => row.to_username },
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
      filterOptions: this.statuses.map((status) => ({
        label: this.statusLabel(status),
        value: status,
      })),
    },
    { key: 'split_id', label: 'admin.transactions.fields.splitId', accessor: (row) => row.split_id },
    { key: 'created_at', label: 'common.date', sortable: true, accessor: (row) => row.created_at },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  constructor() {
    void this.load();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(this.items().length === 0);
    this.loadFailed.set(false);
    try {
      const query = this.tableQuery();
      const params: Record<string, string | number | boolean> = {
        page: query.page,
        limit: query.pageSize,
        global: true,
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
      this.items.set(data.items);
      this.total.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.items.set([]);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  protected openCreate(): void {
    this.newToUserId.set(null);
    this.newToUserName.set('');
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
  protected onNewStatus(event: Event): void {
    this.newStatus.set((event.target as HTMLSelectElement).value as TransactionStatus);
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
      this.toasts.error(this.t('admin.transactions.fields.pickUser'));
      return;
    }
    if (!amount || amount <= 0) {
      this.toasts.error(this.t('validation.positive'));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.catalogSaving.set(false);
    }
  }

  protected openEdit(row: TransactionView): void {
    this.editTarget.set(row);
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
  protected onEditStatus(event: Event): void {
    this.editStatus.set((event.target as HTMLSelectElement).value as TransactionStatus);
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
    if (!target || !toUserId) {
      return;
    }
    if (!amount || amount <= 0) {
      this.toasts.error(this.t('validation.positive'));
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
      };
      await firstValueFrom(
        this.api.patch<TransactionView>(`api/bank/transactions/${target.id}`, payload),
      );
      this.closeEdit();
      await this.load();
      this.toasts.success(this.t('admin.transactions.updated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
      await firstValueFrom(this.api.delete(`api/bank/transactions/${target.id}`));
      await this.load();
      this.toasts.success(this.t('admin.transactions.deleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
    const query = filters.search.trim();
    if (!query) {
      this.rosterSearchOptions.set([]);
      return;
    }
    this.searchingRoster.set(true);
    try {
      const rosterPage = await firstValueFrom(
        this.api.get<PaginatedData<AlbionGuildMember>>('api/albion/guild/roster', {
          q: query,
          limit: 25,
        }),
      );
      this.rosterSearchOptions.set(
        rosterPage.items.map((member) => ({ id: member.id, title: member.name })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected onRosterSelect(opt: SearchDialogOption): void {
    const id = Number(opt.id);
    switch (this.rosterTarget) {
      case 'create-to':
        this.newToUserId.set(id);
        this.newToUserName.set(opt.title);
        break;
      case 'create-from':
        this.newFromUserId.set(id);
        this.newFromUserName.set(opt.title);
        break;
      case 'edit-to':
        this.editToUserId.set(id);
        this.editToUserName.set(opt.title);
        break;
      case 'edit-from':
        this.editFromUserId.set(id);
        this.editFromUserName.set(opt.title);
        break;
    }
    this.showRosterSearch.set(false);
  }

  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    const lang =
      this.translate.language() === 'it' ? 'it-IT' : this.translate.language() === 'es' ? 'es-ES' : 'en-US';
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
