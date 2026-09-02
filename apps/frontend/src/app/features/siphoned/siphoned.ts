import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  PaginatedData,
  SiphonedBatchSummary,
  SiphonedEntryMutationRequest,
  SiphonedEntryView,
  SiphonedIngestRequest,
  SiphonedIngestResponse,
  SiphonedPlayerBalance,
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
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

type SiphonedTab = 'balances' | 'entries' | 'batches';
type SiphonedIngestRow = SiphonedIngestRequest['rows'][number];
type EntryDraft = Record<'occurred_at' | 'player_name' | 'reason' | 'amount', string>;
type ConfirmTarget = { kind: 'entry'; id: number } | { kind: 'batch'; id: string };

function isSiphonedTab(value: string): value is SiphonedTab {
  return value === 'balances' || value === 'entries' || value === 'batches';
}

function emptyEntryDraft(): EntryDraft {
  return {
    occurred_at: '',
    player_name: '',
    reason: '',
    amount: '',
  };
}

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 10, search: '', sort: null, columnFilters: {} };
}

/**
 * The backend exposes no single guild-wide balance/aggregate endpoint for
 * siphoned energy (only per-player balances via `GET /balances`, paginated).
 * The KPI cards need the true guild-wide totals, so a separate fetch pulls a
 * large enough page of every player's balance — independent of the table's
 * own small page size — to sum from.
 */
const STATS_FETCH_LIMIT = 1000;

/**
 * Siphoned Energy operations page.
 *
 * Officers can paste Albion export rows and import them as immutable batches;
 * every authenticated member with view permission can inspect debts and the
 * raw ledger. The parser accepts comma, semicolon, or tab-separated exports so
 * it works with copied spreadsheet data without a separate preprocessing step.
 */
