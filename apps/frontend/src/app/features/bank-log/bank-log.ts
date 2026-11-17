import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BankLogBatch,
  BankLogCandidate,
  BankLogCategory,
  BankLogEntry,
  BankLogImportResult,
  BankLogImportRow,
  BankLogLink,
  BankLogLinkKind,
  BankLogLinkTarget,
  BankLogStatus,
  BankLogSummary,
  PaginatedData,
  UserProfile,
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
import type { MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Select, type SelectOption } from '../../shared/components/select/select';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { fetchAllPages } from '../../shared/utils/fetch-all-pages';

type ImportTone = 'default' | 'warning' | 'danger';
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

const LINK_KIND_KEYS: Record<BankLogLinkKind, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  manual: 'bankLog.links.kind.manual',
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
  return { page: 1, pageSize: 10, search: '', sort: null, columnFilters: {} };
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
    Icon,
    PageHeader,
    PageStack,
    RouterLink,
    Select,
    SearchableSelect,
    StatusChip,
    SummaryBand,
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
    .bank-log__import--warning {
      border-color: var(--color-warning);
    }
    .bank-log__import--danger {
      border-color: var(--color-error);
    }
    .bank-log__link {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 0.75rem;
      display: grid;
      gap: 0.5rem;
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
      @if (canManage()) {
        <ng-container ngProjectAs="[pageActions]">
          <button type="button" class="btn btn--outline btn--sm" [disabled]="saving()" (click)="refreshSuggestions()">
            <app-icon name="refresh" size="0.875rem" />
            {{ t('bankLog.refreshSuggestions') }}
          </button>
          <button type="button" class="btn btn--primary btn--sm" (click)="openImport()">
            <app-icon name="sparkles" size="0.875rem" />
            {{ t('bankLog.importLog') }}
          </button>
        </ng-container>
      }
    </app-page-header>

    <app-page-stack>
      @if (!canView()) {
        <p class="hint" role="status">{{ t('bankLog.missingViewPermission') }}</p>
      } @else {
        @if (!canManage()) {
          <p class="hint" role="status">{{ t('bankLog.missingManagePermission') }}</p>
        }

        <!-- Import status -->
        @if (summary(); as s) {
          <section
            class="card grid gap-2"
            [class.bank-log__import--warning]="importTone() === 'warning'"
            [class.bank-log__import--danger]="importTone() === 'danger'"
            aria-labelledby="bank-log-import-heading"
          >
            <h2 id="bank-log-import-heading" class="text-base font-semibold">
              {{ t('bankLog.importStatus.heading') }}
            </h2>
            <dl class="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt class="hint">{{ t('bankLog.importStatus.lastImport') }}</dt>
                <dd class="num">
                  {{ s.import.last_import_at ? formatDateTime(s.import.last_import_at) : t('bankLog.importStatus.never') }}
                </dd>
              </div>
              <div>
                <dt class="hint">{{ t('bankLog.importStatus.sinceImport') }}</dt>
                <dd class="num">
                  {{ s.import.days_since_import === null ? '—' : t('bankLog.importStatus.daysSince', { count: s.import.days_since_import }) }}
                </dd>
              </div>
              <div>
                <dt class="hint">{{ t('bankLog.importStatus.untilLoss') }}</dt>
                <dd class="num">
                  {{ s.import.days_until_loss === null ? '—' : t('bankLog.importStatus.daysUntilLoss', { count: s.import.days_until_loss }) }}
                </dd>
              </div>
            </dl>
            @if (importTone() === 'danger') {
              <p class="text-sm font-semibold" role="alert">{{ t('bankLog.importStatus.rowsLost') }}</p>
            } @else if (importTone() === 'warning') {
              <p class="text-sm font-semibold" role="status">{{ t('bankLog.importStatus.importDue') }}</p>
            }
            @if (!s.import.reminder_channel_set || !s.import.staff_role_set) {
              <p class="hint">
                {{ t('bankLog.importStatus.reminderNotConfigured') }} ·
                <a routerLink="/admin/discord">{{ t('bankLog.importStatus.configureLink') }}</a>
              </p>
            }
            @if (s.import.reminder_error) {
              <p class="hint">{{ reminderErrorText(s.import.reminder_error) }}</p>
            }
          </section>
        } @else if (summaryFailed()) {
          <p class="hint" role="alert">{{ t('bankLog.loadFailed') }}</p>
        } @else if (summaryLoading()) {
          <p class="hint" role="status">{{ t('common.loading') }}</p>
        }

        <!-- Period -->
        <div class="card grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" role="group" [attr.aria-label]="t('bankLog.period.title')">
          <label>
            <span class="label">{{ t('bankLog.period.from') }}</span>
            <input class="input" name="from" type="date" [value]="fromDate()" (change)="onFromChange($event)" />
          </label>
          <label>
            <span class="label">{{ t('bankLog.period.to') }}</span>
            <input class="input" name="to" type="date" [value]="toDate()" (change)="onToChange($event)" />
          </label>
          <button type="button" class="btn btn--ghost" (click)="resetPeriod()">
            {{ t('bankLog.period.lastDays') }}
          </button>
        </div>
        <p class="hint">{{ t('bankLog.period.hint') }}</p>

        <!-- Period summary -->
        @if (summary(); as s) {
          <app-summary-band [ariaLabel]="t('bankLog.summary')" [items]="summaryItems()" />

          <section class="card grid gap-2" aria-labelledby="bank-log-categories-heading">
            <h2 id="bank-log-categories-heading" class="text-base font-semibold">{{ t('bankLog.categories') }}</h2>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col" class="text-left">{{ t('common.category') }}</th>
                    <th scope="col" class="text-right">{{ t('bankLog.table.rows') }}</th>
                    <th scope="col" class="text-right">{{ t('bankLog.table.gameTotal') }}</th>
                    <th scope="col" class="text-right">{{ t('bankLog.table.linked') }}</th>
                    <th scope="col" class="text-right">{{ t('bankLog.state.explained') }}</th>
                    <th scope="col" class="text-right">{{ t('bankLog.table.open') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (category of s.categories; track category.category) {
                    <tr>
                      <th scope="row" class="text-left font-normal">{{ categoryLabel(category.category) }}</th>
                      <td class="num text-right">{{ category.rows }}</td>
                      <td class="num text-right">{{ formatAmount(category.game_total) }}</td>
                      <td class="num text-right">{{ formatAmount(category.linked_total) }}</td>
                      <td class="num text-right">{{ formatAmount(category.explained_total) }}</td>
                      <td class="num text-right">{{ formatAmount(category.open_total) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- Rows -->
        <section class="grid gap-2" aria-labelledby="bank-log-rows-heading">
          <h2 id="bank-log-rows-heading" class="text-base font-semibold">{{ t('bankLog.rows') }}</h2>
          <p class="hint">{{ t('bankLog.rowsHint') }}</p>
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
              [pageSize]="10"
              [rowClickable]="true"
              (rowClick)="openEntry($event)"
              (pageChange)="onEntriesChange($event)"
              emptyIcon="activity"
              [ariaLabel]="t('bankLog.rows')"
              [searchPlaceholder]="t('common.search')"
            >
              <ng-template dataTableCell="occurred_at" let-row>
                <span class="num">{{ formatDateTime(row.occurred_at) }}</span>
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
                <span class="text-sm">{{ linkedLabel(row) }}</span>
              </ng-template>
            </app-data-table>
          }
        </section>

        <!-- Imports -->
        <details class="card" (toggle)="onBatchesToggle($event)">
          <summary class="cursor-pointer font-semibold">{{ t('bankLog.batches.title') }}</summary>
          <div class="mt-3 grid gap-2">
            <p class="hint">{{ t('bankLog.batches.hint') }}</p>
            @if (batchesLoading()) {
              <p class="hint" role="status">{{ t('common.loading') }}</p>
            } @else if (batches().length === 0) {
              <p class="hint">{{ t('common.empty') }}</p>
            } @else {
              <ul class="grid gap-2">
                @for (batch of batches(); track batch.batch_id) {
                  <li class="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span class="num">{{ formatDateTime(batch.imported_at) }}</span>
                      · {{ t('bankLog.table.rows') }} <span class="num">{{ batch.rows }}</span>
                      · {{ t('bankLog.batches.range') }}
                      <span class="num">{{ formatDateTime(batch.first_at) }} – {{ formatDateTime(batch.last_at) }}</span>
                    </span>
                    @if (canManage()) {
                      <button type="button" class="btn btn--danger btn--sm" [disabled]="saving()" (click)="batchToDelete.set(batch)">
                        {{ t('common.delete') }}
                      </button>
                    }
                  </li>
                }
              </ul>
            }
          </div>
        </details>
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
      <app-dialog [title]="t('bankLog.detail.title', { id: row.id })" size="xl" (closed)="closeDetail()">
        <div class="grid gap-4">
          <dl class="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="hint">{{ t('common.date') }}</dt>
              <dd class="num">{{ formatDateTime(row.occurred_at) }}</dd>
            </div>
            <div>
              <dt class="hint">{{ isWithdrawal(row) ? t('bankLog.detail.paidBy') : t('common.player') }}</dt>
              <dd>{{ row.player_name }}</dd>
            </div>
            <div>
              <dt class="hint">{{ t('bankLog.reason') }}</dt>
              <dd>{{ row.reason }}</dd>
            </div>
            <div>
              <dt class="hint">{{ t('common.amount') }}</dt>
              <dd class="num font-semibold" [class.bank-log__in]="isIncoming(row)" [class.bank-log__out]="!isIncoming(row)">
                {{ formatSigned(row.amount) }}
              </dd>
            </div>
            <div>
              <dt class="hint">{{ t('common.status') }}</dt>
              <dd>
                <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" [toneOverride]="statusTone(row.status)" />
              </dd>
            </div>
            <div>
              <dt class="hint">{{ t('bankLog.detail.batch') }}</dt>
              <dd class="num text-xs break-all">{{ row.batch_id }}</dd>
            </div>
          </dl>

          @if (row.occurrence > 1) {
            <p class="hint">{{ t('bankLog.detail.occurrence', { count: row.occurrence }) }}</p>
          }

          @if (canManage()) {
            <div class="grid gap-1">
              <span class="label">{{ t('common.category') }}</span>
              <app-select
                [options]="categoryOptions()"
                [value]="row.category"
                [ariaLabel]="t('common.category')"
                [disabled]="saving()"
                (valueChange)="setCategory(row, $event)"
              />
            </div>
          } @else {
            <p class="text-sm">{{ t('common.category') }}: {{ categoryLabel(row.category) }}</p>
          }

          <!-- Suggested links -->
          @if (suggestedLinks().length > 0) {
            <section class="grid gap-2" aria-labelledby="bank-log-suggestions-heading">
              <h3 id="bank-log-suggestions-heading" class="font-semibold">{{ t('bankLog.links.suggestions') }}</h3>
              @for (link of suggestedLinks(); track link.id) {
                <article class="bank-log__link">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="chip chip--neutral">{{ linkKindLabel(link.kind) }}</span>
                    <span class="num text-sm">
                      {{ t('bankLog.links.totals', { entries: formatAmount(link.entries_total), targets: formatAmount(linkTargetsTotal(link)) }) }}
                    </span>
                  </div>
                  <ul class="grid gap-1 text-sm">
                    @for (target of link.targets; track $index) {
                      <li>{{ targetLine(target) }}</li>
                    }
                  </ul>
                  @if (canManage()) {
                    <div class="flex flex-wrap justify-end gap-2">
                      <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="deleteLink(link, 'bankLog.links.rejectedToast')">
                        {{ t('bankLog.links.reject') }}
                      </button>
                      <button type="button" class="btn btn--primary btn--sm" [disabled]="saving()" (click)="confirmLink(link)">
                        {{ t('bankLog.links.confirm') }}
                      </button>
                    </div>
                  }
                </article>
              }
            </section>
          }

          <!-- Confirmed links -->
          @if (confirmedLinks().length > 0) {
            <section class="grid gap-2" aria-labelledby="bank-log-confirmed-heading">
              <h3 id="bank-log-confirmed-heading" class="font-semibold">{{ t('bankLog.links.confirmed') }}</h3>
              @for (link of confirmedLinks(); track link.id) {
                <article class="bank-log__link">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="chip chip--neutral">{{ linkKindLabel(link.kind) }}</span>
                    <span class="num text-sm">
                      {{ t('bankLog.links.totals', { entries: formatAmount(link.entries_total), targets: formatAmount(linkTargetsTotal(link)) }) }}
                    </span>
                  </div>
                  <ul class="grid gap-1 text-sm">
                    @for (target of link.targets; track $index) {
                      <li>{{ targetLine(target) }}</li>
                    }
                  </ul>
                  @if (canManage()) {
                    <div class="flex justify-end">
                      <button type="button" class="btn btn--danger btn--sm" [disabled]="saving()" (click)="deleteLink(link, 'bankLog.links.removedToast')">
                        {{ t('bankLog.links.remove') }}
                      </button>
                    </div>
                  }
                </article>
              }
            </section>
          }

          @if (suggestedLinks().length === 0 && confirmedLinks().length === 0) {
            <p class="hint">{{ t('bankLog.links.none') }}</p>
          }

          <!-- Manual link -->
          @if (canManage() && row.status !== 'explained') {
            <section class="grid gap-2" aria-labelledby="bank-log-manual-heading">
              <h3 id="bank-log-manual-heading" class="font-semibold">{{ t('bankLog.manual.title') }}</h3>
              <p class="hint">{{ t('bankLog.manual.hint') }}</p>
              @if (candidatesLoading()) {
                <p class="hint" role="status">{{ t('common.loading') }}</p>
              } @else if (candidates().length === 0) {
                <p class="hint">{{ t('bankLog.manual.empty') }}</p>
              } @else {
                <ul class="grid gap-1 text-sm">
                  @for (candidate of candidates(); track candidateKey(candidate)) {
                    <li>
                      <label class="flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          [disabled]="candidate.linked || saving()"
                          [checked]="isCandidateSelected(candidate)"
                          (change)="toggleCandidate(candidate, $event)"
                        />
                        <span>{{ candidate.label }}</span>
                        @if (candidate.member_username) {
                          <span class="hint">{{ candidate.member_username }}</span>
                        }
                        <span class="num">{{ formatAmount(candidateValue(candidate, detailKind())) }}</span>
                        @if (candidate.linked) {
                          <span class="hint">{{ t('bankLog.manual.alreadyLinked') }}</span>
                        }
                      </label>
                    </li>
                  }
                </ul>
                <p class="num text-sm" aria-live="polite">
                  {{ t('bankLog.manual.selectedTotal', { selected: formatAmount(selectedTotal()), expected: formatAmount(expectedAmount()) }) }}
                  @if (selectedCandidates().length > 0 && selectedDifference() !== 0) {
                    · {{ t('bankLog.manual.mismatch', { difference: formatSigned(selectedDifference()) }) }}
                  }
                </p>
                <div class="flex justify-end">
                  <button type="button" class="btn btn--primary btn--sm" [disabled]="saving() || selectedCandidates().length === 0" (click)="linkSelected()">
                    {{ t('bankLog.manual.submit') }}
                  </button>
                </div>
              }
            </section>
          }

          <!-- Explanation -->
          <section class="grid gap-2" aria-labelledby="bank-log-explain-heading">
            <h3 id="bank-log-explain-heading" class="font-semibold">{{ t('bankLog.explain.title') }}</h3>
            @if (row.status === 'explained') {
              <p class="text-sm">{{ row.note }}</p>
              @if (canManage()) {
                <div class="flex justify-end">
                  <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="undoExplanation(row)">
                    {{ t('bankLog.explain.undo') }}
                  </button>
                </div>
              }
            } @else if (canManage()) {
              <label class="grid gap-1">
                <span class="label">{{ t('bankLog.explain.note') }}</span>
                <textarea
                  class="textarea"
                  name="note"
                  rows="3"
                  [value]="explainNote()"
                  (input)="onExplainInput($event)"
                  aria-describedby="bank-log-explain-hint"
                ></textarea>
              </label>
              <p id="bank-log-explain-hint" class="hint">{{ t('bankLog.explain.required') }}</p>
              <div class="flex justify-end">
                <button type="button" class="btn btn--primary btn--sm" [disabled]="saving() || !explainNote().trim()" (click)="saveExplanation(row)">
                  {{ t('bankLog.explain.mark') }}
                </button>
              </div>
            }
          </section>

          <!-- Create transaction -->
          @if (row.created_transaction_id !== null) {
            <p class="hint" role="status">{{ t('bankLog.tx.created', { id: row.created_transaction_id }) }}</p>
          } @else if (canCreateTransaction()) {
            <section class="grid gap-2" aria-labelledby="bank-log-tx-heading">
              <h3 id="bank-log-tx-heading" class="font-semibold">{{ t('bankLog.tx.title') }}</h3>
              <p class="hint">{{ txHint(row) }}</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1">
                  <span class="label">{{ t('bankLog.tx.member') }}</span>
                  <app-searchable-select
                    [options]="memberOptions()"
                    [value]="memberValue()"
                    [remote]="true"
                    [emptyLabel]="t('bankLog.tx.member')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [ariaLabel]="t('bankLog.tx.member')"
                    (valueChange)="onMemberSelect($event)"
                    (searchChange)="onMemberSearch($event)"
                  />
                </div>
                <label class="grid gap-1">
                  <span class="label">{{ t('common.amount') }}</span>
                  <input
                    class="input num"
                    name="tx_amount"
                    type="number"
                    min="1"
                    step="1"
                    [value]="txAmount()"
                    (input)="onTxAmountInput($event)"
                    aria-describedby="bank-log-tx-hint"
                  />
                </label>
              </div>
              <div class="flex justify-end">
                <button type="button" class="btn btn--primary btn--sm" [disabled]="saving()" (click)="createTransaction(row)">
                  {{ t('bankLog.tx.submit') }}
                </button>
              </div>
            </section>
          }
        </div>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeDetail()">{{ t('common.close') }}</button>
        </div>
      </app-dialog>
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

  protected readonly canView = computed(() => this.auth.hasPermission('bank.log.view'));
  protected readonly canManage = computed(() => this.auth.hasPermission('bank.log.manage'));
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
  protected readonly batchesOpen = signal(false);
  protected readonly batchToDelete = signal<BankLogBatch | null>(null);

  protected readonly showImport = signal(false);
  protected readonly importText = signal('');

  protected readonly detail = signal<BankLogEntry | null>(null);
  protected readonly candidates = signal<BankLogCandidate[]>([]);
  protected readonly candidatesLoading = signal(false);
  protected readonly selectedCandidateKeys = signal<readonly string[]>([]);
  protected readonly explainNote = signal('');
  protected readonly txMember = signal<SearchableSelectOption | null>(null);
  protected readonly txAmount = signal('');
  protected readonly memberSearchResults = signal<SearchableSelectOption[]>([]);
  private memberSearchRequest = 0;

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly headerMenu = computed<MenuItem[]>(() => [
    { id: 'refresh', label: this.t('common.refreshNow'), disabled: this.summaryLoading() || this.entriesLoading() },
  ]);

  protected readonly trackEntry = (row: BankLogEntry): unknown => row.id;

  protected readonly importParse = computed(() => this.parseImport(this.importText()));
  protected readonly importReady = computed(
    () => !this.importParse().error && this.importParse().rows.length > 0,
  );

  /** Guild bank status: danger when rows are about to leave the game log, warning when the import is due. */
  protected readonly importTone = computed<ImportTone>(() => {
    const status = this.summary()?.import;
    if (!status) {
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

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const s = this.summary();
    if (!s) {
      return [];
    }
    const difference = Math.abs(numeric(s.game_payouts)) - Math.abs(numeric(s.manager_payouts));
    const differs = Math.abs(difference) >= 1;
    return [
      { label: this.t('bankLog.stat.gameIn'), value: this.formatAmount(s.game_in) },
      { label: this.t('bankLog.stat.gameOut'), value: this.formatAmount(s.game_out) },
      { label: this.t('bankLog.stat.gameNet'), value: this.formatSigned(s.game_net) },
      {
        label: this.t('bankLog.stat.payouts'),
        value: `${this.formatAmount(s.manager_payouts)} / ${this.formatAmount(s.game_payouts)}`,
      },
      differs
        ? {
            label: this.t('bankLog.stat.payoutDifference'),
            value: this.formatSigned(difference),
            hint: this.t('bankLog.stat.payoutDifferenceHint'),
            tone: 'danger',
          }
        : {
            label: this.t('bankLog.stat.payoutDifference'),
            value: this.t('bankLog.stat.payoutsMatch'),
            tone: 'success',
          },
      { label: this.t('bankLog.state.unmatched'), value: s.unmatched, tone: s.unmatched > 0 ? 'warning' : 'default' },
      { label: this.t('bankLog.state.suggested'), value: s.suggested },
      { label: this.t('bankLog.state.matched'), value: s.matched },
      { label: this.t('bankLog.state.explained'), value: s.explained },
    ];
  });

  protected readonly categoryOptions = computed<SelectOption[]>(() =>
    BANK_LOG_CATEGORIES.map((category) => ({ value: category, label: this.categoryLabel(category) })),
  );

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

  protected readonly suggestedLinks = computed(
    () => this.detail()?.links.filter((link) => !link.confirmed) ?? [],
  );
  protected readonly confirmedLinks = computed(
    () => this.detail()?.links.filter((link) => link.confirmed) ?? [],
  );

  /** Link kind a manual link gets for the open row: payout for withdrawals, bags/loot sale for deposits. */
  protected readonly detailKind = computed<BankLogLinkKind>(() => {
    const row = this.detail();
    return row ? this.linkKindFor(row) : 'manual';
  });
  protected readonly expectedAmount = computed(() => Math.abs(numeric(this.detail()?.amount)));
  protected readonly selectedCandidates = computed(() => {
    const keys = this.selectedCandidateKeys();
    return this.candidates().filter((candidate) => keys.includes(this.candidateKey(candidate)));
  });
  protected readonly selectedTotal = computed(() =>
    this.selectedCandidates().reduce(
      (sum, candidate) => sum + this.candidateValue(candidate, this.detailKind()),
      0,
    ),
  );
  protected readonly selectedDifference = computed(() => this.expectedAmount() - this.selectedTotal());

  protected readonly memberOptions = computed<SearchableSelectOption[]>(() => {
    const chosen = this.txMember();
    const results = this.memberSearchResults();
    if (chosen && !results.some((option) => option.id === chosen.id)) {
      return [chosen, ...results];
    }
    return results;
  });
  protected readonly memberValue = computed(() => this.txMember()?.id ?? '');

  constructor() {
    void this.reloadAll();
  }

  // ------------------------------------------------------------------ header and period

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    }
  }

  protected async refreshNow(): Promise<void> {
    await this.reloadAll();
    if (this.batchesOpen()) {
      await this.loadBatches();
    }
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
    await Promise.all([this.loadSummary(), this.loadEntries()]);
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

  protected onBatchesToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.batchesOpen.set(open);
    if (open) {
      void this.loadBatches();
    }
  }

  // ------------------------------------------------------------------ mutations

  /**
   * Runs one write, toasts the result, then reloads the summary, the table and (when a row is
   * open) that row. Returns whether the write succeeded so callers can close their dialogs.
   */
  private async mutate<T>(
    action: () => Promise<T>,
    toastFor: (result: T) => string,
    rowId: number | null,
  ): Promise<boolean> {
    this.saving.set(true);
    try {
      const result = await action();
      this.toasts.success(toastFor(result));
      await this.reloadAll();
      if (rowId !== null && this.detail()?.id === rowId) {
        await this.reloadDetail(rowId);
      }
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
      null,
    );
    if (ok) {
      this.importText.set('');
      this.showImport.set(false);
      if (this.batchesOpen()) {
        await this.loadBatches();
      }
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
      null,
    );
    if (ok && this.batchesOpen()) {
      await this.loadBatches();
    }
  }

  protected setCategory(row: BankLogEntry, category: string): void {
    if (category === row.category) {
      return;
    }
    void this.patchEntry(row, { category }, 'bankLog.categorySaved');
  }

  protected saveExplanation(row: BankLogEntry): void {
    const note = this.explainNote().trim();
    if (!note) {
      this.toasts.error(this.t('bankLog.explain.required'));
      return;
    }
    void this.patchEntry(row, { note, explained: true }, 'bankLog.explain.saved');
  }

  protected undoExplanation(row: BankLogEntry): void {
    void this.patchEntry(row, { explained: false }, 'bankLog.explain.undone');
  }

  private async patchEntry(
    row: BankLogEntry,
    body: Record<string, unknown>,
    message: TranslationKey,
  ): Promise<void> {
    await this.mutate(
      () => firstValueFrom(this.api.patch<BankLogEntry>(`api/bank/log/entries/${row.id}`, body)),
      () => this.t(message),
      row.id,
    );
  }

  protected async confirmLink(link: BankLogLink): Promise<void> {
    const row = this.detail();
    if (!row) {
      return;
    }
    await this.mutate(
      () => firstValueFrom(this.api.post<BankLogLink>(`api/bank/log/links/${link.id}/confirm`, {})),
      () => this.t('bankLog.links.confirmedToast'),
      row.id,
    );
  }

  /** Rejects a suggestion or removes a confirmed link: the backend uses the same DELETE for both. */
  protected async deleteLink(link: BankLogLink, message: TranslationKey): Promise<void> {
    const row = this.detail();
    if (!row) {
      return;
    }
    await this.mutate(
      () => firstValueFrom(this.api.delete(`api/bank/log/links/${link.id}`)),
      () => this.t(message),
      row.id,
    );
  }

  protected async linkSelected(): Promise<void> {
    const row = this.detail();
    const selected = this.selectedCandidates();
    if (!row) {
      return;
    }
    if (selected.length === 0) {
      this.toasts.error(this.t('bankLog.manual.pickOne'));
      return;
    }
    const body = {
      entry_ids: [row.id],
      transaction_ids: selected.flatMap((candidate) =>
        candidate.transaction_id === null ? [] : [candidate.transaction_id],
      ),
      split_ids: selected.flatMap((candidate) => (candidate.split_id === null ? [] : [candidate.split_id])),
      kind: this.linkKindFor(row),
    };
    const ok = await this.mutate(
      () => firstValueFrom(this.api.post<BankLogLink>('api/bank/log/links', body)),
      () => this.t('bankLog.manual.linkedToast'),
      row.id,
    );
    if (ok) {
      this.selectedCandidateKeys.set([]);
    }
  }

  protected async createTransaction(row: BankLogEntry): Promise<void> {
    const member = this.txMember();
    if (!member) {
      this.toasts.error(this.t('bankLog.tx.memberRequired'));
      return;
    }
    const amount = Number(this.txAmount());
    if (!Number.isFinite(amount) || amount <= 0) {
      this.toasts.error(this.t('siphoned.amountInvalid'));
      return;
    }
    await this.mutate(
      () =>
        firstValueFrom(
          this.api.post<BankLogEntry>(`api/bank/log/entries/${row.id}/transaction`, {
            to_user_id: Number(member.id),
            amount,
          }),
        ),
      (entry) => this.t('bankLog.tx.created', { id: entry.created_transaction_id ?? '' }),
      row.id,
    );
  }

  // ------------------------------------------------------------------ detail panel

  protected openEntry(row: BankLogEntry): void {
    this.detail.set(row);
    this.explainNote.set(row.note ?? '');
    this.selectedCandidateKeys.set([]);
    this.candidates.set([]);
    this.txMember.set(null);
    this.memberSearchResults.set([]);
    this.txAmount.set(String(Math.abs(numeric(row.amount))));
    void this.reloadDetail(row.id);
  }

  protected closeDetail(): void {
    this.detail.set(null);
    this.candidates.set([]);
    this.selectedCandidateKeys.set([]);
  }

  private async reloadDetail(id: number): Promise<void> {
    try {
      const row = await firstValueFrom(this.api.get<BankLogEntry>(`api/bank/log/entries/${id}`));
      if (this.detail()?.id === id) {
        this.detail.set(row);
      }
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      return;
    }
    if (this.canManage() && this.detail()?.id === id) {
      await this.loadCandidates(id);
    }
  }

  private async loadCandidates(id: number): Promise<void> {
    this.candidatesLoading.set(true);
    try {
      const list = await firstValueFrom(
        this.api.get<BankLogCandidate[]>(`api/bank/log/entries/${id}/candidates`),
      );
      if (this.detail()?.id === id) {
        this.candidates.set(list);
      }
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.candidatesLoading.set(false);
    }
  }

  protected toggleCandidate(candidate: BankLogCandidate, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const key = this.candidateKey(candidate);
    this.selectedCandidateKeys.update((keys) => {
      const without = keys.filter((current) => current !== key);
      return checked ? [...without, key] : without;
    });
  }

  protected isCandidateSelected(candidate: BankLogCandidate): boolean {
    return this.selectedCandidateKeys().includes(this.candidateKey(candidate));
  }

  protected candidateKey(candidate: BankLogCandidate): string {
    return candidate.kind === 'transaction'
      ? `t:${candidate.transaction_id}`
      : `s:${candidate.split_id}`;
  }

  /** The figure a candidate is compared with for a given link kind. */
  protected candidateValue(candidate: BankLogCandidate, kind: BankLogLinkKind): number {
    switch (kind) {
      case 'payout':
        return numeric(candidate.amount);
      case 'bags':
        return numeric(candidate.split_bags_value ?? candidate.amount);
      case 'loot_sale':
        return numeric(candidate.split_expected_sale ?? candidate.amount);
      case 'manual':
        return numeric(candidate.amount ?? candidate.split_expected_sale ?? candidate.split_bags_value);
    }
  }

  protected onExplainInput(event: Event): void {
    this.explainNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected onTxAmountInput(event: Event): void {
    this.txAmount.set((event.target as HTMLInputElement).value);
  }

  protected onMemberSelect(id: string): void {
    this.txMember.set(this.memberOptions().find((option) => option.id === id) ?? null);
  }

  protected async onMemberSearch(query: string): Promise<void> {
    const request = ++this.memberSearchRequest;
    const term = query.trim();
    if (!term) {
      this.memberSearchResults.set([]);
      return;
    }
    try {
      // Transactions take local user ids, so search app members (not the Albion roster).
      const page = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', { username: term, limit: 25 }),
      );
      if (request === this.memberSearchRequest) {
        this.memberSearchResults.set(
          page.items.map((member) => ({ id: String(member.id), label: member.username })),
        );
      }
    } catch {
      if (request === this.memberSearchRequest) {
        this.toasts.error(this.t('common.error'));
      }
    }
  }

  protected linkTargetsTotal(link: BankLogLink): number {
    return link.targets.reduce((sum, target) => sum + numeric(target.amount), 0);
  }

  protected targetLine(target: BankLogLinkTarget): string {
    const parts = [
      target.label,
      target.member_username ?? '',
      target.amount === null ? '' : this.formatAmount(target.amount),
      target.at ? this.formatDateTime(target.at) : '',
    ];
    return parts.filter((part) => part !== '').join(' · ');
  }

  protected txHint(row: BankLogEntry): string {
    return this.isWithdrawal(row) ? this.t('bankLog.tx.withdrawalHint') : this.t('bankLog.tx.donationHint');
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

  private linkKindFor(row: BankLogEntry): BankLogLinkKind {
    if (this.isWithdrawal(row) || row.category === 'payout') {
      return 'payout';
    }
    if (row.category === 'bags') {
      return 'bags';
    }
    if (row.category === 'loot_sale') {
      return 'loot_sale';
    }
    return 'manual';
  }

  protected isWithdrawal(row: BankLogEntry): boolean {
    return numeric(row.amount) < 0;
  }

  protected isIncoming(row: BankLogEntry): boolean {
    return numeric(row.amount) >= 0;
  }

  protected linkKindLabel(kind: BankLogLinkKind): string {
    return this.t(LINK_KIND_KEYS[kind]);
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

  protected formatSigned(value: number | string | null | undefined): string {
    return new Intl.NumberFormat(this.translate.locale(), {
      maximumFractionDigits: 0,
      signDisplay: 'exceptZero',
    }).format(numeric(value));
  }

  /** Shows the time in UTC, the timezone the game log is written in. */
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
