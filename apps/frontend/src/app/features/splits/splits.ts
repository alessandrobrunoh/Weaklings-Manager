import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
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
  type DataTableTab,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatCard } from '../../shared/components/stat-card/stat-card';


import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const SORT_WHITELIST = new Set(['created_at', 'status', 'note']);
const DEFAULT_SPLIT_FEE = 20;

function parsePercentageInput(raw: string): number | null {
  const normalized = raw.trim().replace(/%\s*$/, '').replace(',', '.');
  if (!normalized || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
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
 * Loot-split index: KPI strip plus a server-driven table.
 *
 * Create lives in an `app-dialog`. Viewing and editing a row is a dedicated
 * route (`/splits/:splitId`). Island catalog management belongs to admin.
 */
@Component({
  selector: 'app-splits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    Icon,
    PageHeader,
    PageStack,
    RouterLink,
    SearchDialog,
    TooltipDirective,
  ],
  styles: `
    :host {
      display: block;
      width: 100%;
    }

    .kpi-card {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      padding: 1.125rem 1.25rem;
      transition: border-color 150ms ease, background-color 150ms ease;
      display: flex;
      flex-direction: column;
    }
    .kpi-card:hover {
      border-color: var(--color-border-strong);
      background-color: var(--color-surface-hover);
    }

    .icon-capsule {
      width: 2.125rem;
      height: 2.125rem;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .icon-capsule--green {
      background: var(--color-success-container);
      color: var(--color-success);
    }
    .icon-capsule--amber {
      background: var(--color-warning-container);
      color: var(--color-warning);
    }
    .icon-capsule--purple {
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .icon-capsule--blue {
      background: var(--color-surface-2);
      color: var(--color-primary);
    }

    .batch-bar {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      transition: all 150ms ease;
    }
    .batch-bar--active {
      border-color: var(--color-primary);
      background: color-mix(in srgb, var(--color-primary-container) 35%, var(--color-surface));
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1;
    }
    .status-pill--completed {
      background-color: var(--color-success-container);
      border: 1px solid var(--color-success);
      color: var(--color-success);
    }
    .status-pill--pending {
      background-color: var(--color-warning-container);
      border: 1px solid var(--color-warning);
      color: var(--color-warning);
    }
    .status-pill--awaiting {
      background-color: var(--color-surface-2);
      border: 1px solid var(--color-primary);
      color: var(--color-primary);
    }
    .status-pill--neutral {
      background-color: var(--color-surface-2);
      border: 1px solid var(--color-border);
      color: var(--color-text-secondary);
    }
  `,
  template: `
    <app-page-header [title]="t('splits.title')" [subtitle]="t('splits.subtitle')">
      @if (canDelete()) {
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--tonal]="showArchived()"
          [class.btn--outline]="!showArchived()"
          (click)="toggleShowArchived()"
        >
          {{ t('splits.showArchived') }}
        </button>
      }
      <button
        type="button"
        class="btn btn--outline btn--sm inline-flex items-center gap-1.5"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="refresh" size="0.875rem" [class.animate-spin]="loading()" />
        <span>{{ t('common.refreshNow') }}</span>
      </button>

      @if (canManageIslands()) {
        <a
          routerLink="/admin/islands"
          class="btn btn--ghost btn--sm inline-flex items-center gap-1.5"
          [appTooltip]="t('splits.catalog.manage')"
          tooltipPosition="bottom"
        >
          <app-icon name="bank" size="0.875rem" />
          <span>{{ t('splits.catalog.manage') }}</span>
        </a>
      }
      @if (canCreate()) {
        <button
          type="button"
          class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
          (click)="openCreateDialog()"
          [appTooltip]="t('splits.new')"
          tooltipPosition="bottom"
        >
          <app-icon name="plus" size="0.875rem" />
          <span>{{ t('splits.new') }}</span>
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <!-- Row 1: KPI Summary Cards -->
      <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-5" aria-label="Split KPI Summary">
        <!-- Card 1: Total Distributed -->
        <div class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="icon-capsule icon-capsule--green">
              <app-icon name="bank" size="1.125rem" />
            </div>
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">
              {{ t('splits.total_distributed') }}
            </span>
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ formatCompact(kpi()?.total_net_distributed ?? 0) }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('splits.kpi.completed_across', { count: kpi()?.completed_count ?? 0 }) }}
          </div>
        </div>

        <!-- Card 2: Pending Splits -->
        <div class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="icon-capsule icon-capsule--amber">
              <app-icon name="alert" size="1.125rem" />
            </div>
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">
              {{ t('splits.pending_splits') }}
            </span>
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ (kpi()?.pending_count ?? 0).toString() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('splits.kpi.pending_sub') }}
          </div>
        </div>

        <!-- Card 3: Total Volume -->
        <div class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="icon-capsule icon-capsule--purple">
              <app-icon name="coins" size="1.125rem" />
            </div>
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">
              {{ t('splits.total_silver_volume') }}
            </span>
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ formatCompact(kpi()?.total_estimated_volume ?? 0) }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('splits.kpi.volume_sub') }}
          </div>
        </div>

        <!-- Card 4: Participants -->
        <div class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="icon-capsule icon-capsule--blue">
              <app-icon name="users" size="1.125rem" />
            </div>
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">
              {{ t('splits.participants') }}
            </span>
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ (kpi()?.total_participants ?? 0).toString() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('splits.kpi.recipients_sub') }}
          </div>
        </div>
      </section>

      <!-- Row 3: Batch Selection Command Bar -->
      @if (canAct() && pendingSplits().length > 0) {
        <section
          class="batch-bar p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-3"
          [class.batch-bar--active]="selectedCount() > 0"
        >
          <div class="flex items-center gap-3 min-w-0">
            <label class="flex cursor-pointer select-none items-center gap-2 text-sm text-(--color-text) font-medium">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="allPendingSelected()"
                (change)="toggleAllPending($event)"
              />
              <span>{{ t('splits.batch.select') }}</span>
            </label>

            @if (selectedCount() > 0) {
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-[var(--color-primary)] text-[var(--color-on-primary)]">
                {{ selectedCount() }}
              </span>

              <div class="hidden sm:flex items-center gap-3 pl-3 border-l border-[var(--color-border)] text-xs text-[var(--color-text-secondary)]">
                <span>
                  {{ t('splits.batch.totalNetPayout') }}:
                  <strong class="text-success font-mono font-bold">{{ formatAmount(selectedTotalNet()) }}</strong>
                </span>
                <span>&middot;</span>
                <span>
                  {{ selectedTotalParticipants() }} {{ t('splits.participants') }}
                </span>
              </div>
            }
          </div>

          <div class="flex items-center gap-2 shrink-0">
            @if (selectedCount() > 0) {
              <button
                type="button"
                class="btn btn--ghost btn--sm text-xs text-[var(--color-text-secondary)] hover:text-(--color-text)"
                (click)="clearSelection()"
              >
                {{ t('common.clear') }}
              </button>
            }
            <button
              type="button"
              class="btn btn--primary btn--sm flex items-center gap-1.5"
              [disabled]="selectedCount() === 0 || batchRunning()"
              (click)="completeSelected()"
            >
              <app-icon name="check" size="0.875rem" />
              <span>{{ t('splits.batch.complete') }}</span>
              @if (selectedCount() > 0) {
                <span class="font-mono">({{ selectedCount() }})</span>
              }
            </button>
          </div>

          @if (awaitingEventSplits().length > 0) {
            <div class="basis-full flex items-center gap-2 pt-2 border-t border-[var(--color-border)] text-xs text-warning">
              <app-icon name="alert" size="0.875rem" class="shrink-0" />
              <span>{{ t('splits.awaiting_event.message') }}</span>
            </div>
          }
        </section>
      }

      <!-- Row 4: Data Table with integrated Search and Status Tabs -->
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
        searchPlaceholder="Search splits by note or ID..."
        itemLabel="splits"
        emptyIcon="swords"
        emptyTitle="No splits found"
        emptySubtitle="There are no splits matching the selected filters."
        [tabs]="splitTabs()"
        [activeTab]="statusFilter()"
        (tabChange)="onTabSelect($event)"
      >
        @if (islands().length > 0) {
          <select
            dataTableActions
            class="bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-lg px-3 py-2 text-xs text-[var(--color-text)] cursor-pointer outline-none transition-all"
            [value]="islandFilter()"
            (change)="onIslandFilterChange($event)"
          >
            <option value="">{{ t('splits.all_islands') }}</option>
            @for (island of islands(); track island.id) {
              <option [value]="island.id" class="bg-[var(--color-surface)] text-[var(--color-text)]">
                {{ cityLabel(island.city) }} &middot; {{ island.name }}
              </option>
            }
          </select>
        }
        <ng-template dataTableCell="select" let-row>
          @if (canAct() && row.status === 'pending' && !row.archived_at) {
            <input
              class="checkbox"
              type="checkbox"
              [checked]="isSelected(row.id)"
              (click)="$event.stopPropagation()"
              (change)="toggleSelected(row.id, $event)"
              [attr.aria-label]="t('splits.batch.selectOne')"
            />
          }
        </ng-template>

        <ng-template dataTableCell="note" let-row>
          <span class="flex items-center gap-2 font-semibold text-(--color-text) group-hover:text-error transition-colors">
            <span>{{ row.note || t('splits.untitled', { id: row.id }) }}</span>
            @if (row.archived_at) {
              <span class="chip chip--neutral text-xs">{{ t('splits.archived') }}</span>
            }
          </span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          @switch (row.status) {
            @case ('completed') {
              <span class="status-pill status-pill--completed">
                <app-icon name="check" size="0.75rem" />
                <span>{{ statusLabel(row.status) }}</span>
              </span>
            }
            @case ('pending') {
              <span class="status-pill status-pill--pending">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                <span>{{ statusLabel(row.status) }}</span>
              </span>
            }
            @case ('awaiting_event') {
              <span class="status-pill status-pill--awaiting">
                <app-icon name="calendar" size="0.75rem" />
                <span>{{ statusLabel(row.status) }}</span>
              </span>
            }
            @default {
              <span class="status-pill status-pill--neutral">
                <span>{{ statusLabel(row.status) }}</span>
              </span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="island" let-row>
          @if (row.island_name) {
            <div class="flex items-center gap-1.5 text-xs text-[var(--color-text)]">
              <span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                {{ cityLabel(row.island_city) }}
              </span>
              <span class="truncate">{{ row.island_name }} &middot; {{ row.island_tab_name }}</span>
            </div>
          } @else {
            <span class="text-xs text-[var(--color-text-tertiary)]">{{ t('splits.no_location') }}</span>
          }
        </ng-template>

        <ng-template dataTableCell="event" let-row>
          @if (row.event_id && row.event_title) {
            <a
              class="text-xs text-[var(--color-primary)] font-medium no-underline hover:underline inline-flex items-center gap-1"
              [routerLink]="['/events', row.event_id]"
              (click)="$event.stopPropagation()"
            >
              <app-icon name="swords" size="0.75rem" class="opacity-70" />
              <span class="truncate">{{ row.event_title }}</span>
            </a>
          } @else {
            <span class="text-xs text-[var(--color-text-tertiary)]">{{ t('splits.no_event') }}</span>
          }
        </ng-template>

        <ng-template dataTableCell="net" let-row>
          <span class="mono font-bold text-sm text-success">{{ formatAmount(netOf(row)) }}</span>
        </ng-template>

        <ng-template dataTableCell="participants" let-row>
          <div class="flex items-center justify-end gap-1 text-xs text-[var(--color-text-secondary)]">
            <app-icon name="users" size="0.75rem" class="opacity-60" />
            <span class="font-medium font-mono">{{ row.participant_count }}</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="created_at" let-row>
          <span class="text-xs text-[var(--color-text-tertiary)]">{{ formatDate(row.created_at) }}</span>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end gap-1.5" (click)="$event.stopPropagation()">
            @if (canAct() && row.status === 'pending' && !row.archived_at) {
              <button
                type="button"
                class="btn btn--primary btn--sm py-1 px-2.5 text-xs flex items-center gap-1"
                [appTooltip]="'Accetta e liquida questo split'"
                tooltipPosition="bottom"
                (click)="openSingleAccept(row)"
              >
                <app-icon name="check" size="0.75rem" />
                <span>{{ t('splits.batch.complete') }}</span>
              </button>
            }
            <button
              type="button"
              class="btn btn--ghost btn--sm py-1 px-2 text-xs flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-(--color-text)"
              (click)="openSplit(row)"
            >
              <span>{{ t('common.open') }}</span>
              <app-icon name="arrow-right" size="0.75rem" />
            </button>
            @if (canDelete()) {
              @if (row.archived_at) {
                <button
                  type="button"
                  class="btn btn--outline btn--sm py-1 px-2 text-xs"
                  [disabled]="saving()"
                  (click)="unarchiveSplit(row)"
                >
                  {{ t('splits.unarchive') }}
                </button>
              } @else {
                <button
                  type="button"
                  class="btn btn--outline btn--sm py-1 px-2 text-xs"
                  (click)="askArchive(row)"
                >
                  {{ t('splits.archive') }}
                </button>
              }
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    <!-- NEW SPLIT MODAL -->
    @if (showCreateForm()) {
      <app-dialog [title]="t('splits.new')" size="lg" (closed)="closeCreateDialog()">
        <form id="create-split-form" class="space-y-4" (submit)="onCreateSubmit($event)">
          <p class="text-xs text-[var(--color-text-secondary)] -mt-2">
            {{ t('splits.create_hint') }}
          </p>

          <div class="grid gap-4 lg:grid-cols-2">
            <!-- LEFT COLUMN: CONFIGURATION & FINANCIALS -->
            <div class="space-y-4">
              <!-- Card 1: Note & Location -->
              <section class="card p-4 space-y-3">
                <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.location') }} &middot; {{ t('splits.note') }}
                </h3>

                <label class="block">
                  <span class="label font-medium">{{ t('common.name') }} / {{ t('splits.note') }} *</span>
                  <input
                    class="input text-xs"
                    type="text"
                    [placeholder]="'e.g. Castle Fight & Outpost Loot'"
                    [value]="draftTitle()"
                    (input)="onTitleChange($event)"
                    required
                  />
                </label>

                <div>
                  <span class="label font-medium">{{ t('splits.event_linked') }}</span>
                  <div class="flex items-center gap-2">
                    <div
                      class="input flex flex-1 items-center bg-[var(--color-surface-1)] text-xs truncate"
                    >
                      <span class="truncate">{{ draftEventTitle() || t('splits.no_event') }}</span>
                    </div>
                    <button
                      type="button"
                      class="btn btn--outline btn--sm whitespace-nowrap text-xs"
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
                    <span class="label font-medium">{{ t('splits.island') }} *</span>
                    <select
                      class="select text-xs"
                      [value]="draftIslandId()"
                      (change)="onDraftIslandChange($event)"
                    >
                      <option value="">{{ t('splits.pick_island') }}</option>
                      @for (island of islands(); track island.id) {
                        <option [value]="island.id">
                          {{ cityLabel(island.city) }} &middot; {{ island.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <label class="block">
                    <span class="label font-medium">{{ t('splits.tab') }} *</span>
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
                  <p class="text-xs text-[var(--color-warning)]">
                    {{ t('splits.catalog.empty') }}
                  </p>
                }
              </section>

              <!-- Card 2: Silver & Live Net Calculation -->
              <section class="card p-4 space-y-3">
                <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.net_value') }}
                </h3>

                <div class="grid gap-2 sm:grid-cols-3">
                  <label class="block">
                    <span class="label font-medium text-[0.6875rem]">{{ t('splits.estimated') }}</span>
                    <input
                      class="input font-mono text-xs"
                      type="number"
                      min="0"
                      [value]="draftEstimated()"
                      (input)="onEstimatedChange($event)"
                    />
                  </label>
                  <label class="block">
                    <span class="label font-medium text-[0.6875rem]">{{ t('splits.fee') }}</span>
                    <div class="flex items-center gap-1">
                      <input
                        class="input font-mono text-xs"
                        type="text"
                        inputmode="decimal"
                        [value]="draftFeeInput()"
                        (input)="onFeeChange($event)"
                      />
                      <span class="text-xs text-[var(--color-text-secondary)] font-mono">%</span>
                    </div>
                  </label>
                  <label class="block">
                    <span class="label font-medium text-[0.6875rem]">{{ t('splits.repair_cost') }} (-)</span>
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
                    <span class="label font-medium text-[0.6875rem]">{{ t('splits.bags_value') }} (+)</span>
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      (click)="addBag()"
                    >
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
                    <p class="text-xs text-[var(--color-text-secondary)]">{{ t('splits.bags_empty') }}</p>
                  }
                  @if (draftBags() > 0) {
                    <p class="text-xs font-mono text-[var(--color-text-secondary)]">
                      {{ t('splits.bags_total') }} +{{ formatAmount(draftBags()) }}
                    </p>
                  }
                </div>

                <!-- Live Net Silver Banner -->
                <div class="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] flex items-center justify-between">
                  <div>
                    <span class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                      {{ t('splits.net_value') }} ({{ t('splits.net_preview') }})
                    </span>
                    <p class="text-[0.6875rem] text-[var(--color-text-secondary)] mt-0.5">
                      {{ t('splits.net_formula') }}
                    </p>
                    @if (participants().length > 0) {
                      <p class="text-[0.6875rem] font-mono text-[var(--color-text-secondary)] mt-1">
                        ~{{ formatAmount(perParticipantShare()) }} / player
                      </p>
                    }
                  </div>
                  <div class="text-right">
                    <span class="font-mono text-xl font-medium text-[var(--color-success)]">
                      {{ formatAmount(draftNetPreview()) }}
                    </span>
                    <span class="block text-[0.6875rem] font-mono text-[var(--color-text-secondary)]">
                      silver
                    </span>
                  </div>
                </div>
              </section>
            </div>

            <!-- RIGHT COLUMN: ROSTER & OCR PARSING -->
            <div class="space-y-4">
              <!-- Card 3: Smart OCR / Raw Names Import -->
              <section class="card p-4 space-y-3">
                <div class="flex items-center justify-between">
                  <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                    {{ t('splits.match_ocr') }}
                  </h3>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm text-xs py-0.5"
                    (click)="clearParticipants()"
                  >
                    {{ t('splits.clear_roster') }}
                  </button>
                </div>

                <div
                  class="border border-dashed border-[var(--color-border)] rounded-md p-3 text-center bg-[var(--color-surface-1)] hover:border-[var(--color-primary)] transition-colors cursor-pointer"
                  (click)="fileInput.click()"
                >
                  <input
                    #fileInput
                    class="hidden"
                    type="file"
                    accept="image/*"
                    (change)="onScreenshotChange($event)"
                  />
                  <p class="text-xs font-medium text-[var(--color-text)]">
                    {{ t('splits.match_ocr') }}
                  </p>
                  <p class="text-[0.6875rem] text-[var(--color-text-secondary)] mt-0.5">
                    PNG, JPG screenshot from party / chest log
                  </p>
                </div>

                <label class="block">
                  <span class="label font-medium text-[0.6875rem]">{{ t('splits.ocr_names') }}</span>
                  <textarea
                    class="textarea font-mono text-xs"
                    rows="2"
                    [placeholder]="'PlayerOne, PlayerTwo\nPlayerThree'"
                    [value]="rawNames()"
                    (input)="onRawNamesChange($event)"
                  ></textarea>
                </label>

                <button
                  type="button"
                  class="w-full btn btn--tonal btn--sm text-xs py-1"
                  [disabled]="matching() || !rawNames().trim()"
                  (click)="matchParticipants()"
                >
                  {{ matching() ? t('common.loading') : t('splits.match_ocr') }}
                </button>
              </section>

              <!-- Card 4: Active Roster & Weights -->
              <section class="card p-4 space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                      {{ t('splits.participants') }} ({{ participants().length }})
                    </h3>
                    <span
                      class="chip font-mono text-xs font-medium"
                      [class.chip--success]="totalWeight() === 100"
                      [class.chip--warning]="totalWeight() !== 100"
                    >
                      {{ totalWeight() }}%
                    </span>
                  </div>

                  <div class="flex items-center gap-1.5">
                    @if (participants().length > 0) {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm text-xs py-0.5 px-2"
                        (click)="distributeDraftWeightsEvenly()"
                      >
                        {{ t('splits.distribute_evenly') }}
                      </button>
                    }
                    <button
                      type="button"
                      class="btn btn--primary btn--sm text-xs py-0.5 px-2"
                      (click)="showParticipantSearch.set(true)"
                    >
                      + {{ t('splits.add_participant') }}
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
                        <div class="flex items-center gap-2 min-w-0">
                          <div class="h-6 w-6 rounded bg-[var(--color-surface-2)] flex items-center justify-center text-[0.6875rem] font-mono text-[var(--color-text)] flex-shrink-0">
                            {{ participant.raw_name.slice(0, 1).toUpperCase() }}
                          </div>
                          <div class="min-w-0">
                            <p class="truncate text-xs font-medium text-[var(--color-text)]">
                              {{ participant.raw_name }}
                            </p>
                            <p class="truncate text-[0.625rem] text-[var(--color-text-secondary)]">
                              {{ participant.username }} &middot;
                              <span class="font-mono text-[var(--color-success)]">
                                ~{{
                                  formatAmount(
                                    estimatedShare(
                                      draftNetPreview(),
                                      participant.weight,
                                      totalWeight()
                                    )
                                  )
                                }}
                              </span>
                            </p>
                          </div>
                        </div>

                        <div class="flex items-center gap-2 flex-shrink-0">
                          <div class="flex items-center gap-1">
                            <input
                              class="input font-mono text-xs text-right py-0.5 px-1 w-14"
                              type="number"
                              min="0.01"
                              max="100"
                              step="0.01"
                              [value]="participant.weight"
                              (input)="onWeightChange(participant.user_id, $event)"
                            />
                            <span class="text-xs text-[var(--color-text-secondary)] font-mono">%</span>
                          </div>
                          <button
                            type="button"
                            class="btn btn--ghost btn--sm p-1 text-xs text-[var(--color-danger)]"
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
              totalWeight() !== 100
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
          <button
            type="button"
            class="btn btn--tonal"
            [disabled]="saving()"
            (click)="confirmArchive()"
          >
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
          <div class="grid grid-cols-3 gap-3">
            <div
              class="rounded-xl p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('splits.batch.selectedSplits') }}
              </p>
              <p class="text-lg font-bold mono mt-0.5" style="color: var(--color-text)">
                {{ selectedSplits().length }}
              </p>
            </div>
            <div
              class="rounded-xl p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('splits.batch.totalNetPayout') }}
              </p>
              <p class="text-lg font-bold mono mt-0.5 text-success">
                {{ formatAmount(selectedTotalNet()) }}
              </p>
            </div>
            <div
              class="rounded-xl p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('splits.batch.totalRecipients') }}
              </p>
              <p class="text-lg font-bold mono mt-0.5 text-primary">
                {{ selectedTotalParticipants() }}
              </p>
            </div>
          </div>

          <div
            class="rounded-xl border overflow-hidden"
            style="border-color: var(--color-border)"
          >
            <div
              class="px-3.5 py-2.5 border-b text-xs font-semibold uppercase tracking-wider"
              style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary)"
            >
              {{ t('splits.batch.splitsList') }}
            </div>
            <div class="max-h-72 overflow-y-auto divide-y" style="border-color: var(--color-border)">
              @for (split of selectedSplits(); track split.id) {
                <div
                  class="p-3 flex items-center justify-between gap-3 text-sm"
                  style="background: var(--color-surface-1)"
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <p class="font-semibold truncate" style="color: var(--color-text)">
                        {{ split.note || t('splits.untitled', { id: split.id }) }}
                      </p>
                      @if (split.event_title) {
                        <span class="chip chip--tonal text-xs">{{ split.event_title }}</span>
                      }
                    </div>
                    <p class="text-xs mt-0.5 truncate" style="color: var(--color-text-secondary)">
                      {{ locationLabel(split) }} · {{ split.participant_count }} {{ t('splits.participants') }}
                    </p>
                  </div>
                  <div class="text-right shrink-0">
                    <span class="mono font-bold text-success">{{ formatAmount(netOf(split)) }}</span>
                    <span class="block text-[11px] font-mono text-secondary">#{{ split.id }}</span>
                  </div>
                </div>
              }
            </div>
          </div>

          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('splits.batch.confirmWarning') }}
          </p>
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn--ghost"
            (click)="showBatchConfirmDialog.set(false)"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary flex items-center gap-2"
            [disabled]="batchRunning() || selectedSplits().length === 0"
            (click)="runBatchComplete()"
          >
            <app-icon name="check" size="1rem" />
            {{ batchRunning() ? t('common.loading') : t('splits.batch.acceptAndPay') }} ({{ selectedSplits().length }})
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
        [placeholder]="t('splits.search_roster')"
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
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly splits = signal<SplitSummary[]>([]);
  protected readonly kpi = signal<SplitKpiSummary | null>(null);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly islandFilter = signal('');
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(10);
  protected readonly searchQuery = signal('');
  protected readonly statusFilter = signal<SplitStatus | ''>('');
  protected readonly sortKey = signal<string | null>(null);
  protected readonly sortOrder = signal<'asc' | 'desc' | null>(null);

  protected readonly splitTabs = computed<DataTableTab[]>(() => [
    {
      id: '',
      label: this.t('common.all'),
      count: this.totalItems(),
    },
    {
      id: 'pending',
      label: this.t('splits.status.pending'),
      dotClass: 'bg-[var(--color-warning)]',
      count: this.kpi()?.pending_count,
    },
    {
      id: 'awaiting_event',
      label: this.t('splits.status.awaiting_event'),
      dotClass: 'bg-[var(--color-primary)]',
    },
    {
      id: 'completed',
      label: this.t('splits.status.completed'),
      dotClass: 'bg-[var(--color-success)]',
      count: this.kpi()?.completed_count,
    },
  ]);

  protected onTabSelect(tabId: string): void {
    this.setStatusFilter(tabId as SplitStatus | '');
  }

  private readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly batchRunning = signal(false);
  protected readonly showBatchConfirmDialog = signal(false);
  protected readonly archiveTarget = signal<SplitSummary | null>(null);
  protected readonly showArchived = signal(false);

  protected readonly showCreateForm = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftEventId = signal('');
  protected readonly draftEventTitle = signal('');
  protected readonly draftEstimated = signal(0);
  protected readonly draftFeeInput = signal(String(DEFAULT_SPLIT_FEE));
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

  protected readonly showEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);

  protected readonly trackById = (row: SplitSummary): number => row.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly pendingSplits = computed(() =>
    this.splits().filter(
      (split) => isSplitBatchSelectable(split.status) && !split.archived_at,
    ),
  );
  protected readonly awaitingEventSplits = computed(() =>
    this.splits().filter((split) => isSplitAwaitingEvent(split.status)),
  );
  protected readonly selectedSplits = computed(() =>
    this.splits().filter(
      (split) => split.status === 'pending' && !split.archived_at && this.selectedIds().has(split.id),
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
    const pending = this.pendingSplits();
    return pending.length > 0 && pending.every((split) => this.selectedIds().has(split.id));
  });
  protected readonly draftFee = computed(() => parsePercentageInput(this.draftFeeInput()) ?? 0);
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
  protected readonly canAct = computed(() => this.auth.hasPermission('splits.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('splits.delete'));
  protected readonly canCreate = computed(() => this.auth.hasPermission('splits.create'));
  protected readonly canManageIslands = computed(() =>
    this.auth.hasPermission('splits.islands.manage'),
  );

  protected readonly hasActiveFilters = computed(
    () => Boolean(this.statusFilter() || this.islandFilter() || this.searchQuery().trim()),
  );

  protected setStatusFilter(status: SplitStatus | ''): void {
    this.statusFilter.set(status);
    this.page.set(1);
    void this.load();
  }

  protected resetFilters(): void {
    this.statusFilter.set('');
    this.islandFilter.set('');
    this.searchQuery.set('');
    this.page.set(1);
    void this.load();
  }

  protected clearSelection(): void {
    this.selectedIds.set(new Set<number>());
  }

  protected readonly columns = computed<readonly DataTableColumn<SplitSummary>[]>(() => {
    this.translate.dict();
    const cols: DataTableColumn<SplitSummary>[] = [];
    if (this.canAct()) {
      cols.push({ key: 'select', label: '', accessor: () => null });
    }
    cols.push(
      {
        key: 'note',
        label: 'splits.note',
        sortable: true,
        searchable: true,
        accessor: (row) => row.note ?? '',
      },
      {
        key: 'status',
        label: 'common.status',
        sortable: true,
        accessor: (row) => row.status,
        filterOptions: [
          { value: 'pending', label: this.t('splits.status.pending') },
          { value: 'completed', label: this.t('splits.status.completed') },
          { value: 'not_completed', label: this.t('splits.status.not_completed') },
          { value: 'lost', label: this.t('splits.status.lost') },
        ],
      },
      {
        key: 'island',
        label: 'splits.island',
        accessor: (row) => this.locationLabel(row),
        filterOptions: this.islands().map((island) => ({
          value: String(island.id),
          label: `${this.cityLabel(island.city)} · ${island.name}`,
        })),
      },
      { key: 'event', label: 'splits.event', accessor: (row) => row.event_title ?? '' },
      { key: 'net', label: 'splits.net_value', align: 'right', accessor: (row) => this.netOf(row) },
      {
        key: 'participants',
        label: 'splits.participants',
        align: 'right',
        accessor: (row) => row.participant_count,
      },
      {
        key: 'created_at',
        label: 'splits.created',
        sortable: true,
        accessor: (row) => row.created_at,
      },
      { key: 'actions', label: 'common.actions', align: 'right', accessor: () => null },
    );
    return cols;
  });

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.loadKpi(), this.loadIslands(), this.load()]);
  }

  constructor() {
    void this.loadIslands();
    void this.loadKpi();
    void this.load();
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected statusLabel(status: SplitStatus): string {
    return this.t(`splits.status.${status}` as TranslationKey);
  }

  protected statusTone(status: SplitStatus): 'warning' | 'success' | 'neutral' | 'error' {
    switch (status) {
      case 'pending':
      case 'awaiting_event':
        return 'warning';
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

  protected totalWeight(): number {
    return this.participants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected estimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) {
      return 0;
    }
    return Math.round(netValue * (weight / totalWeight) * 100) / 100;
  }

  protected openCreateDialog(): void {
    this.participants.set(
      addCurrentUserToParticipants(this.participants(), this.auth.profile()),
    );
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

  protected toggleShowArchived(): void {
    this.showArchived.update((value) => !value);
    this.page.set(1);
    void this.load();
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected onPageChange(event: DataTablePageChange): void {
    this.page.set(event.page);
    this.pageSize.set(event.pageSize);
    this.searchQuery.set(event.search);
    const status = event.columnFilters['status'];
    if (isSplitStatus(status)) {
      this.statusFilter.set(status);
    }
    const island = event.columnFilters['island'];
    if (island) {
      this.islandFilter.set(island);
    }
    if (event.sort && SORT_WHITELIST.has(event.sort.columnKey)) {
      this.sortKey.set(event.sort.columnKey);
      this.sortOrder.set(event.sort.direction);
    } else {
      this.sortKey.set(null);
      this.sortOrder.set(null);
    }
    void this.load();
  }

  protected onIslandFilterChange(event: Event): void {
    this.islandFilter.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
    void this.load();
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }
  protected onEstimatedChange(event: Event): void {
    this.draftEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onFeeChange(event: Event): void {
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
    this.draftBagRows.update((rows) =>
      rows.map((bag) => (bag.key === key ? { ...bag, amount } : bag)),
    );
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
    const weight = Math.min(100, Math.max(1, Number((event.target as HTMLInputElement).value) || 1));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
      this.eventSearchOptions.set(
        res.items.map((event) => ({
          id: event.id,
          title: event.title,
          subtitle: this.formatDate(event.event_date_utc),
          chip: event.status,
        })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.eventSearchLoading.set(false);
    }
  }

  protected async onParticipantSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const query = filters.search.trim();
    if (!query) {
      this.participantSearchOptions.set([]);
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
      this.participantSearchOptions.set(
        rosterPage.items.map((member) => ({ id: member.id, title: member.name })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected async onParticipantSelect(opt: SearchDialogOption): Promise<void> {
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', {
          names: [opt.title],
        }),
      );
      const draft = toDraftParticipants(matched).at(0);
      if (!draft) {
        this.toasts.error(this.t('splits.unlinked_character'));
        return;
      }
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  protected toggleSelected(id: number, event: Event): void {
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
      checked ? new Set(this.pendingSplits().map((split) => split.id)) : new Set<number>(),
    );
  }

  protected completeSelected(): void {
    if (this.selectedCount() === 0) {
      return;
    }
    this.showBatchConfirmDialog.set(true);
  }

  protected openSingleAccept(row: SplitSummary): void {
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
        this.toasts.success(`${result.completed.length} ${this.t('splits.batch.completed')}`);
      }
      for (const failure of result.failed) {
        this.toasts.error(`Split #${failure.split_id}: ${failure.reason}`);
      }
      await Promise.all([this.load(), this.loadKpi()]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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

  private async loadKpi(): Promise<void> {
    try {
      const summary = await firstValueFrom(this.api.get<SplitKpiSummary>('api/splits/summary'));
      this.kpi.set(summary);
    } catch {
      this.kpi.set(null);
    }
  }

  protected async load(): Promise<void> {
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
      const search = this.searchQuery().trim();
      if (search) {
        params['search'] = search;
      }
      if (this.showArchived()) {
        params['archived'] = 'true';
      }
      const sort = this.sortKey();
      if (sort) {
        params['sort'] = sort;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<SplitSummary>>('api/splits', params),
      );
      this.splits.set(data.items);
      this.totalItems.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
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
    if (Math.abs(this.totalWeight() - 100) > 0.01) {
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
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private resetCreateForm(): void {
    this.draftTitle.set('');
    this.draftEventId.set('');
    this.draftEventTitle.set('');
    this.draftEstimated.set(0);
    this.draftFeeInput.set(String(this.kpi()?.default_split_fee ?? DEFAULT_SPLIT_FEE));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
      weight: 1,
    },
  ]);
}

function toDraftParticipants(matched: MatchedParticipant[]): SplitParticipantDraft[] {
  return matched.map((participant) => ({
    raw_name: participant.matched_name,
    user_id: participant.user_id,
    username: participant.username,
    weight: 1,
  }));
}

function redistributeWeights(participants: SplitParticipantDraft[]): SplitParticipantDraft[] {
  if (participants.length === 0) {
    return [];
  }
  const totalCents = 10_000;
  const baseCents = Math.floor(totalCents / participants.length);
  const remainderCents = totalCents - baseCents * participants.length;
  return participants.map((participant, index) => ({
    ...participant,
    weight: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
  }));
}