@Component({
  selector: 'app-siphoned',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    Icon,
    PageHeader,
    PageStack,
    StatCard,
    ViewToggle,
  ],
  styles: `
    .siphoned-permission-note { margin: 0; padding: 0.75rem 0.875rem; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-secondary); font-size: 0.75rem; line-height: 1.5; }
  `,
  template: `
    <app-page-header [title]="t('siphoned.title')" [subtitle]="t('siphoned.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canIngest()) {
        <button type="button" class="btn btn--tonal btn--sm" (click)="openEntryForm()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('siphoned.addEntry') }}
        </button>
      }
      @if (canIngest()) {
        <button type="button" class="btn btn--primary btn--sm" (click)="openIngestForm()">
          <app-icon name="sparkles" size="0.875rem" />
          {{ t('siphoned.ingest') }}
        </button>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      @if (!canIngest()) {
        <p class="siphoned-permission-note" role="status">{{ t('siphoned.missingManagePermission') }}</p>
      }
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Siphoned summary">
        <app-stat-card
          [label]="t('siphoned.stat.deposited')"
          [value]="formatAmount(totalDeposited())"
          icon="bank"
          tone="success"
        />
        <app-stat-card
          [label]="t('siphoned.stat.withdrawn')"
          [value]="formatAmount(totalWithdrawn())"
          icon="bank"
          tone="warning"
        />
        <app-stat-card
          [label]="t('siphoned.stat.net')"
          [value]="formatAmount(netTotal())"
          [sub]="t('siphoned.lastUpdated') + ': ' + lastUpdatedLabel()"
          icon="chart"
          [tone]="netTotal() >= 0 ? 'success' : 'danger'"
        />
        <app-stat-card
          [label]="t('siphoned.stat.entries')"
          [value]="tab() === 'balances' ? balanceTotal() : tab() === 'entries' ? entryTotal() : batches().length"
          icon="list"
          tone="neutral"
        />
      </section>

      @if (tab() === 'balances') {
        <app-data-table
          [columns]="balanceColumns"
          [rows]="balances()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackBalance"
          [serverMode]="true"
          [totalItems]="balanceTotal()"
          [pageSize]="10"
          emptyIcon="activity"
          (pageChange)="onBalancesChange($event)"
        >
          <ng-template dataTableCell="net" let-row>
            <span
              class="chip"
              [class.chip--error]="toNumber(row.net) < 0"
              [class.chip--success]="toNumber(row.net) > 0"
            >
              {{ balanceStatusLabel(row.net) }}
              {{ formatAmount(absoluteAmount(row.net)) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="total_deposited" let-row>
            {{ formatAmount(row.total_deposited) }}
          </ng-template>
          <ng-template dataTableCell="total_withdrawn" let-row>
            {{ formatAmount(row.total_withdrawn) }}
          </ng-template>
          <ng-template dataTableCell="last_seen" let-row>
            {{ formatDate(row.last_seen) }}
          </ng-template>
        </app-data-table>
      } @else if (tab() === 'entries') {
        <app-data-table
          [columns]="entryColumns()"
          [rows]="entries()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackEntry"
          [serverMode]="true"
          [totalItems]="entryTotal()"
          [pageSize]="10"
          emptyIcon="activity"
          (pageChange)="onEntriesChange($event)"
        >
          <ng-template dataTableCell="occurred_at" let-row>
            {{ formatDate(row.occurred_at) }}
          </ng-template>
          <ng-template dataTableCell="reason" let-row>
            <span class="chip">{{ row.reason }}</span>
          </ng-template>
          <ng-template dataTableCell="amount" let-row>
            {{ formatAmount(row.amount) }}
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (canIngest()) {
              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn--ghost" (click)="editEntry(row)">
                  {{ t('common.edit') }}
                </button>
                <button type="button" class="btn btn--danger" (click)="askDeleteEntry(row.id)">
                  {{ t('common.delete') }}
                </button>
              </div>
            }
          </ng-template>
        </app-data-table>
      } @else {
        <app-data-table
          [columns]="batchColumns()"
          [rows]="batches()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackBatch"
          [pageSize]="10"
          emptyIcon="activity"
        >
          <ng-template dataTableCell="ingested_at" let-row>
            {{ formatDate(row.ingested_at) }}
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (canIngest()) {
              <button type="button" class="btn btn--danger" (click)="askDeleteBatch(row.batch_id)">
                {{ t('common.delete') }}
              </button>
            }
          </ng-template>
        </app-data-table>
      }
    </app-page-stack>

    @if (showIngestForm()) {
      <app-dialog [title]="t('siphoned.ingest')" (closed)="showIngestForm.set(false)">
        <form id="siphoned-ingest-form" class="grid gap-4" (submit)="onIngestSubmit($event)">
          <label>
            <span class="label">{{ t('siphoned.exportRows') }}</span>
            <textarea
              class="textarea font-mono text-xs"
              rows="8"
              [value]="rawExport()"
              (input)="onRawExportChange($event)"
              placeholder='"Date"&#9;"Player"&#9;"Reason"&#9;"Amount"&#10;"2026-08-10 20:37:41"&#9;"Galvdon"&#9;"Withdrawal"&#9;"-10"'
            ></textarea>
          </label>
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('siphoned.ingestHint') }}
          </p>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="showIngestForm.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="siphoned-ingest-form"
            [disabled]="saving()"
          >
            {{ t('siphoned.ingest') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (showEntryForm()) {
      <app-dialog [title]="entryDialogTitle()" (closed)="closeEntryForm()">
        <form id="siphoned-entry-form" class="grid gap-4" (submit)="onEntrySubmit($event)">
          <label>
            <span class="label">{{ t('common.date') }}</span>
            <input
              class="input"
              type="datetime-local"
              step="1"
              [value]="entryDraft().occurred_at"
              (input)="updateEntryDraft('occurred_at', $event)"
            />
          </label>
          <label>
            <span class="label">{{ t('common.player') }}</span>
            <input
              class="input"
              type="text"
              [value]="entryDraft().player_name"
              (input)="updateEntryDraft('player_name', $event)"
              placeholder="Galvdon"
            />
          </label>
          <label>
            <span class="label">{{ t('siphoned.reason') }}</span>
            <input
              class="input"
              type="text"
              [value]="entryDraft().reason"
              (input)="updateEntryDraft('reason', $event)"
              placeholder="Deposit or Withdrawal"
            />
          </label>
          <label>
            <span class="label">{{ t('common.amount') }}</span>
            <input
              class="input"
              type="number"
              step="1"
              [value]="entryDraft().amount"
              (input)="updateEntryDraft('amount', $event)"
              placeholder="-10"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeEntryForm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="siphoned-entry-form"
            [disabled]="saving()"
          >
            {{ editingEntryId() === null ? t('siphoned.addEntry') : t('siphoned.saveEntry') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (confirm(); as target) {
      <app-dialog [title]="t('common.confirm')" (closed)="confirm.set(null)">
        <p>
          {{
            target.kind === 'batch'
              ? t('siphoned.confirmDeleteBatch')
              : t('siphoned.confirmDeleteEntry')
          }}
        </p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="confirm.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="runConfirm()">
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Siphoned {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tab = signal<SiphonedTab>('balances');
  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'balances', label: this.t('siphoned.balances') },
    { id: 'entries', label: this.t('siphoned.entries') },
    { id: 'batches', label: this.t('siphoned.batches') },
  ]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly showIngestForm = signal(false);
  protected readonly showEntryForm = signal(false);
  protected readonly rawExport = signal('');
  protected readonly balances = signal<SiphonedPlayerBalance[]>([]);
  protected readonly balanceTotal = signal(0);
  protected readonly entries = signal<SiphonedEntryView[]>([]);
  protected readonly entryTotal = signal(0);
  protected readonly batches = signal<SiphonedBatchSummary[]>([]);
  protected readonly lastUpdatedAt = signal<string | null>(null);

  /**
   * Every player's balance (up to `STATS_FETCH_LIMIT`), fetched independently
   * of the `balances()` table page so the KPI cards below reflect the whole
   * guild instead of whichever page — or tab — happens to be on screen.
   */
  private readonly statsBalances = signal<SiphonedPlayerBalance[]>([]);

  protected readonly totalDeposited = computed(() =>
    this.statsBalances().reduce((sum, b) => sum + this.toNumber(b.total_deposited || 0), 0),
  );
  protected readonly totalWithdrawn = computed(() =>
    this.statsBalances().reduce((sum, b) => sum + this.toNumber(b.total_withdrawn || 0), 0),
  );
  protected readonly netTotal = computed(() =>
    this.statsBalances().reduce((sum, b) => sum + this.toNumber(b.net || 0), 0),
  );

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.refreshLastUpdated(), this.load(), this.loadStats()]);
  }
  protected readonly editingEntryId = signal<number | null>(null);
  protected readonly entryDraft = signal<EntryDraft>(emptyEntryDraft());
  protected readonly confirm = signal<ConfirmTarget | null>(null);
  protected readonly trackBalance = (row: SiphonedPlayerBalance): unknown => row.player_name;
  protected readonly trackEntry = (entry: SiphonedEntryView): unknown => entry.id;
  protected readonly trackBatch = (batch: SiphonedBatchSummary): unknown => batch.batch_id;

  private readonly entryQuery = signal<DataTablePageChange>(emptyPageChange());
  private readonly balanceQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly canIngest = computed(() => this.auth.hasPermission('siphoned.ingest'));

  protected readonly balanceColumns: readonly DataTableColumn<SiphonedPlayerBalance>[] = [
    {
      key: 'player_name',
      label: 'common.player',
      sortable: true,
      searchable: true,
      accessor: (row) => row.player_name,
      comparator: (a, b) => a.player_name.localeCompare(b.player_name),
    },
    {
      key: 'net',
      label: 'siphoned.net',
      sortable: true,
      accessor: (row) => row.net,
      comparator: (a, b) => this.toNumber(a.net) - this.toNumber(b.net),
    },
    {
      key: 'total_deposited',
      label: 'siphoned.deposited',
      sortable: true,
      accessor: (row) => row.total_deposited,
      comparator: (a, b) => this.toNumber(a.total_deposited) - this.toNumber(b.total_deposited),
      align: 'right',
    },
    {
      key: 'total_withdrawn',
      label: 'siphoned.withdrawn',
      sortable: true,
      accessor: (row) => row.total_withdrawn,
      comparator: (a, b) => this.toNumber(a.total_withdrawn) - this.toNumber(b.total_withdrawn),
      align: 'right',
    },
    {
      key: 'entry_count',
      label: 'siphoned.entryCount',
      sortable: true,
      accessor: (row) => row.entry_count,
      comparator: (a, b) => a.entry_count - b.entry_count,
      align: 'right',
    },
    {
      key: 'last_seen',
      label: 'siphoned.lastSeen',
      sortable: true,
      accessor: (row) => row.last_seen,
      comparator: (a, b) => a.last_seen.localeCompare(b.last_seen),
    },
  ];

  protected readonly entryColumns = computed<DataTableColumn<SiphonedEntryView>[]>(() => {
    const columns: DataTableColumn<SiphonedEntryView>[] = [
      {
        key: 'occurred_at',
        label: 'common.date',
        sortable: true,
        accessor: (entry) => entry.occurred_at,
      },
      {
        key: 'player_name',
        label: 'common.player',
        sortable: true,
        searchable: true,
        accessor: (entry) => entry.player_name,
      },
      {
        key: 'reason',
        label: 'siphoned.reason',
        sortable: true,
        searchable: true,
        accessor: (entry) => entry.reason,
        filterOptions: [
          { value: 'Deposit', label: this.t('siphoned.deposited') },
          { value: 'Withdrawal', label: this.t('siphoned.withdrawn') },
        ],
      },
      {
        key: 'amount',
        label: 'common.amount',
        sortable: true,
        accessor: (entry) => entry.amount,
        align: 'right',
      },
    ];
    if (this.canIngest()) {
      columns.push({
        key: 'actions',
        label: 'common.actions',
        sortable: false,
        align: 'right',
        accessor: () => null,
      });
    }
    return columns;
  });

  protected readonly batchColumns = computed<DataTableColumn<SiphonedBatchSummary>[]>(() => {
    const columns: DataTableColumn<SiphonedBatchSummary>[] = [
      {
        key: 'batch_id',
        label: 'siphoned.batchId',
        sortable: true,
        searchable: true,
        accessor: (batch) => batch.batch_id,
        comparator: (a, b) => a.batch_id.localeCompare(b.batch_id),
      },
      {
        key: 'ingested_at',
        label: 'common.date',
        sortable: true,
        accessor: (batch) => batch.ingested_at,
        comparator: (a, b) => a.ingested_at.localeCompare(b.ingested_at),
      },
      {
        key: 'row_count',
        label: 'siphoned.rowCount',
        sortable: true,
        accessor: (batch) => batch.row_count,
        comparator: (a, b) => a.row_count - b.row_count,
        align: 'right',
      },
    ];
    if (this.canIngest()) {
      columns.push({
        key: 'actions',
        label: 'common.actions',
        sortable: false,
        accessor: () => null,
      });
    }
    return columns;
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.refreshLastUpdated();
    void this.load();
    void this.loadStats();
  }

  protected entryDialogTitle(): string {
    return this.editingEntryId() === null ? this.t('siphoned.addEntry') : this.t('siphoned.editEntry');
  }

  protected openIngestForm(): void {
    this.showIngestForm.set(true);
  }

  protected openEntryForm(): void {
    if (this.tab() !== 'entries') {
      this.tab.set('entries');
      this.entryQuery.set(emptyPageChange());
      void this.load();
    }
    this.resetEntryDraft();
    this.showEntryForm.set(true);
  }

  protected closeEntryForm(): void {
    this.showEntryForm.set(false);
    this.resetEntryDraft();
  }

  protected onRawExportChange(event: Event): void {
    this.rawExport.set((event.target as HTMLTextAreaElement).value);
  }

  protected switchTab(tab: string): void {
    if (!isSiphonedTab(tab) || this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    this.entryQuery.set(emptyPageChange());
    this.balanceQuery.set(emptyPageChange());
    void this.load();
  }

  protected onBalancesChange(event: DataTablePageChange): void {
    this.balanceQuery.set(event);
    void this.load();
  }

  protected onEntriesChange(event: DataTablePageChange): void {
    this.entryQuery.set(event);
    void this.load();
  }

  protected onIngestSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.ingest();
  }

  protected onEntrySubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.saveEntry();
  }

  protected updateEntryDraft(field: keyof EntryDraft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.entryDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected editEntry(entry: SiphonedEntryView): void {
    this.editingEntryId.set(entry.id);
    this.entryDraft.set({
      occurred_at: this.toDateTimeLocal(entry.occurred_at),
      player_name: entry.player_name,
      reason: entry.reason,
      amount: String(entry.amount),
    });
    this.showEntryForm.set(true);
  }

  protected resetEntryDraft(): void {
    this.editingEntryId.set(null);
    this.entryDraft.set(emptyEntryDraft());
  }

  protected askDeleteEntry(entryId: number): void {
    this.confirm.set({ kind: 'entry', id: entryId });
  }

  protected askDeleteBatch(batchId: string): void {
    this.confirm.set({ kind: 'batch', id: batchId });
  }

  protected async runConfirm(): Promise<void> {
    const target = this.confirm();
    this.confirm.set(null);
    if (!target) {
      return;
    }
    if (target.kind === 'entry') {
      await this.deleteEntry(target.id);
      return;
    }
    await this.deleteBatch(target.id);
  }

  private async ingest(): Promise<void> {
    const request = this.buildIngestRequest();
    if (!request) {
      return;
    }

    this.saving.set(true);
    try {
      const response = await firstValueFrom(
        this.api.post<SiphonedIngestResponse>('api/siphoned/ingest', request),
      );
      this.rawExport.set('');
      this.showIngestForm.set(false);
      this.toasts.success(
        this.translate.t('siphoned.ingestSuccess', { count: response.ingested_count }),
      );
      await this.refreshLastUpdated();
      await Promise.all([this.load(), this.loadStats()]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async saveEntry(): Promise<void> {
    const request = this.buildEntryMutationRequest();
    if (!request) {
      return;
    }

    this.saving.set(true);
    try {
      const editingId = this.editingEntryId();
      if (editingId === null) {
        await firstValueFrom(this.api.post<SiphonedEntryView>('api/siphoned/entries', request));
        this.toasts.success(this.t('siphoned.entryAdded'));
      } else {
        await firstValueFrom(
          this.api.put<SiphonedEntryView>(`api/siphoned/entries/${editingId}`, request),
        );
        this.toasts.success(this.t('siphoned.entryUpdated'));
      }
      this.closeEntryForm();
      await Promise.all([this.load(), this.loadStats()]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async deleteEntry(entryId: number): Promise<void> {
    try {
      await firstValueFrom(this.api.delete(`api/siphoned/entries/${entryId}`));
      this.toasts.success(this.t('common.delete'));
      await Promise.all([this.load(), this.loadStats()]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async deleteBatch(batchId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.delete(`api/siphoned/batches/${encodeURIComponent(batchId)}`));
      await this.refreshLastUpdated();
      await Promise.all([this.load(), this.loadStats()]);
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected formatAmount(value: number | string): string {
    return this.toNumber(value).toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected lastUpdatedLabel(): string {
    const lastUpdatedAt = this.lastUpdatedAt();
    if (!lastUpdatedAt) {
      return this.t('siphoned.lastUpdatedNever');
    }
    return this.formatDate(lastUpdatedAt);
  }

  protected toNumber(value: number | string): number {
    return typeof value === 'number' ? value : Number(value);
  }

  protected absoluteAmount(value: number | string): number {
    return Math.abs(this.toNumber(value));
  }

  protected balanceStatusLabel(value: number | string): string {
    const amount = this.toNumber(value);
    if (amount > 0) {
      return this.t('siphoned.credit');
    }
    if (amount < 0) {
      return this.t('siphoned.debt');
    }
    return this.t('siphoned.even');
  }

  private buildEntryMutationRequest(): SiphonedEntryMutationRequest | null {
    const draft = this.entryDraft();
    const amount = Number(draft.amount);
    if (!draft.occurred_at || !draft.player_name.trim() || !draft.reason.trim()) {
      this.toasts.error(this.t('validation.required'));
      return null;
    }
    if (!Number.isFinite(amount) || amount === 0) {
      this.toasts.error(this.t('siphoned.amountInvalid'));
      return null;
    }

    return {
      occurred_at: this.normalizeDate(draft.occurred_at, 1),
      player_name: draft.player_name.trim(),
      reason: draft.reason.trim(),
      amount,
    };
  }

  /** Keeps UTC fields in the editor so copied Albion timestamps are not shifted. */
  private toDateTimeLocal(iso: string): string {
    const date = new Date(iso);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const second = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  private buildIngestRequest(): SiphonedIngestRequest | null {
    try {
      const rows = this.rawExport()
        .split(/\r?\n/)
        .map((line, index) => this.parseExportLine(line, index + 1))
        .filter((row): row is SiphonedIngestRow => row !== null);

      if (rows.length === 0) {
        this.toasts.error(this.t('validation.required'));
        return null;
      }

      return { rows };
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      return null;
    }
  }

  private parseExportLine(line: string, lineNumber: number): SiphonedIngestRow | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    const [dateValue, playerName, reason, amountValue] = this.parseDelimitedLine(trimmed).map(
      (field) => this.stripOuterQuotes(field.trim()),
    );
    if (this.isHeaderRow(dateValue, playerName, reason, amountValue)) {
      return null;
    }
    if (!dateValue || !playerName || !reason || !amountValue) {
      throw new Error(
        `Invalid export row at line ${lineNumber}: expected Date, Player, Reason, Amount.`,
      );
    }

    const amount = Number(amountValue.replace(/\s/g, ''));
    if (!Number.isFinite(amount)) {
      throw new Error(`Invalid amount at line ${lineNumber}: ${amountValue}`);
    }

    return {
      occurred_at: this.normalizeDate(dateValue, lineNumber),
      player_name: playerName,
      reason,
      amount,
    };
  }

  private parseDelimitedLine(line: string): string[] {
    const separator = this.detectSeparator(line);
    const fields: string[] = [];
    let currentField = '';
    let isInsideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const nextCharacter = line[index + 1];
      if (character === '"' && nextCharacter === '"' && isInsideQuotes) {
        currentField += '"';
        index += 1;
        continue;
      }
      if (character === '"') {
        isInsideQuotes = !isInsideQuotes;
        currentField += character;
        continue;
      }
      if (character === separator && !isInsideQuotes) {
        fields.push(currentField);
        currentField = '';
        continue;
      }
      currentField += character;
    }

    fields.push(currentField);
    return fields;
  }

  private detectSeparator(line: string): '\t' | ';' | ',' {
    const counts: Record<'\t' | ';' | ',', number> = { '\t': 0, ';': 0, ',': 0 };
    let isInsideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        isInsideQuotes = !isInsideQuotes;
        continue;
      }
      if (!isInsideQuotes && (character === '\t' || character === ';' || character === ',')) {
        counts[character] += 1;
      }
    }

    if (counts['\t'] > 0) {
      return '\t';
    }
    if (counts[';'] > 0) {
      return ';';
    }
    return ',';
  }

  private stripOuterQuotes(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/""/g, '"');
    }
    return value;
  }

  private isHeaderRow(
    dateValue: string | undefined,
    playerName: string | undefined,
    reason: string | undefined,
    amountValue: string | undefined,
  ): boolean {
    return (
      dateValue?.toLowerCase() === 'date' &&
      playerName?.toLowerCase() === 'player' &&
      reason?.toLowerCase() === 'reason' &&
      amountValue?.toLowerCase() === 'amount'
    );
  }

  /** Parses Albion's timezone-less timestamp as UTC so the browser locale cannot shift the hour. */
  private normalizeDate(value: string, lineNumber: number): string {
    const normalizedValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(normalizedValue);
    if (!match) {
      throw new Error(`Invalid date at line ${lineNumber}: ${value}`);
    }

    const [, year, month, day, hour, minute, second] = match;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const secondNumber = Number(second);
    const date = new Date(
      Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber, secondNumber),
    );
    const isSameUtcTimestamp =
      date.getUTCFullYear() === yearNumber &&
      date.getUTCMonth() === monthNumber - 1 &&
      date.getUTCDate() === dayNumber &&
      date.getUTCHours() === hourNumber &&
      date.getUTCMinutes() === minuteNumber &&
      date.getUTCSeconds() === secondNumber;
    if (Number.isNaN(date.getTime()) || !isSameUtcTimestamp) {
      throw new Error(`Invalid date at line ${lineNumber}: ${value}`);
    }
    return date.toISOString();
  }

  /**
   * Fetches every player's balance (up to `STATS_FETCH_LIMIT`) so the
   * Deposited/Withdrawn/Net KPI cards reflect the whole guild ledger. Kept
   * separate from `load()`, which only ever holds one page of whichever tab
   * is active.
   */
  private async loadStats(): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<SiphonedPlayerBalance>>('api/siphoned/balances', {
          page: 1,
          limit: STATS_FETCH_LIMIT,
        }),
      );
      this.statsBalances.set(data.items);
    } catch {
      // KPI cards are supplementary; load() already surfaces errors to the user.
    }
  }

  private async refreshLastUpdated(): Promise<void> {
    try {
      const batches = await firstValueFrom(
        this.api.get<SiphonedBatchSummary[]>('api/siphoned/batches'),
      );
      this.lastUpdatedAt.set(batches[0]?.ingested_at ?? null);
      if (this.tab() === 'batches') {
        this.batches.set(batches);
      }
    } catch {
      this.lastUpdatedAt.set(null);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      if (this.tab() === 'balances') {
        const query = this.balanceQuery();
        const params: Record<string, string | number> = {
          page: query.page,
          limit: query.pageSize,
        };
        if (query.search.trim()) {
          params['search'] = query.search.trim();
        }
        if (query.sort) {
          const sortMap: Record<string, string> = {
            player_name: 'name_asc',
            net: query.sort.direction === 'desc' ? 'net_desc' : 'net_asc',
          };
          params['sort'] = sortMap[query.sort.columnKey] ?? 'net_asc';
        }
        const data = await firstValueFrom(
          this.api.get<PaginatedData<SiphonedPlayerBalance>>('api/siphoned/balances', params),
        );
        this.balances.set(data.items);
        this.balanceTotal.set(data.total_items);
        return;
      }

      if (this.tab() === 'entries') {
        const query = this.entryQuery();
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
        const reason = query.columnFilters['reason'];
        if (reason) {
          params['reason'] = reason;
        }
        const page = await firstValueFrom(
          this.api.get<PaginatedData<SiphonedEntryView>>('api/siphoned/entries', params),
        );
        this.entries.set(page.items);
        this.entryTotal.set(page.total_items);
        return;
      }

      const batches = await firstValueFrom(
        this.api.get<SiphonedBatchSummary[]>('api/siphoned/batches'),
      );
      this.batches.set(batches);
      this.lastUpdatedAt.set(batches[0]?.ingested_at ?? null);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
