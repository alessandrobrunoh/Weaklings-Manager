import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompleteSplitsBatchResult,
  CreateSplitRequest,
  DiscordUserProfile,
  EventView,
  MatchedParticipant,
  OcrResult,
  PaginatedData,
  SplitDetail,
  SplitIsland,
  SplitIslandCity,
  SplitKpiSummary,
  SplitStatus,
  SplitSummary,
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
  type SortState,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { DataTableFooterCell } from '../../shared/components/data-table/data-table-footer-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { actionablePendingSplits, canActOnSplit } from './split-access';

const SORT_WHITELIST = new Set(['created_at', 'status', 'note']);
const DEFAULT_SPLIT_FEE = 20;
const DEFAULT_PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;
const STATUS_ORDER: readonly SplitStatus[] = [
  'pending',
  'awaiting_event',
  'completed',
  'not_completed',
  'lost',
];
const NO_MENU_ITEMS: readonly MenuItem[] = [];

function parsePercentageInput(raw: string): number | null {
  const normalized = raw.trim().replace(/%\s*$/, '').replace(',', '.');
  if (!normalized || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function sameSort(a: SortState | null, b: SortState | null): boolean {
  return (a?.columnKey ?? '') === (b?.columnKey ?? '') && (a?.direction ?? '') === (b?.direction ?? '');
}

interface SplitParticipantDraft {
  readonly raw_name: string;
  readonly user_id: number;
  readonly username: string;
  weight: number;
}

interface SplitBagDraft {
  readonly key: number;
  amount: number;
}

let nextSplitBagKey = 1;

function newSplitBag(amount = 0): SplitBagDraft {
  return { key: nextSplitBagKey++, amount };
}

/**
 * Loot-split index: a summary band, status tabs, a filter bar and a server-paged table.
 *
 * The page owns search, status, island and archived state; the URL carries it (`q`, `status`,
 * `island`, `archived`) and the table carries page, size and sort. Rows open the split detail.
 * Create lives in an `app-dialog`. Island catalog management belongs to admin.
 */
@Component({
  selector: 'app-splits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    DataTableFooterCell,
    Dialog,
    EmptyState,
    FilterBar,
    Icon,
    Menu,
    PageHeader,
    PageStack,
    RouterLink,
    SearchDialog,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    :host {
      display: block;
      width: 100%;
    }
    .workbench-page {
      min-width: 0;
      overflow: hidden;
    }
    .workbench-page > section,
    .workbench-page > app-data-table {
      min-width: 0;
    }

    .batch-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .batch-bar--active {
      border-color: var(--color-primary);
    }
    .batch-bar__main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.875rem;
      min-width: 0;
      font-size: var(--ui-text-sm);
    }
    .batch-bar__all {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 500;
      cursor: pointer;
    }
    .batch-bar__count {
      font-weight: 600;
    }
    .batch-bar__sum {
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
    }
    .batch-bar__actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-inline-start: auto;
    }
    .batch-bar__note {
      display: flex;
      flex-basis: 100%;
      align-items: center;
      gap: 0.375rem;
      margin: 0;
      color: var(--color-warning);
      font-size: var(--ui-text-xs);
    }

    .split-name {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      min-width: 0;
    }
    .split-name__check {
      margin-top: 0.1875rem;
    }
    .split-name__body {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
    }
    .split-name__title {
      overflow-wrap: anywhere;
      font-weight: 600;
      color: var(--color-text);
    }
    .split-name__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.5rem;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
    }
    .split-name__event {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      color: var(--color-primary);
      text-decoration: none;
    }
    .split-name__event:hover {
      text-decoration: underline;
    }
    .split-name__tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    .split-sub {
      display: block;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
    }
  `,
  template: `
    <app-page-header
      [title]="t('splits.title')"
      [subtitle]="t('splits.subtitle')"
      [menuItems]="headerMenuItems()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onHeaderMenu($event)"
    >
      @if (canCreate()) {
        <button
          type="button"
          class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
          (click)="openCreateDialog()"
        >
          <app-icon name="plus" size="0.875rem" />
          <span>{{ t('splits.new') }}</span>
        </button>
      }
    </app-page-header>

    <app-page-stack class="workbench-page">
      <app-summary-band [ariaLabel]="t('splits.kpi.label')" [items]="summaryItems()" />

      @if (actionablePendingSplits().length > 0) {
        <section
          class="batch-bar"
          [class.batch-bar--active]="selectedCount() > 0"
          [attr.aria-label]="t('splits.batch.selected', { count: selectedCount() })"
        >
          <div class="batch-bar__main">
            <label class="batch-bar__all">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="allPendingSelected()"
                (change)="toggleAllPending($event)"
              />
              <span>{{ t('splits.batch.select') }}</span>
            </label>

            @if (selectedCount() > 0) {
              <span class="batch-bar__count">{{ t('splits.batch.selected', { count: selectedCount() }) }}</span>
              <span class="batch-bar__sum">
                {{ t('splits.batch.totalNetPayout') }}:
                <strong class="num">{{ formatAmount(selectedTotalNet()) }}</strong>
                &middot; {{ selectedTotalParticipants() }} {{ t('splits.participants') }}
              </span>
            }
          </div>

          <div class="batch-bar__actions">
            @if (selectedCount() > 0) {
              <button type="button" class="btn btn--ghost btn--sm" (click)="clearSelection()">
                {{ t('common.clear') }}
              </button>
            }
            <button
              type="button"
              class="btn btn--tonal btn--sm inline-flex items-center gap-1.5"
              [disabled]="selectedCount() === 0 || batchRunning()"
              (click)="completeSelected()"
            >
              <app-icon name="check" size="0.875rem" />
              <span>{{ t('splits.batch.complete') }}</span>
              @if (selectedCount() > 0) {
                <span class="num">({{ selectedCount() }})</span>
              }
            </button>
          </div>

          @if (awaitingEventSplits().length > 0) {
            <p class="batch-bar__note">
              <app-icon name="alert" size="0.875rem" class="shrink-0" />
              <span>{{ t('splits.awaiting_event.message') }}</span>
            </p>
          }
        </section>
      }

      <app-tabs
        [options]="statusTabs()"
        [active]="activeStatusTab()"
        [ariaLabel]="t('splits.list.statusTabs')"
        (activeChange)="onStatusTab($event)"
      />

      <app-filter-bar
        [searchLabel]="t('common.search')"
        [searchPlaceholder]="t('splits.search_splits')"
        [query]="searchInput()"
        [activeCount]="activeFilterCount()"
        (queryChange)="onSearchInput($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('splits.island') }}</span>
          <select class="select select--sm" [value]="islandFilter()" (change)="onIslandChange($event)">
            <option value="">{{ t('splits.all_islands') }}</option>
            @for (island of islands(); track island.id) {
              <option [value]="island.id">{{ cityLabel(island.city) }} &middot; {{ island.name }}</option>
            }
          </select>
        </label>
        @if (canDelete()) {
          <label class="filter-check">
            <input
              class="checkbox"
              type="checkbox"
              [checked]="showArchived()"
              (change)="onArchivedChange($event)"
            />
            <span>{{ t('splits.showArchived') }}</span>
          </label>
        }
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="splits()"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [pageSize]="pageSize()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [rowClickable]="true"
        (rowClick)="openSplit($event)"
        (pageChange)="onPageChange($event)"
        [hideSearch]="true"
        [stickyFirstColumn]="true"
        [ariaLabel]="t('nav.splits')"
        [itemLabel]="t('nav.splits')"
        [footerLabel]="t('splits.list.pageTotal')"
        emptyIcon="swords"
        [emptyTitle]="t('splits.list.emptyTitle')"
        [emptySubtitle]="filtersActive() ? t('splits.list.emptyFiltered') : t('splits.list.emptyNone')"
      >
        <ng-template dataTableCell="note" let-row>
          <div class="split-name">
            @if (canActOn(row) && row.status === 'pending' && !row.archived_at) {
              <input
                class="checkbox split-name__check"
                type="checkbox"
                [checked]="isSelected(row.id)"
                (change)="toggleSelected(row.id, $event)"
                [attr.aria-label]="t('splits.batch.selectOne')"
              />
            }
            <span class="split-name__body">
              <span class="split-name__title">{{ row.note || t('splits.untitled', { id: row.id }) }}</span>
              <span class="split-name__meta">
                @if (row.event_id && row.event_title) {
                  <a
                    class="split-name__event"
                    [routerLink]="['/events', row.event_id]"
                    (click)="$event.stopPropagation()"
                  >
                    <app-icon name="swords" size="0.75rem" />
                    <span>{{ row.event_title }}</span>
                  </a>
                } @else {
                  <span>{{ t('splits.no_event') }}</span>
                }
              </span>
              @if (row.origin_read_only || row.archived_at) {
                <span class="split-name__tags">
                  @if (row.origin_read_only) {
                    <span class="chip chip--neutral">{{ t('splits.readOnlyCopy') }}</span>
                  }
                  @if (row.archived_at) {
                    <span class="chip chip--neutral">{{ t('splits.archived') }}</span>
                  }
                </span>
              }
            </span>
          </div>
        </ng-template>

        <ng-template dataTableCell="created_at" let-row>
          <span class="text-sm">{{ formatDate(row.created_at) }}</span>
        </ng-template>

        <ng-template dataTableCell="net" let-row>
          <span class="num font-semibold">{{ formatAmount(netOf(row)) }}</span>
        </ng-template>

        <ng-template dataTableCell="perMember" let-row>
          <span class="num">{{ perMemberText(row) }}</span>
          <span class="split-sub">{{ t('splits.list.membersCount', { count: row.participant_count }) }}</span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          <app-status-chip
            [value]="row.status"
            [label]="statusLabel(row.status)"
            [toneOverride]="statusTone(row.status)"
          />
        </ng-template>

        <ng-template dataTableCell="created_by" let-row>
          <span class="text-sm">{{ row.created_by_username }}</span>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <app-menu
            appearance="ghost"
            align="end"
            [items]="rowMenus().get(row.id) ?? noMenuItems"
            [label]="t('splits.list.rowMenu')"
            (itemSelect)="onRowMenu($event, row)"
          />
        </ng-template>

        <ng-template dataTableFooterCell="net">
          <span class="num font-semibold">{{ formatAmount(pageNetTotal()) }}</span>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    <!-- NEW SPLIT DIALOG -->
    @if (showCreateForm()) {
      <app-dialog [title]="t('splits.new')" size="lg" (closed)="closeCreateDialog()">
        <form id="create-split-form" class="space-y-4" (submit)="onCreateSubmit($event)">
          <p class="hint -mt-2">{{ t('splits.create_hint') }}</p>

          <div class="grid gap-3 lg:grid-cols-2">
            <!-- LEFT COLUMN: NOTE, LOCATION, AMOUNTS -->
            <div class="space-y-4">
              <section class="card p-3 space-y-2.5">
                <h3 class="section-title">{{ t('splits.create.sectionDetails') }}</h3>

                <label class="block">
                  <span class="label">{{ t('common.name') }} / {{ t('splits.note') }} *</span>
                  <input
                    class="input text-xs"
                    type="text"
                    [placeholder]="t('splits.create.namePlaceholder')"
                    [value]="draftTitle()"
                    (input)="onTitleChange($event)"
                    required
                  />
                </label>

                <div>
                  <span class="label">{{ t('splits.event_linked') }}</span>
                  <div class="flex items-center gap-2">
                    <div class="input flex flex-1 items-center bg-[var(--color-surface-1)] text-xs truncate">
                      <span class="truncate">{{ draftEventTitle() || t('splits.no_event') }}</span>
                    </div>
                    <button
                      type="button"
                      class="btn btn--outline btn--sm whitespace-nowrap"
                      (click)="showEventSearch.set(true)"
                    >
                      {{ t('splits.link_event') }}
                    </button>
                    @if (draftEventId()) {
                      <button
                        type="button"
                        class="btn btn--danger btn--sm whitespace-nowrap"
                        [attr.aria-label]="t('splits.unlink_event')"
                        (click)="unlinkDraftEvent()"
                      >
                        <app-icon name="close" size="0.875rem" />
                      </button>
                    }
                  </div>
                </div>

                <div class="grid gap-2 sm:grid-cols-2">
                  <label class="block">
                    <span class="label">{{ t('splits.island') }} *</span>
                    <select class="select text-xs" [value]="draftIslandId()" (change)="onDraftIslandChange($event)">
                      <option value="">{{ t('splits.pick_island') }}</option>
                      @for (island of islands(); track island.id) {
                        <option [value]="island.id">
                          {{ cityLabel(island.city) }} &middot; {{ island.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <label class="block">
                    <span class="label">{{ t('splits.tab') }} *</span>
                    <select
                      class="select text-xs"
                      [value]="draftTabId()"
                      [disabled]="!draftIslandId()"
                      (change)="onDraftTabChange($event)"
                    >
                      <option value="">{{ t('splits.pick_tab') }}</option>
                      @for (tab of draftIslandTabs(); track tab.id) {
                        <option [value]="tab.id">{{ tab.name }}</option>
                      }
                    </select>
                  </label>
                </div>
                @if (islands().length === 0) {
                  <p class="hint text-[var(--color-warning)]">{{ t('splits.catalog.empty') }}</p>
                }
              </section>

              <section class="card p-3 space-y-2.5">
                <h3 class="section-title">{{ t('splits.create.sectionAmounts') }}</h3>

                <div class="grid gap-2 sm:grid-cols-3">
                  <label class="block">
                    <span class="label">{{ t('splits.estimated') }}</span>
                    <input
                      class="input font-mono text-xs"
                      type="number"
                      min="0"
                      [value]="draftEstimated()"
                      (input)="onEstimatedChange($event)"
                    />
                  </label>
                  <label class="block">
                    <span class="label">{{ t('splits.fee') }}</span>
                    <div class="flex items-center gap-1">
                      <input
                        class="input font-mono text-xs"
                        type="text"
                        inputmode="decimal"
                        [value]="draftFeeInput()"
                        [attr.aria-invalid]="!draftFeeValid()"
                        [attr.aria-describedby]="!draftFeeValid() ? 'split-fee-error' : null"
                        (input)="onFeeChange($event)"
                      />
                      <span class="hint font-mono">%</span>
                    </div>
                    @if (!draftFeeValid()) {
                      <span id="split-fee-error" class="mt-1 block text-xs text-error" role="alert">
                        {{ t('splits.fee_invalid') }}
                      </span>
                    }
                  </label>
                  <label class="block">
                    <span class="label">{{ t('splits.repair_cost') }} (-)</span>
                    <input
                      class="input font-mono text-xs"
                      type="number"
                      min="0"
                      [value]="draftRepair()"
                      (input)="onRepairChange($event)"
                    />
                  </label>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <span class="label">{{ t('splits.bags_value') }} (+)</span>
                    <button type="button" class="btn btn--outline btn--sm" (click)="addBag()">
                      {{ t('splits.add_bag') }}
                    </button>
                  </div>
                  @for (bag of draftBagRows(); track bag.key) {
                    <div class="flex items-center gap-2">
                      <input
                        class="input font-mono text-xs"
                        type="number"
                        min="0"
                        [value]="bag.amount"
                        [attr.aria-label]="t('splits.bags_value')"
                        (input)="onBagAmountChange(bag.key, $event)"
                      />
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm inline-flex cursor-pointer"
                        [attr.aria-label]="t('splits.remove_bag')"
                        (click)="removeBag(bag.key)"
                      >
                        <app-icon name="close" size="0.875rem" />
                      </button>
                    </div>
                  } @empty {
                    <p class="hint">{{ t('splits.bags_empty') }}</p>
                  }
                  @if (draftBags() > 0) {
                    <p class="hint font-mono">{{ t('splits.bags_total') }} +{{ formatAmount(draftBags()) }}</p>
                  }
                </div>

                <div class="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <span class="label">{{ t('splits.net_value') }} ({{ t('splits.net_preview') }})</span>
                    <p class="hint">
                      {{ t('splits.estimated') }} − {{ t('splits.repair_cost') }} + {{ t('splits.bags_value') }}
                      − {{ t('splits.fee') }} ({{ formatAmount(draftFeeAmount()) }})
                    </p>
                    @if (participants().length > 0 && draftFeeValid()) {
                      <p class="hint font-mono">
                        {{ t('splits.create.perPlayer', { amount: formatAmount(perParticipantShare()) }) }}
                      </p>
                    }
                  </div>
                  <div class="text-right">
                    <span class="num text-xl font-semibold text-[var(--color-success)]">
                      {{ draftFeeValid() ? formatAmount(draftNetPreview()) : '—' }}
                    </span>
                    <span class="hint block">{{ t('splits.create.silver') }}</span>
                  </div>
                </div>
              </section>
            </div>

            <!-- RIGHT COLUMN: ROSTER -->
            <div class="space-y-4">
              <section class="card p-3 space-y-2.5">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="section-title">{{ t('splits.create.sectionRoster') }}</h3>
                  <button type="button" class="btn btn--ghost btn--sm" (click)="clearParticipants()">
                    {{ t('splits.clear_roster') }}
                  </button>
                </div>

                <button
                  type="button"
                  class="w-full rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-center hover:border-[var(--color-primary)]"
                  (click)="fileInput.click()"
                >
                  <input
                    #fileInput
                    class="hidden"
                    type="file"
                    accept="image/*"
                    (change)="onScreenshotChange($event)"
                  />
                  <span class="block text-xs font-medium text-[var(--color-text)]">{{ t('splits.match_ocr') }}</span>
                  <span class="hint block">{{ t('splits.create.screenshotHint') }}</span>
                </button>

                <label class="block">
                  <span class="label">{{ t('splits.ocr_names') }}</span>
                  <textarea
                    class="textarea font-mono text-xs"
                    rows="2"
                    [placeholder]="t('splits.create.rosterPlaceholder')"
                    [value]="rawNames()"
                    (input)="onRawNamesChange($event)"
                  ></textarea>
                </label>

                <button
                  type="button"
                  class="btn btn--tonal btn--sm w-full"
                  [disabled]="matching() || !rawNames().trim()"
                  (click)="matchParticipants()"
                >
                  {{ matching() ? t('common.loading') : t('splits.match_ocr') }}
                </button>
              </section>

              <section class="card p-3 space-y-2.5">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="section-title">{{ t('splits.participants') }} ({{ participants().length }})</h3>
                  <div class="flex items-center gap-1.5">
                    @if (participants().length > 0) {
                      <button type="button" class="btn btn--outline btn--sm" (click)="distributeDraftWeightsEvenly()">
                        {{ t('splits.distribute_evenly') }}
                      </button>
                    }
                    <button type="button" class="btn btn--outline btn--sm" (click)="showParticipantSearch.set(true)">
                      {{ t('splits.add_participant') }}
                    </button>
                  </div>
                </div>

                @if (participants().length === 0) {
                  <div class="py-6">
                    <app-empty-state [message]="t('splits.roster_empty')" icon="users" />
                  </div>
                } @else {
                  <div class="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                    @for (participant of participants(); track participant.user_id) {
                      <div class="flex items-center justify-between gap-2 p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]">
                        <div class="min-w-0">
                          <p class="truncate text-xs font-medium text-[var(--color-text)]">{{ participant.raw_name }}</p>
                          <p class="truncate text-xs text-[var(--color-text-secondary)]">
                            {{ participant.username }}
                            @if (draftFeeValid()) {
                              &middot;
                              <span class="num text-[var(--color-success)]">
                                ~{{ formatAmount(estimatedShare(draftNetPreview(), participant.weight, totalWeight())) }}
                              </span>
                            }
                          </p>
                        </div>

                        <div class="flex items-center gap-2 flex-shrink-0">
                          <div class="flex items-center gap-1">
                            <input
                              class="input font-mono text-xs text-right py-0.5 px-1 w-14"
                              type="number"
                              min="0.01"
                              step="0.01"
                              [value]="participant.weight"
                              [attr.aria-label]="t('splits.detail.weightLabel', { name: participant.raw_name })"
                              (input)="onWeightChange(participant.user_id, $event)"
                            />
                            <span class="hint font-mono">%</span>
                          </div>
                          <button
                            type="button"
                            class="btn btn--ghost btn--sm p-1 text-[var(--color-danger)]"
                            (click)="removeParticipant(participant.user_id)"
                            [attr.aria-label]="t('splits.remove_participant')"
                          >
                            &times;
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                }
              </section>
            </div>
          </div>
        </form>

        <div dialogFooter class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeCreateDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            form="create-split-form"
            class="btn btn--primary btn--sm"
            [disabled]="
              saving() ||
              participants().length === 0 ||
              !draftTitle().trim() ||
              !draftTabId() ||
              !draftFeeValid() ||
              !draftWeightsAreValid()
            "
          >
            {{ saving() ? t('common.loading') : t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (archiveTarget(); as split) {
      <app-dialog [title]="t('splits.archive')" size="sm" (closed)="archiveTarget.set(null)">
        <p>{{ t('splits.confirm_delete') }}</p>
        <p class="mt-2 font-medium">{{ split.note || t('splits.untitled', { id: split.id }) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="archiveTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--tonal" [disabled]="saving()" (click)="confirmArchive()">
            {{ t('splits.archive') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (showBatchConfirmDialog()) {
      <app-dialog
        [title]="t('splits.batch.confirmTitle')"
        [subtitle]="t('splits.batch.confirmSubtitle')"
        size="lg"
        (closed)="showBatchConfirmDialog.set(false)"
      >
        <div class="space-y-4">
          <app-summary-band [ariaLabel]="t('splits.batch.splitsList')" [items]="batchSummaryItems()" />

          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t('common.name') }}</th>
                  <th scope="col" class="text-right">{{ t('splits.net_value') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (split of selectedSplits(); track split.id) {
                  <tr>
                    <td>
                      <span class="font-medium">{{ split.note || t('splits.untitled', { id: split.id }) }}</span>
                      <span class="split-sub">
                        {{ locationLabel(split) }} &middot; {{ split.participant_count }} {{ t('splits.participants') }}
                      </span>
                    </td>
                    <td class="text-right num">{{ formatAmount(netOf(split)) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <p class="hint">{{ t('splits.batch.confirmWarning') }}</p>
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="showBatchConfirmDialog.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary inline-flex items-center gap-2"
            [disabled]="batchRunning() || selectedSplits().length === 0"
            (click)="runBatchComplete()"
          >
            <app-icon name="check" size="1rem" />
            <span>
              {{ batchRunning() ? t('common.loading') : t('splits.batch.acceptAndPay') }}
              ({{ selectedSplits().length }})
            </span>
          </button>
        </div>
      </app-dialog>
    }

    @if (showEventSearch()) {
      <app-search-dialog
        [title]="t('splits.link_event')"
        [options]="eventSearchOptions()"
        [loading]="eventSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onEventSearchFilter($event)"
        (select)="onDraftEventSelect($event)"
        (close)="showEventSearch.set(false)"
      />
    }

    @if (showParticipantSearch()) {
      <app-search-dialog
        [title]="t('splits.add_participant')"
        [placeholder]="t('splits.search_users')"
        [options]="participantSearchOptions()"
        [loading]="searchingRoster()"
        (filterChange)="onParticipantSearchFilter($event)"
        (select)="onParticipantSelect($event)"
        (close)="showParticipantSearch.set(false)"
      />
    }
  `,
})
export class Splits {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly noMenuItems = NO_MENU_ITEMS;

  private readonly initialQuery = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
  });
  private readonly initialParams = this.route.snapshot.queryParamMap;

  protected readonly splits = signal<SplitSummary[]>([]);
  protected readonly kpi = signal<SplitKpiSummary | null>(null);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly page = signal(this.initialQuery.page);
  protected readonly pageSize = signal(this.initialQuery.pageSize);
  protected readonly sort = signal<SortState | null>(this.initialQuery.sort);

  /** Filter state owned by the page. `searchInput` is what the officer typed; `searchQuery` is applied. */
  protected readonly searchInput = signal(this.initialParams.get('q') ?? '');
  protected readonly searchQuery = signal(this.initialParams.get('q') ?? '');
  protected readonly statusFilter = signal<SplitStatus | ''>(
    isSplitStatus(this.initialParams.get('status') ?? '')
      ? (this.initialParams.get('status') as SplitStatus)
      : '',
  );
  protected readonly islandFilter = signal(this.initialParams.get('island') ?? '');
  protected readonly showArchived = signal(this.initialParams.get('archived') === 'true');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private loadRequest = 0;

  private readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly batchRunning = signal(false);
  protected readonly showBatchConfirmDialog = signal(false);
  protected readonly archiveTarget = signal<SplitSummary | null>(null);

  protected readonly showCreateForm = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftEventId = signal('');
  protected readonly draftEventTitle = signal('');
  protected readonly draftEstimated = signal(0);
  protected readonly draftFeeInput = signal('');
  private feeEdited = false;
  protected readonly draftRepair = signal(0);
  protected readonly draftBagRows = signal<SplitBagDraft[]>([]);
  protected readonly draftBags = computed(() =>
    this.draftBagRows().reduce((sum, bag) => sum + (Number(bag.amount) || 0), 0),
  );
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  protected readonly rawNames = signal('');
  protected readonly participants = signal<SplitParticipantDraft[]>([]);
  protected readonly weightsCustomized = signal(false);
  protected readonly saving = signal(false);
  protected readonly matching = signal(false);

  protected readonly showParticipantSearch = signal(false);
  protected readonly participantSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly searchingRoster = signal(false);
  private participantSearchRequest = 0;

  protected readonly showEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);
  private eventSearchRequest = 0;

  protected readonly trackById = (row: SplitSummary): number => row.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly actionablePendingSplits = computed(() =>
    actionablePendingSplits(
      this.splits(),
      this.auth.profile()?.user_id,
      this.auth.hasPermission('splits.edit'),
      this.isAllianceTenant(),
    ),
  );
  protected readonly awaitingEventSplits = computed(() =>
    this.splits().filter((split) => isSplitAwaitingEvent(split.status)),
  );
  protected readonly selectedSplits = computed(() =>
    this.splits().filter(
      (split) =>
        split.status === 'pending' &&
        !split.archived_at &&
        this.canActOn(split) &&
        this.selectedIds().has(split.id),
    ),
  );
  protected readonly selectedCount = computed(() => this.selectedSplits().length);
  protected readonly selectedTotalNet = computed(() =>
    this.selectedSplits().reduce((sum, split) => sum + this.netOf(split), 0),
  );
  protected readonly selectedTotalParticipants = computed(() =>
    this.selectedSplits().reduce((sum, split) => sum + split.participant_count, 0),
  );
  protected readonly allPendingSelected = computed(() => {
    const pending = this.actionablePendingSplits();
    return pending.length > 0 && pending.every((split) => this.selectedIds().has(split.id));
  });
  protected readonly pageNetTotal = computed(() =>
    this.splits().reduce((sum, split) => sum + this.netOf(split), 0),
  );

  protected readonly draftFee = computed(() => parsePercentageInput(this.draftFeeInput()) ?? 0);
  protected readonly draftFeeAmount = computed(
    () =>
      (Math.max(0, this.draftEstimated() - this.draftRepair() + this.draftBags()) * this.draftFee()) /
      100,
  );
  protected readonly draftFeeValid = computed(() => {
    const fee = parsePercentageInput(this.draftFeeInput());
    return fee !== null && fee >= 0 && fee <= 100;
  });
  protected readonly draftNetPreview = computed(() =>
    Math.max(
      0,
      (this.draftEstimated() - this.draftRepair() + this.draftBags()) * (1 - this.draftFee() / 100),
    ),
  );
  protected readonly perParticipantShare = computed(() => {
    const count = this.participants().length;
    if (count === 0) return 0;
    return Math.round(this.draftNetPreview() / count);
  });
  protected readonly draftIslandTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });
  protected readonly isAllianceTenant = computed(
    () => this.auth.profile()?.tenant_kind === 'alliance',
  );
  protected canActOn(split: SplitSummary): boolean {
    return (
      !this.isAllianceTenant() &&
      !split.origin_read_only &&
      canActOnSplit(split, this.auth.profile()?.user_id, this.auth.hasPermission('splits.edit'))
    );
  }
  protected readonly canDelete = computed(
    () => this.auth.hasPermission('splits.delete') && !this.isAllianceTenant(),
  );
  protected canDeleteOn(split: SplitSummary): boolean {
    return (
      !this.isAllianceTenant() &&
      !split.origin_read_only &&
      canActOnSplit(split, this.auth.profile()?.user_id, this.auth.hasPermission('splits.delete'))
    );
  }
  protected readonly canCreate = computed(
    () => this.auth.hasPermission('splits.create') && !this.isAllianceTenant(),
  );
  protected readonly canManageIslands = computed(
    () => this.auth.hasPermission('splits.islands.manage') && !this.isAllianceTenant(),
  );

  protected readonly activeFilterCount = computed(
    () =>
      (this.searchQuery() ? 1 : 0) +
      (this.statusFilter() ? 1 : 0) +
      (this.islandFilter() ? 1 : 0) +
      (this.showArchived() ? 1 : 0),
  );
  protected readonly filtersActive = computed(() => this.activeFilterCount() > 0);

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    this.translate.dict();
    const kpi = this.kpi();
    return [
      {
        label: this.t('splits.total_distributed'),
        value: kpi ? this.formatCompact(kpi.total_net_distributed) : null,
        hint: kpi ? this.t('splits.kpi.completed_across', { count: kpi.completed_count }) : undefined,
      },
      {
        label: this.t('splits.pending_splits'),
        value: kpi ? kpi.pending_count : null,
        hint: this.t('splits.kpi.pending_sub'),
        tone: kpi && kpi.pending_count > 0 ? 'warning' : 'default',
      },
      {
        label: this.t('splits.total_silver_volume'),
        value: kpi ? this.formatCompact(kpi.total_estimated_volume) : null,
        hint: this.t('splits.kpi.volume_sub'),
      },
      {
        label: this.t('splits.participants'),
        value: kpi ? kpi.total_participants : null,
        hint: this.t('splits.kpi.recipients_sub'),
      },
    ];
  });

  protected readonly batchSummaryItems = computed<SummaryItem[]>(() => {
    this.translate.dict();
    return [
      { label: this.t('splits.batch.selectedSplits'), value: this.selectedSplits().length },
      { label: this.t('splits.batch.totalNetPayout'), value: this.formatAmount(this.selectedTotalNet()) },
      { label: this.t('splits.batch.totalRecipients'), value: this.selectedTotalParticipants() },
    ];
  });

  protected readonly statusTabs = computed<TabOption[]>(() => {
    this.translate.dict();
    return [
      { id: 'all', label: this.t('common.all') },
      ...STATUS_ORDER.map((status) => ({ id: status, label: this.statusLabel(status) })),
    ];
  });
  protected readonly activeStatusTab = computed(() => this.statusFilter() || 'all');

  protected readonly headerMenuItems = computed<MenuItem[]>(() => {
    this.translate.dict();
    const items: MenuItem[] = [
      { id: 'refresh', label: this.t('common.refreshNow'), disabled: this.loading() },
    ];
    if (this.canManageIslands()) {
      items.push({ id: 'islands', label: this.t('splits.catalog.manage') });
    }
    return items;
  });

  /** Row menus are built once per data change so the template bindings keep stable references. */
  protected readonly rowMenus = computed(() => {
    this.translate.dict();
    const menus = new Map<number, MenuItem[]>();
    for (const split of this.splits()) {
      const items: MenuItem[] = [];
      if (this.canActOn(split) && split.status === 'pending' && !split.archived_at) {
        items.push({ id: 'complete', label: this.t('splits.payout_complete'), icon: 'check' });
      }
      if (this.canDeleteOn(split)) {
        items.push(
          split.archived_at
            ? { id: 'unarchive', label: this.t('splits.unarchive') }
            : {
                id: 'archive',
                label: this.t('splits.archive'),
                danger: true,
                separatorBefore: items.length > 0,
              },
        );
      }
      menus.set(split.id, items);
    }
    return menus;
  });

  protected readonly columns = computed<readonly DataTableColumn<SplitSummary>[]>(() => {
    this.translate.dict();
    return [
      {
        key: 'note',
        label: 'common.name',
        sortable: true,
        accessor: (row) => row.note ?? '',
      },
      {
        key: 'created_at',
        label: 'common.date',
        sortable: true,
        accessor: (row) => row.created_at,
      },
      {
        key: 'net',
        label: 'splits.list.total',
        align: 'right',
        accessor: (row) => this.netOf(row),
      },
      {
        key: 'perMember',
        label: 'splits.list.perMember',
        align: 'right',
        accessor: (row) => this.perMemberShare(row),
      },
      {
        key: 'status',
        label: 'common.status',
        sortable: true,
        accessor: (row) => row.status,
      },
      {
        key: 'created_by',
        label: 'splits.list.createdBy',
        accessor: (row) => row.created_by_username,
      },
      { key: 'actions', label: 'common.actions', align: 'right', accessor: () => null },
    ];
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
    });
    void this.loadIslands();
    void this.loadKpi();
    void this.load();
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
  }

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.loadKpi(), this.loadIslands(), this.load()]);
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    } else if (id === 'islands') {
      void this.router.navigate(['/admin/islands']);
    }
  }

  protected onRowMenu(id: string, row: SplitSummary): void {
    switch (id) {
      case 'complete':
        this.openSingleAccept(row);
        break;
      case 'archive':
        this.askArchive(row);
        break;
      case 'unarchive':
        void this.unarchiveSplit(row);
        break;
    }
  }

  protected onStatusTab(id: string): void {
    const next: SplitStatus | '' = id === 'all' ? '' : isSplitStatus(id) ? id : '';
    if (next === this.statusFilter()) {
      return;
    }
    this.statusFilter.set(next);
    this.applyFilters();
  }

  protected onIslandChange(event: Event): void {
    this.islandFilter.set((event.target as HTMLSelectElement).value);
    this.applyFilters();
  }

  protected onArchivedChange(event: Event): void {
    this.showArchived.set((event.target as HTMLInputElement).checked);
    this.applyFilters();
  }

  protected onSearchInput(value: string): void {
    this.searchInput.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected clearFilters(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchInput.set('');
    this.statusFilter.set('');
    this.islandFilter.set('');
    this.showArchived.set(false);
    this.applyFilters();
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected statusLabel(status: SplitStatus): string {
    return this.t(`splits.status.${status}` as TranslationKey);
  }

  protected statusTone(status: SplitStatus): 'warning' | 'success' | 'neutral' | 'error' | 'info' {
    switch (status) {
      case 'pending':
        return 'warning';
      case 'awaiting_event':
        return 'info';
      case 'completed':
        return 'success';
      case 'lost':
        return 'error';
      default:
        return 'neutral';
    }
  }

  protected locationLabel(split: SplitSummary): string {
    if (
      !split.island_tab_id ||
      !split.island_name ||
      !split.island_city ||
      !split.island_tab_name
    ) {
      return this.t('splits.no_location');
    }
    return `${this.cityLabel(split.island_city as SplitIslandCity)} · ${split.island_name} · ${split.island_tab_name}`;
  }

  protected netOf(split: SplitSummary): number {
    if (split.net_value !== null && split.net_value !== undefined) {
      return Number(split.net_value);
    }
    const estimated = Number(split.estimated_market_value);
    return Math.max(
      0,
      (estimated - Number(split.repair_value) + Number(split.bags_value)) *
        (1 - Number(split.fee ?? DEFAULT_SPLIT_FEE) / 100),
    );
  }

  /** Net divided evenly by participants. Weighted shares are shown in the split detail. */
  protected perMemberShare(split: SplitSummary): number {
    return split.participant_count > 0 ? Math.round(this.netOf(split) / split.participant_count) : 0;
  }

  protected perMemberText(split: SplitSummary): string {
    return split.participant_count > 0 ? this.formatAmount(this.perMemberShare(split)) : '—';
  }

  protected totalWeight(): number {
    return this.participants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected draftWeightsAreValid(): boolean {
    return participantWeightsAreValid(this.participants().map((participant) => participant.weight));
  }

  protected estimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) {
      return 0;
    }
    return Math.round(netValue * (weight / totalWeight) * 100) / 100;
  }

  protected openCreateDialog(): void {
    this.participants.set(addCurrentUserToParticipants(this.participants(), this.auth.profile()));
    this.showCreateForm.set(true);
  }

  protected closeCreateDialog(): void {
    this.showCreateForm.set(false);
    this.showEventSearch.set(false);
    this.showParticipantSearch.set(false);
  }

  protected openSplit(row: SplitSummary): void {
    void this.router.navigate(['/splits', row.id]);
  }

  protected askArchive(row: SplitSummary): void {
    this.archiveTarget.set(row);
  }

  protected async confirmArchive(): Promise<void> {
    const target = this.archiveTarget();
    if (!target) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/splits/${target.id}/archive`, {}));
      this.archiveTarget.set(null);
      this.toasts.success(this.t('splits.archiveSuccess'));
      await Promise.all([this.load(), this.loadKpi()]);
    } catch {
      this.toasts.error(this.t('splits.list.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async unarchiveSplit(row: SplitSummary): Promise<void> {
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/splits/${row.id}/unarchive`, {}));
      this.toasts.success(this.t('splits.unarchiveSuccess'));
      await Promise.all([this.load(), this.loadKpi()]);
    } catch {
      this.toasts.error(this.t('splits.list.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Table emitted a page, size or sort change. Search and filters are not read from here: the
   * page owns them. The reload is skipped when nothing the server needs has changed, which is the
   * echo of a filter change that already reloaded.
   */
  protected onPageChange(event: DataTablePageChange): void {
    const sort = event.sort && SORT_WHITELIST.has(event.sort.columnKey) ? event.sort : null;
    const changed =
      event.page !== this.page() ||
      event.pageSize !== this.pageSize() ||
      !sameSort(sort, this.sort());
    this.page.set(event.page);
    this.pageSize.set(event.pageSize);
    this.sort.set(sort);
    if (changed) {
      void this.load();
    }
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }
  protected onEstimatedChange(event: Event): void {
    this.draftEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onFeeChange(event: Event): void {
    this.feeEdited = true;
    this.draftFeeInput.set((event.target as HTMLInputElement).value);
  }
  protected onRepairChange(event: Event): void {
    this.draftRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected addBag(): void {
    this.draftBagRows.update((rows) => [...rows, newSplitBag()]);
  }

  protected removeBag(key: number): void {
    this.draftBagRows.update((rows) => rows.filter((bag) => bag.key !== key));
  }

  protected onBagAmountChange(key: number, event: Event): void {
    const amount = Math.max(0, Number((event.target as HTMLInputElement).value) || 0);
    this.draftBagRows.update((rows) => rows.map((bag) => (bag.key === key ? { ...bag, amount } : bag)));
  }
  protected onRawNamesChange(event: Event): void {
    this.rawNames.set((event.target as HTMLTextAreaElement).value);
  }
  protected onDraftIslandChange(event: Event): void {
    this.draftIslandId.set((event.target as HTMLSelectElement).value);
    this.draftTabId.set('');
  }
  protected onDraftTabChange(event: Event): void {
    this.draftTabId.set((event.target as HTMLSelectElement).value);
  }

  protected onWeightChange(userId: number, event: Event): void {
    const weight = Math.max(0.01, Number((event.target as HTMLInputElement).value) || 1);
    this.weightsCustomized.set(true);
    this.participants.update((list) =>
      list.map((participant) =>
        participant.user_id === userId ? { ...participant, weight } : participant,
      ),
    );
  }

  protected distributeDraftWeightsEvenly(): void {
    this.weightsCustomized.set(false);
    this.participants.set(redistributeWeights(this.participants()));
  }

  protected removeParticipant(userId: number): void {
    const next = this.participants().filter((participant) => participant.user_id !== userId);
    this.participants.set(this.weightsCustomized() ? next : redistributeWeights(next));
  }

  protected clearParticipants(): void {
    this.rawNames.set('');
    this.participants.set([]);
    this.weightsCustomized.set(false);
  }

  protected async onScreenshotChange(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.item(0);
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append('image', file);
    this.matching.set(true);
    try {
      const result = await firstValueFrom(this.api.post<OcrResult>('api/utils/ocr', formData));
      this.rawNames.set(result.lines.join('\n'));
      await this.matchParticipants();
    } catch {
      this.toasts.error(this.t('splits.list.error.screenshot'));
    } finally {
      this.matching.set(false);
    }
  }

  protected async matchParticipants(): Promise<void> {
    const names = this.rawNames()
      .split(/\r?\n|,/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    this.matching.set(true);
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', { names }),
      );
      this.weightsCustomized.set(false);
      this.participants.set(redistributeWeights(toDraftParticipants(matched)));
    } catch {
      this.toasts.error(this.t('splits.list.error.match'));
    } finally {
      this.matching.set(false);
    }
  }

  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createSplit();
  }

  protected unlinkDraftEvent(): void {
    this.draftEventId.set('');
    this.draftEventTitle.set('');
  }

  protected onDraftEventSelect(opt: SearchDialogOption): void {
    this.draftEventId.set(String(opt.id));
    this.draftEventTitle.set(opt.title);
    this.showEventSearch.set(false);
  }

  protected async onEventSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const request = ++this.eventSearchRequest;
    this.eventSearchLoading.set(true);
    try {
      const params: Record<string, string> = { page: '1', limit: '50' };
      if (filters.search) {
        params['search'] = filters.search;
      }
      if (filters.dateFrom) {
        params['date_from'] = filters.dateFrom;
      }
      if (filters.dateTo) {
        params['date_to'] = filters.dateTo;
      }
      const res = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('/api/events', params),
      );
      if (request === this.eventSearchRequest) {
        this.eventSearchOptions.set(
          res.items.map((event) => ({
            id: event.id,
            title: event.title,
            subtitle: this.formatDate(event.event_date_utc),
            chip: event.status,
          })),
        );
      }
    } catch {
      if (request === this.eventSearchRequest) {
        this.toasts.error(this.t('splits.list.error.events'));
      }
    } finally {
      if (request === this.eventSearchRequest) {
        this.eventSearchLoading.set(false);
      }
    }
  }

  protected async onParticipantSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const request = ++this.participantSearchRequest;
    const query = filters.search.trim();
    if (!query) {
      this.participantSearchOptions.set([]);
      this.searchingRoster.set(false);
      return;
    }
    this.searchingRoster.set(true);
    try {
      // Search every registered site user, not just guild members: anyone with an account
      // can be a split participant (`GET /api/users` filters by username substring).
      const usersPage = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          page: 1,
          limit: 25,
          username: query,
        }),
      );
      if (request === this.participantSearchRequest) {
        this.participantSearchOptions.set(
          usersPage.items.map((user) => ({
            id: user.id,
            title: user.username,
            chip: user.role,
          })),
        );
      }
    } catch {
      if (request === this.participantSearchRequest) {
        this.toasts.error(this.t('splits.list.error.users'));
      }
    } finally {
      if (request === this.participantSearchRequest) {
        this.searchingRoster.set(false);
      }
    }
  }

  protected async onParticipantSelect(opt: SearchDialogOption): Promise<void> {
    const draft = {
      raw_name: opt.title,
      user_id: Number(opt.id),
      username: opt.title,
      weight: evenParticipantWeight(1),
    };
    if (this.participants().some((participant) => participant.user_id === draft.user_id)) {
      this.toasts.info(this.t('splits.already_in_roster', { name: draft.raw_name }));
      this.showParticipantSearch.set(false);
      return;
    }
    this.participants.set(
      this.weightsCustomized()
        ? [...this.participants(), draft]
        : redistributeWeights([...this.participants(), draft]),
    );
    this.showParticipantSearch.set(false);
  }

  protected isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  protected toggleSelected(id: number, event: Event): void {
    const split = this.splits().find((item) => item.id === id);
    if (!split || !this.canActOn(split) || split.status !== 'pending' || split.archived_at) {
      return;
    }
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  protected toggleAllPending(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedIds.set(
      checked
        ? new Set(this.actionablePendingSplits().map((split) => split.id))
        : new Set<number>(),
    );
  }

  protected clearSelection(): void {
    this.selectedIds.set(new Set<number>());
  }

  protected completeSelected(): void {
    if (this.selectedCount() === 0) {
      return;
    }
    this.showBatchConfirmDialog.set(true);
  }

  protected openSingleAccept(row: SplitSummary): void {
    if (!this.canActOn(row) || row.status !== 'pending' || row.archived_at) {
      return;
    }
    this.selectedIds.set(new Set([row.id]));
    this.showBatchConfirmDialog.set(true);
  }

  protected async runBatchComplete(): Promise<void> {
    const ids = this.selectedSplits().map((split) => split.id);
    if (ids.length === 0) {
      return;
    }
    this.batchRunning.set(true);
    try {
      const result = await firstValueFrom(
        this.api.post<CompleteSplitsBatchResult>('api/splits/complete-batch', { split_ids: ids }),
      );
      this.selectedIds.set(new Set<number>());
      this.showBatchConfirmDialog.set(false);
      if (result.completed.length > 0) {
        this.toasts.success(this.t('splits.list.batchDone', { count: result.completed.length }));
      }
      for (const failure of result.failed) {
        this.toasts.error(this.t('splits.list.batchFailed', { id: failure.split_id }));
      }
      await Promise.all([this.load(), this.loadKpi()]);
    } catch {
      this.toasts.error(this.t('splits.list.error.action'));
    } finally {
      this.batchRunning.set(false);
    }
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    return Number(value).toLocaleString();
  }

  protected formatCompact(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') {
      return '0';
    }
    const num = Number(value);
    if (Number.isNaN(num)) return '0';
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

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Pushes the page-owned filters into the URL, and resets the table to page 1. */
  private applyFilters(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchQuery.set(this.searchInput().trim());
    this.page.set(1);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.searchQuery() || null,
        status: this.statusFilter() || null,
        island: this.islandFilter() || null,
        archived: this.showArchived() ? 'true' : null,
        page: '1',
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  private async loadKpi(): Promise<void> {
    try {
      const summary = await firstValueFrom(this.api.get<SplitKpiSummary>('api/splits/summary'));
      this.kpi.set(summary);
      if (!this.feeEdited && summary.default_split_fee != null) {
        this.draftFeeInput.set(String(summary.default_split_fee));
      }
    } catch {
      this.kpi.set(null);
    }
  }

  protected async load(): Promise<void> {
    const request = ++this.loadRequest;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const params: Record<string, string | number> = {
        page: this.page(),
        limit: this.pageSize(),
      };
      if (this.statusFilter()) {
        params['status'] = this.statusFilter();
      }
      if (this.islandFilter()) {
        params['island_id'] = Number(this.islandFilter());
      }
      if (this.searchQuery()) {
        params['search'] = this.searchQuery();
      }
      if (this.showArchived() && this.canDelete()) {
        params['archived'] = 'true';
      }
      const sort = this.sort();
      if (sort) {
        params['sort'] = sort.columnKey;
        params['order'] = sort.direction;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<SplitSummary>>('api/splits', params),
      );
      if (request !== this.loadRequest) {
        return;
      }
      this.splits.set(data.items);
      this.totalItems.set(data.total_items);
    } catch {
      if (request === this.loadRequest) {
        this.loadFailed.set(true);
      }
    } finally {
      if (request === this.loadRequest) {
        this.loading.set(false);
      }
    }
  }

  private async createSplit(): Promise<void> {
    const title = this.draftTitle().trim();
    const finalParticipants = this.participants();
    const fee = parsePercentageInput(this.draftFeeInput());
    if (!title || finalParticipants.length === 0 || !this.draftTabId()) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (fee === null || fee < 0 || fee > 100) {
      this.toasts.error(this.t('splits.fee_invalid'));
      return;
    }
    if (!this.draftWeightsAreValid()) {
      this.toasts.error(this.t('splits.weight_sum_invalid'));
      return;
    }
    this.saving.set(true);
    try {
      const request: CreateSplitRequest = {
        note: title,
        estimated_market_value: this.draftEstimated(),
        fee,
        repair_value: this.draftRepair(),
        bags_value: this.draftBags(),
        bags: this.draftBagRows()
          .map((bag) => bag.amount)
          .filter((amount) => amount > 0),
        event_id: this.draftEventId() ? Number(this.draftEventId()) : undefined,
        island_tab_id: Number(this.draftTabId()),
        participants: finalParticipants.map((participant) => ({
          user_id: participant.user_id,
          weight: participant.weight,
        })),
      };
      await firstValueFrom(this.api.post<SplitDetail>('api/splits', request));
      this.resetCreateForm();
      await Promise.all([this.load(), this.loadKpi()]);
      this.toasts.success(this.t('splits.list.created'));
    } catch {
      this.toasts.error(this.t('splits.list.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  private resetCreateForm(): void {
    this.draftTitle.set('');
    this.draftEventId.set('');
    this.draftEventTitle.set('');
    this.draftEstimated.set(0);
    this.feeEdited = false;
    const defaultFee = this.kpi()?.default_split_fee;
    this.draftFeeInput.set(defaultFee != null ? String(defaultFee) : '');
    this.draftRepair.set(0);
    this.draftBagRows.set([]);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.rawNames.set('');
    this.participants.set([]);
    this.weightsCustomized.set(false);
    this.showCreateForm.set(false);
    this.showEventSearch.set(false);
    this.showParticipantSearch.set(false);
  }

  private async loadIslands(): Promise<void> {
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      this.islands.set(islands);
    } catch {
      this.toasts.error(this.t('splits.list.error.islands'));
    }
  }
}

export function isSplitBatchSelectable(status: SplitStatus): boolean {
  return status === 'pending';
}

export function isSplitAwaitingEvent(status: SplitStatus): boolean {
  return status === 'awaiting_event';
}

function isSplitStatus(value: string): value is SplitStatus {
  return (
    value === 'pending' ||
    value === 'awaiting_event' ||
    value === 'completed' ||
    value === 'not_completed' ||
    value === 'lost'
  );
}

export function addCurrentUserToParticipants(
  participants: readonly SplitParticipantDraft[],
  profile: Pick<DiscordUserProfile, 'user_id' | 'username'> | null,
): SplitParticipantDraft[] {
  if (!profile || participants.some((participant) => participant.user_id === profile.user_id)) {
    return [...participants];
  }

  return redistributeWeights([
    ...participants,
    {
      raw_name: profile.username,
      user_id: profile.user_id,
      username: profile.username,
      weight: evenParticipantWeight(1),
    },
  ]);
}

function toDraftParticipants(matched: MatchedParticipant[]): SplitParticipantDraft[] {
  return matched.map((participant) => ({
    raw_name: participant.matched_name,
    user_id: participant.user_id,
    username: participant.username,
    weight: evenParticipantWeight(1),
  }));
}

/**
 * The weight given to each participant by "distribute evenly": one full share (100%) each.
 * Weight is a relative share, not a percentage of the total that must sum to 100 — the backend
 * (and `estimatedShare`) normalizes by dividing each participant's weight by the sum of
 * everyone's, so giving every participant the same constant share is exactly "split equally"
 * regardless of headcount, with no division/rounding to reconcile.
 */
export function evenParticipantWeight(count: number): number {
  return count > 0 ? 100 : 0;
}

/**
 * Backend defaults (event import, older add-participant paths) stored one full share as `1`.
 * The edit UI labels the field as `%`, so `1,00` reads as 1% instead of 100%. When every
 * participant still has that unit share, lift them to the 100-scale the rest of the UI uses.
 * Mixed weights are left alone — `1` next to `100` is a real 1% share.
 */
export function upgradeLegacyUnitShares<T extends { weight: number }>(participants: T[]): T[] {
  if (participants.length === 0 || participants.some((participant) => participant.weight !== 1)) {
    return participants;
  }
  return redistributeWeights(participants);
}

/**
 * A weight is valid on its own — it never needs to add up to any particular total across
 * participants. This matches the backend's only real constraint (`weight > 0`, see
 * `SplitService::create_split`): the payout formula normalizes by the sum of all weights, so
 * `[100, 50]` (a full share and a half share) is exactly as valid as `[50, 50]`.
 */
export function participantWeightsAreValid(weights: readonly number[]): boolean {
  return weights.length > 0 && weights.every((weight) => weight > 0);
}

export function redistributeWeights<T extends { weight: number }>(participants: T[]): T[] {
  if (participants.length === 0) {
    return [];
  }
  const weight = evenParticipantWeight(participants.length);
  return participants.map((participant) => ({ ...participant, weight }));
}
