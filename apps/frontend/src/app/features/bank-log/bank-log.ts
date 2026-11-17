import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BankLogBatch,
  BankLogCategory,
  BankLogEntry,
  BankLogImportResult,
  BankLogImportRow,
  BankLogStatus,
  BankLogSummary,
  PaginatedData,
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
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { fetchAllPages } from '../../shared/utils/fetch-all-pages';
import { BankLogEntryDialog } from './bank-log-entry-dialog';
import { BankLogFillDialog } from './bank-log-fill-dialog';

type ImportTone = 'default' | 'warning' | 'danger';

/** Days of silver log the game keeps. */
const GAME_LOG_DAYS = 28;
type ChipTone = 'warning' | 'info' | 'success' | 'neutral';

const BANK_LOG_CATEGORIES: readonly BankLogCategory[] = [
  'payout',
  'bags',
  'loot_sale',
  'guild_expense',
  'donation',
  'other',
];

const BANK_LOG_STATUSES: readonly BankLogStatus[] = ['unmatched', 'suggested', 'matched', 'explained'];

const CATEGORY_KEYS: Record<BankLogCategory, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  guild_expense: 'bankLog.category.guild_expense',
  donation: 'bankLog.category.donation',
  other: 'bankLog.category.other',
};

const STATUS_KEYS: Record<BankLogStatus, TranslationKey> = {
  unmatched: 'bankLog.state.unmatched',
  suggested: 'bankLog.state.suggested',
  matched: 'bankLog.state.matched',
  explained: 'bankLog.state.explained',
};

const STATUS_TONES: Record<BankLogStatus, ChipTone> = {
  unmatched: 'warning',
  suggested: 'info',
  matched: 'success',
  explained: 'neutral',
};

const REMINDER_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  missing_channel: 'bankLog.reminderError.missing_channel',
  missing_staff_role: 'bankLog.reminderError.missing_staff_role',
  missing_bot_token: 'bankLog.reminderError.missing_bot_token',
  discord_refused: 'bankLog.reminderError.discord_refused',
};

/** Reads a numeric string field; anything that is not a finite number counts as 0. */
function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 25, search: '', sort: null, columnFilters: {} };
}

/**
 * Albion guild bank log review.
 *
 * Officers paste the in-game log; every row is compared with the Manager's own records
 * (payouts, split bags, loot sales, bank transactions). The Manager stays the source of
 * truth: the game log is a second check, so a row is either linked to a Manager record,
 * explained in a note, or still open.
 */
@Component({
  selector: 'app-bank-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    BankLogEntryDialog,
    BankLogFillDialog,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    .bank-log__in {
      color: var(--color-success);
    }
    .bank-log__out {
      color: var(--color-error);
    }
    .bank-log__open {
      color: var(--color-warning);
      font-weight: 600;
    }
    .bank-log__nowrap {
      white-space: nowrap;
    }
    .bank-log__strong {
      font-weight: 600;
      color: var(--color-text);
    }
    .bank-log__linked {
      color: var(--color-text-secondary);
    }
    .bank-log__section {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .bank-log__toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .bank-log__period {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.5rem;
    }
    .bank-log__date {
      width: 10.5rem;
    }
    .bank-log__onboarding {
      display: grid;
      justify-items: center;
      gap: 1rem;
      padding: 2rem var(--card-padding);
    }
    .bank-log__steps {
      display: grid;
      gap: 0.5rem;
      max-width: 34rem;
      margin: 0;
      padding-left: 1.25rem;
      list-style: decimal;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-sm);
    }
    .bank-log__setup,
    .bank-log__status-note {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
      margin: 0;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
    }
    .bank-log__status {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(12rem, 20rem);
      align-items: center;
      gap: 0.75rem 1.5rem;
      padding: var(--card-padding);
    }
    .bank-log__status--warning {
      border-color: var(--color-warning);
    }
    .bank-log__status--danger {
      border-color: var(--color-error);
    }
    .bank-log__status-main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      min-width: 0;
    }
    .bank-log__status-text {
      margin: 0;
      font-size: var(--ui-text-sm);
      color: var(--color-text-secondary);
    }
    .bank-log__status-note {
      grid-column: 1 / -1;
    }
    .bank-log__meter {
      display: grid;
      gap: 0.375rem;
    }
    .bank-log__meter-track {
      height: 0.375rem;
      overflow: hidden;
      border-radius: var(--radius-badges);
      background: var(--color-surface-2);
    }
    .bank-log__meter-fill {
      height: 100%;
      background: var(--color-success);
    }
    .bank-log__status--warning .bank-log__meter-fill {
      background: var(--color-warning);
    }
    .bank-log__status--danger .bank-log__meter-fill {
      background: var(--color-error);
    }
    .bank-log__table-card {
      overflow: hidden;
    }
    .bank-log__card-title {
      display: grid;
      gap: 0.25rem;
      padding: var(--card-padding) var(--card-padding) 0.75rem;
      margin: 0;
    }
    @media (max-width: 640px) {
      .bank-log__status {
        grid-template-columns: minmax(0, 1fr);
      }
      .bank-log__date {
        width: 100%;
      }
      .bank-log__period,
      .bank-log__period .filter-field {
        flex: 1 1 8rem;
      }
    }
  `,
  template: `
    <app-page-header
      [title]="t('bankLog.title')"
      [subtitle]="t('bankLog.subtitle')"
      [menuItems]="headerMenu()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onHeaderMenu($event)"
    >
      @if (canManage() && (summary()?.suggested ?? 0) > 0) {
        <button ngProjectAs="[pageActions]" type="button" class="btn btn--outline" (click)="showFill.set(true)">
          <app-icon name="sparkles" size="0.875rem" />
          {{ t('bankLog.fill.open', { count: summary()?.suggested ?? 0 }) }}
        </button>
      }
      @if (canManage()) {
        <button ngProjectAs="[pageActions]" type="button" class="btn btn--primary" (click)="openImport()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('bankLog.importLog') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      @if (!canView()) {
        <section class="card">
          <app-empty-state icon="lock" [message]="t('bankLog.missingViewPermission')" />
        </section>
      } @else if (summary(); as s) {
        @if (!s.import.last_import_at) {
          <!-- First run: one clear next step instead of a page of zeros. -->
          <section class="card bank-log__onboarding">
            <app-empty-state
              icon="bank"
              [message]="t('bankLog.empty.title')"
              [hint]="t('bankLog.empty.hint')"
            >
              @if (canManage()) {
                <button type="button" class="btn btn--primary" (click)="openImport()">
                  <app-icon name="plus" size="0.875rem" />
                  {{ t('bankLog.importLog') }}
                </button>
              } @else {
                <p class="hint">{{ t('bankLog.missingManagePermission') }}</p>
              }
            </app-empty-state>
            <ol class="bank-log__steps">
              <li>{{ t('bankLog.empty.step1') }}</li>
              <li>{{ t('bankLog.empty.step2') }}</li>
              <li>{{ t('bankLog.empty.step3') }}</li>
            </ol>
            @if (reminderNeedsSetup()) {
              <p class="hint bank-log__setup">
                <app-icon name="bell" size="0.875rem" />
                <span>{{ t('bankLog.empty.reminder') }}</span>
                <a routerLink="/admin/discord">{{ t('bankLog.importStatus.configureLink') }}</a>
              </p>
            }
          </section>
        } @else {
          <!-- Import status: one line with the state, the last import and the margin left. -->
          <section
            class="card bank-log__status"
            [class.bank-log__status--warning]="importTone() === 'warning'"
            [class.bank-log__status--danger]="importTone() === 'danger'"
            [attr.aria-label]="t('bankLog.importStatus.heading')"
          >
            <div class="bank-log__status-main">
              <app-status-chip
                [value]="importTone()"
                [label]="importStateLabel()"
                [toneOverride]="importTone() === 'danger' ? 'error' : importTone() === 'warning' ? 'warning' : 'success'"
              />
              <p class="bank-log__status-text">
                {{ t('bankLog.importStatus.lastImport') }}
                <strong class="bank-log__strong">{{ formatDateTime(s.import.last_import_at) }}</strong>
                <span class="hint">· {{ sinceImportText() }}</span>
              </p>
            </div>
            <div class="bank-log__meter" role="img" [attr.aria-label]="marginText()">
              <div class="bank-log__meter-track">
                <div class="bank-log__meter-fill" [style.width.%]="windowUsedPercent()"></div>
              </div>
              <p class="hint">{{ marginText() }}</p>
            </div>
            @if (s.import.reminder_error) {
              <p class="bank-log__status-note" role="status">
                <app-icon name="alert" size="0.875rem" />
                <span>{{ reminderErrorText(s.import.reminder_error) }}</span>
                <a routerLink="/admin/discord">{{ t('bankLog.importStatus.configureLink') }}</a>
              </p>
            } @else if (reminderNeedsSetup()) {
              <p class="bank-log__status-note">
                <app-icon name="bell" size="0.875rem" />
                <span>{{ t('bankLog.importStatus.reminderNotConfigured') }}</span>
                <a routerLink="/admin/discord">{{ t('bankLog.importStatus.configureLink') }}</a>
              </p>
            }
          </section>

          <!-- Period and its figures -->
          <section class="bank-log__section" aria-labelledby="bank-log-overview-heading">
            <div class="bank-log__toolbar">
              <div>
                <h2 id="bank-log-overview-heading" class="section-title">{{ t('bankLog.overview') }}</h2>
                <p class="hint">{{ coveredText() }}</p>
              </div>
              <div class="bank-log__period" role="group" [attr.aria-label]="t('bankLog.period.title')">
                <label class="filter-field">
                  <span class="filter-field__label">{{ t('bankLog.period.from') }}</span>
                  <input class="input input--sm bank-log__date" name="from" type="date" [value]="fromDate()" [max]="toDate() || null" (change)="onFromChange($event)" />
                </label>
                <label class="filter-field">
                  <span class="filter-field__label">{{ t('bankLog.period.to') }}</span>
                  <input class="input input--sm bank-log__date" name="to" type="date" [value]="toDate()" [min]="fromDate() || null" (change)="onToChange($event)" />
                </label>
                @if (fromDate() || toDate()) {
                  <button type="button" class="btn btn--ghost btn--sm" (click)="resetPeriod()">
                    {{ t('bankLog.period.lastDays') }}
                  </button>
                }
              </div>
            </div>
            <app-summary-band [ariaLabel]="t('bankLog.summary')" [items]="summaryItems()" />
          </section>

          @if (visibleCategories().length > 0) {
            <section class="card bank-log__table-card" aria-labelledby="bank-log-categories-heading">
              <h2 id="bank-log-categories-heading" class="section-title bank-log__card-title">{{ t('bankLog.categories') }}</h2>
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('common.category') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.table.rows') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.table.gameTotal') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.table.linked') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.state.explained') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.table.open') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (category of visibleCategories(); track category.category) {
                      <tr>
                        <th scope="row">{{ categoryLabel(category.category) }}</th>
                        <td class="num">{{ category.rows }}</td>
                        <td class="num">{{ formatSigned(category.game_total) }}</td>
                        <td class="num">{{ formatSigned(category.linked_total) }}</td>
                        <td class="num">{{ formatSigned(category.explained_total) }}</td>
                        <td class="num" [class.bank-log__open]="numeric(category.open_total) !== 0">
                          {{ formatSigned(category.open_total) }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <!-- Rows -->
          <section class="bank-log__section" aria-labelledby="bank-log-rows-heading">
            <div>
              <h2 id="bank-log-rows-heading" class="section-title">{{ t('bankLog.rows') }}</h2>
              <p class="hint">{{ t('bankLog.rowsHint') }}</p>
            </div>
            <!-- A new generation remounts the table so its page returns to 1 when the period changes. -->
            @for (generation of [tableGeneration()]; track generation) {
              <app-data-table
                [columns]="entryColumns()"
                [rows]="entries()"
                [loading]="entriesLoading()"
                [error]="entriesFailed()"
                (retry)="loadEntries()"
                [trackBy]="trackEntry"
                [serverMode]="true"
                [exportRows]="exportAll"
                exportFileName="bank-log"
                [syncUrl]="false"
                [totalItems]="entryTotal()"
                [pageSize]="25"
                [rowClickable]="true"
                (rowClick)="openEntry($event)"
                (pageChange)="onEntriesChange($event)"
                emptyIcon="list"
                [emptyLabel]="'bankLog.table.empty'"
                [ariaLabel]="t('bankLog.rows')"
                [searchPlaceholder]="t('bankLog.table.search')"
              >
                <ng-template dataTableCell="occurred_at" let-row>
                  <span class="bank-log__nowrap">{{ formatDateTime(row.occurred_at) }}</span>
                </ng-template>
                <ng-template dataTableCell="amount" let-row>
                  <span class="num font-semibold" [class.bank-log__in]="isIncoming(row)" [class.bank-log__out]="!isIncoming(row)">
                    {{ formatSigned(row.amount) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="category" let-row>
                  <span class="chip chip--neutral">{{ categoryLabel(row.category) }}</span>
                </ng-template>
                <ng-template dataTableCell="status" let-row>
                  <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" [toneOverride]="statusTone(row.status)" />
                </ng-template>
                <ng-template dataTableCell="linked" let-row>
                  <span class="bank-log__linked">{{ linkedLabel(row) || '—' }}</span>
                </ng-template>
              </app-data-table>
            }
          </section>

          <!-- Imports -->
          <section class="card bank-log__table-card" aria-labelledby="bank-log-batches-heading">
            <div class="bank-log__card-title">
              <h2 id="bank-log-batches-heading" class="section-title">{{ t('bankLog.batches.title') }}</h2>
              <p class="hint">{{ t('bankLog.batches.hint') }}</p>
            </div>
            @if (batchesLoading() && batches().length === 0) {
              <app-loading variant="lines" [rows]="2" />
            } @else {
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('bankLog.batches.importedAt') }}</th>
                      <th scope="col">{{ t('bankLog.batches.range') }}</th>
                      <th scope="col" class="num">{{ t('bankLog.table.rows') }}</th>
                      @if (canManage()) {
                        <th scope="col" class="num"><span class="sr-only">{{ t('common.actions') }}</span></th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (batch of batches(); track batch.batch_id) {
                      <tr>
                        <td class="bank-log__nowrap">{{ formatDateTime(batch.imported_at) }}</td>
                        <td class="bank-log__nowrap">{{ formatDay(batch.first_at) }} – {{ formatDay(batch.last_at) }}</td>
                        <td class="num">{{ batch.rows }}</td>
                        @if (canManage()) {
                          <td class="num">
                            <app-menu
                              [items]="batchMenu"
                              [label]="t('ui.menu.moreActions')"
                              (itemSelect)="batchToDelete.set(batch)"
                            />
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        }
      } @else if (summaryFailed()) {
        <app-error-state [message]="t('bankLog.loadFailed')" [retryLabel]="t('common.retry')" (retry)="reloadAll()" />
      } @else {
        <app-loading variant="summary" />
        <app-loading variant="table" />
      }
    </app-page-stack>

    <!-- Import dialog -->
    @if (showImport()) {
      <app-dialog [title]="t('bankLog.importLog')" size="lg" (closed)="closeImport()">
        <form id="bank-log-import-form" class="grid gap-3" (submit)="onImportSubmit($event)">
          <label>
            <span class="label">{{ t('bankLog.import.label') }}</span>
            <textarea
              class="textarea font-mono text-xs"
              name="log_rows"
              rows="10"
              required
              [value]="importText()"
              (input)="onImportInput($event)"
              [attr.aria-describedby]="importParse().error ? 'bank-log-import-hint bank-log-import-error' : 'bank-log-import-hint'"
              placeholder='[{"Date":"2026-11-16 23:10:00","Player":"Galvdon","Reason":"Withdrawal","Amount":"-7414881"}]'
            ></textarea>
          </label>
          <p id="bank-log-import-hint" class="hint">{{ t('bankLog.import.hint') }}</p>
          @if (importParse().error; as error) {
            <p id="bank-log-import-error" class="hint" role="alert">{{ error }}</p>
          } @else if (importParse().rows.length > 0) {
            <p class="hint" role="status">{{ t('bankLog.import.ready', { count: importParse().rows.length }) }}</p>
          }
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeImport()">{{ t('common.cancel') }}</button>
          <button
            type="submit"
            class="btn btn--primary"
            form="bank-log-import-form"
            [disabled]="saving() || !importReady()"
          >
            {{ t('bankLog.import.submit') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Row detail -->
    @if (detail(); as row) {
      <app-bank-log-entry-dialog
        [initial]="row"
        [canManage]="canManage()"
        [canCreateTransaction]="canCreateTransaction()"
        (changed)="reloadAll()"
        (closed)="detail.set(null)"
      />
    }

    <!-- Fill all suggested -->
    @if (showFill()) {
      <app-bank-log-fill-dialog (changed)="reloadAll()" (closed)="showFill.set(false)" />
    }

    <!-- Delete import confirmation -->
    @if (batchToDelete(); as batch) {
      <app-dialog [title]="t('common.confirm')" (closed)="batchToDelete.set(null)">
        <p>{{ t('bankLog.batches.confirmDelete') }}</p>
        <p class="hint num">{{ t('bankLog.table.rows') }}: {{ batch.rows }} · {{ formatDateTime(batch.first_at) }} – {{ formatDateTime(batch.last_at) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="batchToDelete.set(null)">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn--danger" [disabled]="saving()" (click)="deleteBatch(batch)">
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class BankLog {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly canView = computed(() => this.auth.hasPermission('banklog.view'));
  protected readonly canManage = computed(() => this.auth.hasPermission('banklog.manage'));
  protected readonly canCreateTransaction = computed(
    () => this.canManage() && this.auth.hasPermission('bank.transactions.create'),
  );

  protected readonly saving = signal(false);
  protected readonly summary = signal<BankLogSummary | null>(null);
  protected readonly summaryLoading = signal(false);
  protected readonly summaryFailed = signal(false);

  /** Period filters as `YYYY-MM-DD`; empty means the backend default (last 28 UTC days). */
  protected readonly fromDate = signal('');
  protected readonly toDate = signal('');

  protected readonly entries = signal<BankLogEntry[]>([]);
  protected readonly entryTotal = signal(0);
  protected readonly entriesLoading = signal(false);
  protected readonly entriesFailed = signal(false);
  protected readonly entryQuery = signal<DataTablePageChange>(emptyPageChange());
  protected readonly tableGeneration = signal(0);

  protected readonly batches = signal<BankLogBatch[]>([]);
  protected readonly batchesLoading = signal(false);
  protected readonly batchToDelete = signal<BankLogBatch | null>(null);

  protected readonly showImport = signal(false);
  protected readonly importText = signal('');

  protected readonly detail = signal<BankLogEntry | null>(null);
  protected readonly showFill = signal(false);

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly headerMenu = computed<MenuItem[]>(() => [
    ...(this.canManage() && this.hasImported()
      ? [{ id: 'suggestions', label: this.t('bankLog.refreshSuggestions'), icon: 'sparkles' as const, disabled: this.saving() }]
      : []),
    { id: 'refresh', label: this.t('common.refreshNow'), icon: 'refresh' as const, disabled: this.summaryLoading() || this.entriesLoading() },
  ]);

  protected readonly batchMenu: readonly MenuItem[] = [
    { id: 'delete', label: this.translate.t('common.delete'), danger: true },
  ];

  protected readonly numeric = numeric;

  protected readonly trackEntry = (row: BankLogEntry): unknown => row.id;

  protected readonly importParse = computed(() => this.parseImport(this.importText()));
  protected readonly importReady = computed(
    () => !this.importParse().error && this.importParse().rows.length > 0,
  );

  protected readonly hasImported = computed(() => Boolean(this.summary()?.import.last_import_at));

  /** Danger once rows have left the game log unimported, warning once the import is due. */
  protected readonly importTone = computed<ImportTone>(() => {
    const status = this.summary()?.import;
    if (!status?.last_import_at) {
      return 'default';
    }
    if (status.days_until_loss !== null && status.days_until_loss <= 0) {
      return 'danger';
    }
    if (status.days_since_import !== null && status.days_since_import >= status.reminder_after_days) {
      return 'warning';
    }
    return 'default';
  });

  protected readonly importStateLabel = computed(() => {
    const tone = this.importTone();
    if (tone === 'danger') {
      return this.t('bankLog.importStatus.rowsLost');
    }
    return tone === 'warning'
      ? this.t('bankLog.importStatus.importDue')
      : this.t('bankLog.importStatus.upToDate');
  });

  protected readonly sinceImportText = computed(() => {
    const days = this.summary()?.import.days_since_import ?? 0;
    if (days <= 0) {
      return this.t('bankLog.importStatus.today');
    }
    return days === 1
      ? this.t('bankLog.importStatus.yesterday')
      : this.t('bankLog.importStatus.daysAgo', { count: days });
  });

  /** Share of the 28-day game window already used since the last import. */
  protected readonly windowUsedPercent = computed(() => {
    const days = this.summary()?.import.days_since_import ?? 0;
    return Math.min(100, Math.max(4, (days / GAME_LOG_DAYS) * 100));
  });

  protected readonly marginText = computed(() => {
    const left = this.summary()?.import.days_until_loss ?? GAME_LOG_DAYS;
    return left > 0
      ? this.t('bankLog.importStatus.marginLeft', { count: left })
      : this.t('bankLog.importStatus.marginGone');
  });

  protected readonly reminderNeedsSetup = computed(() => {
    const status = this.summary()?.import;
    return Boolean(status && (!status.reminder_channel_set || !status.staff_role_set));
  });

  /** "Game rows from X to Y", or a note that the chosen period holds no rows. */
  protected readonly coveredText = computed(() => {
    const s = this.summary();
    if (!s?.covered_from || !s.covered_to) {
      return this.t('bankLog.period.noRows', { from: this.formatDay(s?.from), to: this.formatDay(s?.to) });
    }
    return this.t('bankLog.period.covered', {
      from: this.formatDay(s.covered_from),
      to: this.formatDay(s.covered_to),
    });
  });

  protected readonly visibleCategories = computed(
    () => this.summary()?.categories.filter((category) => category.rows > 0) ?? [],
  );

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const s = this.summary();
    if (!s) {
      return [];
    }
    const open = s.unmatched + s.suggested;
    const reconciled = s.matched + s.explained;
    const items: SummaryItem[] = [
      {
        label: this.t('bankLog.stat.open'),
        value: open,
        hint: this.t('bankLog.stat.openHint', { unmatched: s.unmatched, suggested: s.suggested }),
        tone: open > 0 ? 'warning' : 'success',
      },
      {
        label: this.t('bankLog.stat.reconciled'),
        value: reconciled,
        hint: this.t('bankLog.stat.reconciledHint', { matched: s.matched, explained: s.explained }),
      },
      { label: this.t('bankLog.stat.gameIn'), value: this.formatAmount(s.game_in) },
      { label: this.t('bankLog.stat.gameOut'), value: this.formatAmount(Math.abs(numeric(s.game_out))) },
    ];
    if (s.covered_from) {
      const difference = numeric(s.game_payouts) - numeric(s.manager_payouts);
      const hint = this.t('bankLog.stat.payoutsHint', {
        manager: this.formatCompact(s.manager_payouts),
        game: this.formatCompact(s.game_payouts),
      });
      items.push(
        Math.abs(difference) >= 1
          ? { label: this.t('bankLog.stat.payoutDifference'), value: this.formatSigned(difference), hint, tone: 'danger' }
          : { label: this.t('bankLog.stat.payoutDifference'), value: this.t('bankLog.stat.payoutsMatch'), hint, tone: 'success' },
      );
    }
    return items;
  });

  protected readonly entryColumns = computed<DataTableColumn<BankLogEntry>[]>(() => [
    {
      key: 'occurred_at',
      label: 'common.date',
      accessor: (row) => row.occurred_at,
    },
    {
      key: 'player',
      label: 'common.player',
      searchable: true,
      accessor: (row) => row.player_name,
    },
    {
      key: 'reason',
      label: 'bankLog.reason',
      searchable: true,
      accessor: (row) => row.reason,
    },
    {
      key: 'amount',
      label: 'common.amount',
      align: 'right',
      accessor: (row) => row.amount,
    },
    {
      key: 'category',
      label: 'common.category',
      accessor: (row) => row.category,
      filterOptions: BANK_LOG_CATEGORIES.map((category) => ({
        value: category,
        label: this.categoryLabel(category),
      })),
    },
    {
      key: 'status',
      label: 'common.status',
      accessor: (row) => row.status,
      filterOptions: BANK_LOG_STATUSES.map((status) => ({ value: status, label: this.statusLabel(status) })),
    },
    {
      key: 'linked',
      label: 'bankLog.linkedTo',
      accessor: (row) => this.linkedLabel(row),
    },
  ]);

  constructor() {
    void this.reloadAll();
  }

  // ------------------------------------------------------------------ header and period

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    } else if (id === 'suggestions') {
      void this.refreshSuggestions();
    }
  }

  protected async refreshNow(): Promise<void> {
    await this.reloadAll();
  }

  protected onFromChange(event: Event): void {
    this.fromDate.set((event.target as HTMLInputElement).value);
    this.onPeriodChange();
  }

  protected onToChange(event: Event): void {
    this.toDate.set((event.target as HTMLInputElement).value);
    this.onPeriodChange();
  }

  protected resetPeriod(): void {
    this.fromDate.set('');
    this.toDate.set('');
    this.onPeriodChange();
  }

  private onPeriodChange(): void {
    // The table keeps its own page, so reset both it (through a remount) and the query.
    this.entryQuery.set(emptyPageChange());
    this.tableGeneration.update((generation) => generation + 1);
    void this.reloadAll();
  }

  // ------------------------------------------------------------------ loading

  protected async reloadAll(): Promise<void> {
    if (!this.canView()) {
      return;
    }
    await Promise.all([this.loadSummary(), this.loadEntries(), this.loadBatches()]);
  }

  protected async loadSummary(): Promise<void> {
    this.summaryLoading.set(true);
    this.summaryFailed.set(false);
    try {
      const summary = await firstValueFrom(
        this.api.get<BankLogSummary>('api/bank/log/summary', this.periodParams()),
      );
      this.summary.set(summary);
    } catch {
      this.summaryFailed.set(true);
    } finally {
      this.summaryLoading.set(false);
    }
  }

  /** Every row matching the current period, search and filters, for the CSV export. */
  protected readonly exportAll = (): Promise<readonly BankLogEntry[]> =>
    fetchAllPages((page, limit) =>
      firstValueFrom(
        this.api.get<PaginatedData<BankLogEntry>>('api/bank/log/entries', this.entryParams(page, limit)),
      ),
    );

  private entryParams(page: number, limit: number): Record<string, string | number> {
    const query = this.entryQuery();
    const params: Record<string, string | number> = { ...this.periodParams(), page, limit };
    const search = query.search.trim();
    if (search) {
      params['search'] = search;
    }
    const status = query.columnFilters['status'];
    if (status) {
      params['status'] = status;
    }
    const category = query.columnFilters['category'];
    if (category) {
      params['category'] = category;
    }
    return params;
  }

  protected async loadEntries(): Promise<void> {
    this.entriesLoading.set(true);
    this.entriesFailed.set(false);
    try {
      const query = this.entryQuery();
      const page = await firstValueFrom(
        this.api.get<PaginatedData<BankLogEntry>>(
          'api/bank/log/entries',
          this.entryParams(query.page, query.pageSize),
        ),
      );
      this.entries.set(page.items);
      this.entryTotal.set(page.total_items);
    } catch {
      this.entriesFailed.set(true);
    } finally {
      this.entriesLoading.set(false);
    }
  }

  protected onEntriesChange(event: DataTablePageChange): void {
    this.entryQuery.set(event);
    void this.loadEntries();
  }

  protected async loadBatches(): Promise<void> {
    this.batchesLoading.set(true);
    try {
      this.batches.set(await firstValueFrom(this.api.get<BankLogBatch[]>('api/bank/log/batches')));
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.batchesLoading.set(false);
    }
  }

  // ------------------------------------------------------------------ mutations

  /**
   * Runs one write, toasts the result, then reloads the summary and the table. Returns whether
   * the write succeeded so callers can close their dialogs.
   */
  private async mutate<T>(action: () => Promise<T>, toastFor: (result: T) => string): Promise<boolean> {
    this.saving.set(true);
    try {
      const result = await action();
      this.toasts.success(toastFor(result));
      await this.reloadAll();
      return true;
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  protected async refreshSuggestions(): Promise<void> {
    this.saving.set(true);
    try {
      const result = await firstValueFrom(
        this.api.post<{ suggestions: number }>('api/bank/log/suggestions/refresh'),
      );
      this.toasts.success(this.t('bankLog.suggestionsRefreshed', { count: result.suggestions }));
      await this.reloadAll();
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected openImport(): void {
    this.importText.set('');
    this.showImport.set(true);
  }

  protected closeImport(): void {
    this.showImport.set(false);
  }

  protected onImportInput(event: Event): void {
    this.importText.set((event.target as HTMLTextAreaElement).value);
  }

  protected onImportSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.submitImport();
  }

  private async submitImport(): Promise<void> {
    const parsed = this.importParse();
    if (parsed.error || parsed.rows.length === 0) {
      return;
    }
    const ok = await this.mutate(
      () =>
        firstValueFrom(
          this.api.post<BankLogImportResult>('api/bank/log/import', { rows: parsed.rows }),
        ),
      (result) =>
        this.t('bankLog.import.success', {
          inserted: result.inserted,
          alreadyStored: result.already_stored,
          duplicatesKept: result.duplicates_kept,
          suggestions: result.suggestions,
        }),
    );
    if (ok) {
      this.importText.set('');
      this.showImport.set(false);
      await this.loadBatches();
    }
  }

  protected async deleteBatch(batch: BankLogBatch): Promise<void> {
    this.batchToDelete.set(null);
    const ok = await this.mutate(
      () =>
        firstValueFrom(
          this.api.delete(`api/bank/log/batches/${encodeURIComponent(batch.batch_id)}`),
        ),
      () => this.t('bankLog.batches.deleted'),
    );
    if (ok) {
      await this.loadBatches();
    }
  }

  // ------------------------------------------------------------------ row detail

  protected openEntry(row: BankLogEntry): void {
    this.detail.set(row);
  }

  // ------------------------------------------------------------------ helpers

  private periodParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (this.fromDate()) {
      params['from'] = this.fromDate();
    }
    if (this.toDate()) {
      params['to'] = this.toDate();
    }
    return params;
  }

  protected isIncoming(row: BankLogEntry): boolean {
    return numeric(row.amount) >= 0;
  }

  protected categoryLabel(category: BankLogCategory): string {
    return this.t(CATEGORY_KEYS[category]);
  }

  protected statusLabel(status: BankLogStatus): string {
    return this.t(STATUS_KEYS[status]);
  }

  protected statusTone(status: BankLogStatus): ChipTone {
    return STATUS_TONES[status];
  }

  /** First link's first target plus its member; extra links are counted. */
  protected linkedLabel(row: BankLogEntry): string {
    const link = row.links[0];
    const target = link?.targets[0];
    if (!link || !target) {
      return '';
    }
    const base = target.member_username ? `${target.label} · ${target.member_username}` : target.label;
    return row.links.length > 1
      ? `${base} ${this.t('bankLog.linkedMore', { count: row.links.length - 1 })}`
      : base;
  }

  protected reminderErrorText(code: string): string {
    const key = REMINDER_ERROR_KEYS[code];
    return key ? this.t(key) : this.t('bankLog.reminderError.unknown', { code });
  }

  protected formatAmount(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 0 }).format(
      numeric(value),
    );
  }

  /** Short silver amount for hints, e.g. "7.4M". */
  protected formatCompact(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.translate.locale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(numeric(value));
  }

  protected formatSigned(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.translate.locale(), {
      maximumFractionDigits: 0,
      signDisplay: 'exceptZero',
    }).format(numeric(value));
  }

  /** Shows the time in UTC, the timezone the game log is written in. */
  /** Calendar day in UTC, e.g. "16 Nov". */
  protected formatDay(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return new Intl.DateTimeFormat(this.translate.locale(), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(date);
  }

  protected formatDateTime(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    const formatted = new Intl.DateTimeFormat(this.translate.locale(), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).format(date);
    return `${formatted} UTC`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : this.t('common.error');
  }

  /** Parses the pasted game export. Errors are returned translated, ready to show. */
  private parseImport(text: string): { rows: BankLogImportRow[]; error: string | null } {
    const trimmed = text.trim();
    if (!trimmed) {
      return { rows: [], error: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { rows: [], error: this.t('bankLog.import.invalidJson') };
    }
    if (!Array.isArray(parsed)) {
      return { rows: [], error: this.t('bankLog.import.notArray') };
    }
    const rows: BankLogImportRow[] = [];
    for (const [index, item] of parsed.entries()) {
      const row = this.toImportRow(item);
      if (!row) {
        return { rows: [], error: this.t('bankLog.import.badRow', { index: index + 1 }) };
      }
      rows.push(row);
    }
    return { rows, error: null };
  }

  private toImportRow(item: unknown): BankLogImportRow | null {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const date = record['Date'];
    const player = record['Player'];
    const reason = record['Reason'];
    const amount = record['Amount'];
    if (typeof date !== 'string' || typeof player !== 'string' || typeof reason !== 'string') {
      return null;
    }
    let amountText: string;
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      amountText = String(amount);
    } else if (typeof amount === 'string' && amount.trim() !== '') {
      amountText = amount.trim();
    } else {
      return null;
    }
    return { Date: date, Player: player, Reason: reason, Amount: amountText };
  }
}
