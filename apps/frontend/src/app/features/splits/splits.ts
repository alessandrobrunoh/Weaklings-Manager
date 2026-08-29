import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  CompleteSplitsBatchResult,
  CreateSplitRequest,
  EventView,
  MatchedParticipant,
  OcrResult,
  PaginatedData,
  SplitDetail,
  SplitIsland,
  SplitIslandCity,
  SplitParticipant,
  SplitStatus,
  SplitSummary,
  UpdateSplitRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';

const PAGE_SIZE = 12;

const ISLAND_CITIES: readonly SplitIslandCity[] = [
  'lymhurst',
  'bridgewatch',
  'martlock',
  'fort_sterling',
  'thetford',
  'caerleon',
  'brecilien',
];

interface SplitParticipantDraft {
  readonly raw_name: string;
  readonly user_id: number;
  readonly username: string;
  weight: number;
}

/**
 * Loot Split Management & Tactical Distribution Center.
 *
 * Facilitates fair party loot distribution, OCR-assisted screenshot parsing,
 * linked event synchronisation, and complete split lifecycle administration.
 */
@Component({
  selector: 'app-splits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    RouterLink,
    SearchDialog,
  ],
  template: `
    <app-page-header [title]="t('splits.title')" [subtitle]="t('splits.subtitle')">
      <button
        type="button"
        class="btn btn--primary flex items-center gap-2"
        (click)="toggleCreateForm()"
      >
        @if (showCreateForm()) {
          <app-icon name="close" size="1.1rem" />
        } @else {
          <app-icon name="sparkles" size="1.1rem" />
        }
        {{ showCreateForm() ? t('common.close') : t('splits.new') }}
      </button>
    </app-page-header>

    @if (canManageIslands()) {
      <section class="card mt-4 p-5" aria-label="Island catalog">
        <header class="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="font-semibold" style="color: var(--color-text)">{{ t('splits.catalog.title') }}</h2>
            <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
              {{ t('splits.catalog.hint') }}
            </p>
          </div>
        </header>

        <form class="mb-4 grid gap-2 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end" (submit)="onCreateIsland($event)">
          <label>
            <span class="label">{{ t('splits.location') }}</span>
            <select class="select" [value]="newIslandCity()" (change)="onNewIslandCity($event)">
              @for (city of islandCities; track city) {
                <option [value]="city">{{ cityLabel(city) }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('splits.island') }}</span>
            <input class="input" type="text" [value]="newIslandName()" (input)="onNewIslandName($event)" />
          </label>
          <label>
            <span class="label">{{ t('splits.catalog.new_tab') }}</span>
            <input
              class="input"
              type="text"
              [value]="newIslandTabs()"
              (input)="onNewIslandTabs($event)"
              placeholder="Loot, Silver"
            />
          </label>
          <button type="submit" class="btn btn--primary" [disabled]="catalogSaving()">
            {{ t('splits.catalog.add') }}
          </button>
        </form>

        @if (islands().length === 0) {
          <app-empty-state [message]="t('splits.catalog.empty')" icon="swords" />
        } @else {
          <ul class="grid gap-3" role="list">
            @for (island of islands(); track island.id) {
              <li class="surface rounded-xl p-3">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p class="font-medium" style="color: var(--color-text)">
                    {{ cityLabel(island.city) }} · {{ island.name }}
                  </p>
                  <button
                    type="button"
                    class="btn btn--danger btn--sm"
                    (click)="deleteIsland(island.id)"
                  >
                    {{ t('common.delete') }}
                  </button>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  @for (tab of island.tabs; track tab.id) {
                    <span class="chip">{{ tab.name }}</span>
                  }
                </div>
                <form class="mt-2 flex flex-wrap gap-2" (submit)="onAddTab($event, island.id)">
                  <input
                    class="input"
                    style="max-width: 12rem"
                    type="text"
                    [value]="newTabNameByIsland()[island.id] ?? ''"
                    (input)="onNewTabName(island.id, $event)"
                    [placeholder]="t('splits.catalog.new_tab')"
                  />
                  <button type="submit" class="btn btn--outline btn--sm">
                    {{ t('splits.catalog.add_tab') }}
                  </button>
                </form>
              </li>
            }
          </ul>
        }
      </section>
    }

    <!-- ================= KPI METRIC CARDS ================= -->
    <section
      class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
      aria-label="Split KPI Summary"
    >
      <article class="surface p-4">
        <p class="splits__label">{{ t('splits.total_distributed') }}</p>
        <p class="splits__value text-success">
          {{ formatCompact(totalNetDistributed()) }}
        </p>
        <p class="splits__sub">
          Across <strong class="mono">{{ completedSplitsCount() }}</strong> completed
        </p>
      </article>

      <article class="surface p-4">
        <p class="splits__label">{{ t('splits.pending_splits') }}</p>
        <p class="splits__value text-warning">
          {{ pendingSplits().length }}
        </p>
        <p class="splits__sub">
          Awaiting officer payout
        </p>
      </article>

      <article class="surface p-4">
        <p class="splits__label">{{ t('splits.total_silver_volume') }}</p>
        <p class="splits__value">
          {{ formatCompact(totalEstimatedVolume()) }}
        </p>
        <p class="splits__sub">
          Estimated market value
        </p>
      </article>

      <article class="surface p-4">
        <p class="splits__label">{{ t('splits.participants') }}</p>
        <p class="splits__value text-primary">
          {{ totalParticipantsCount() }}
        </p>
        <p class="splits__sub">
          Total payout recipients
        </p>
      </article>
    </section>

    <!-- ================= CREATE SPLIT DRAWER / FORM ================= -->
    @if (showCreateForm()) {
      <form class="card mt-6 grid gap-5 p-5 border-2" style="border-color: var(--color-primary)" (submit)="onCreateSubmit($event)">
        <div class="flex items-center justify-between border-b pb-3" style="border-color: var(--color-border)">
          <div>
            <h2 class="text-lg font-bold" style="color: var(--color-text)">
              {{ t('splits.new') }}
            </h2>
            <p class="text-xs text-secondary">
              Upload party screenshot, match names or search guild roster.
            </p>
          </div>
          <button type="button" class="btn btn--ghost btn--sm" (click)="toggleCreateForm()">
            <app-icon name="close" size="1rem" />
          </button>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <!-- Left Column: Split Properties & Financials -->
          <section class="space-y-4">
            <label class="block">
              <span class="label font-medium">{{ t('common.name') }} / Note *</span>
              <input
                class="input"
                type="text"
                placeholder="e.g. Avalonian Dungeon 8.3 / World Boss Chest"
                [value]="draftTitle()"
                (input)="onTitleChange($event)"
                required
              />
            </label>

            <!-- Linked Event -->
            <div>
              <span class="label font-medium">{{ t('splits.event_linked') }}</span>
              <div class="flex items-center gap-2">
                <div class="flex-1 input flex items-center bg-[var(--color-surface-1)]">
                  <span class="truncate">{{ draftEventTitle() || t('splits.no_event') }}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--outline whitespace-nowrap"
                  (click)="showEventSearch.set(true)"
                >
                  {{ t('splits.link_event') }}
                </button>
                @if (draftEventId()) {
                  <button
                    type="button"
                    class="btn btn--danger whitespace-nowrap"
                    [title]="t('splits.unlink_event')"
                    (click)="unlinkDraftEvent()"
                  >
                    <app-icon name="close" size="1rem" />
                  </button>
                }
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="label font-medium">{{ t('splits.island') }} *</span>
                <select
                  class="select"
                  [value]="draftIslandId()"
                  (change)="onDraftIslandChange($event)"
                >
                  <option value="">{{ t('splits.pick_island') }}</option>
                  @for (island of islands(); track island.id) {
                    <option [value]="island.id">{{ cityLabel(island.city) }} · {{ island.name }}</option>
                  }
                </select>
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.tab') }} *</span>
                <select
                  class="select"
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
              <p class="text-xs" style="color: var(--color-warning)">{{ t('splits.catalog.empty') }}</p>
            }

            <!-- Financial Inputs -->
            <div class="grid gap-3 sm:grid-cols-3">
              <label class="block">
                <span class="label font-medium">{{ t('splits.estimated') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="draftEstimated()"
                  (input)="onEstimatedChange($event)"
                />
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.repair_cost') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="draftRepair()"
                  (input)="onRepairChange($event)"
                />
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.bags_value') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="draftBags()"
                  (input)="onBagsChange($event)"
                />
              </label>
            </div>

            <!-- Real-time Net Value Formula Display -->
            <div class="surface p-3 rounded-lg border flex items-center justify-between" style="border-color: var(--color-border)">
              <div>
                <p class="text-xs text-disabled uppercase font-semibold">{{ t('splits.net_value') }} (Preview)</p>
                <p class="text-xs text-secondary">Estimated - Repairs + Bags</p>
              </div>
              <p class="text-xl font-bold mono text-success">
                {{ formatAmount(draftNetPreview()) }}
              </p>
            </div>

            <!-- OCR Screenshot Upload -->
            <div class="surface p-3 rounded-lg border space-y-2" style="border-color: var(--color-border)">
              <label class="block">
                <span class="label font-medium">{{ t('splits.match_ocr') }}</span>
                <input
                  class="input text-xs"
                  type="file"
                  accept="image/*"
                  (change)="onScreenshotChange($event)"
                />
              </label>

              <label class="block">
                <span class="label font-medium">Albion names (one per line)</span>
                <textarea
                  class="textarea font-mono text-xs"
                  rows="3"
                  placeholder="PlayerOne&#10;PlayerTwo&#10;PlayerThree"
                  [value]="rawNames()"
                  (input)="onRawNamesChange($event)"
                ></textarea>
              </label>

              <div class="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  class="btn btn--tonal btn--sm"
                  [disabled]="matching() || !rawNames().trim()"
                  (click)="matchParticipants()"
                >
                  {{ matching() ? t('common.loading') : t('splits.match_ocr') }}
                </button>
                <button type="button" class="btn btn--ghost btn--sm" (click)="clearParticipants()">
                  {{ t('common.delete') }} roster
                </button>
              </div>
            </div>
          </section>

          <!-- Right Column: Participant Roster -->
          <section class="surface p-4 rounded-lg flex flex-col justify-between">
            <div>
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 class="font-semibold text-base" style="color: var(--color-text)">
                    {{ t('splits.participants') }} ({{ participants().length }})
                  </h3>
                  <p class="text-xs text-secondary">Adjust percentage shares</p>
                </div>
                <div class="flex items-center gap-2">
                  <span
                    class="chip mono font-bold"
                    [class.chip--success]="totalWeight() === 100"
                    [class.chip--warning]="totalWeight() !== 100"
                    [title]="totalWeight() === 100 ? 'Total weight is balanced (100%)' : 'Total weight should equal 100%'"
                  >
                    {{ totalWeight() }}%
                  </span>
                  @if (participants().length > 0) {
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      (click)="distributeDraftWeightsEvenly()"
                      [title]="t('splits.distribute_evenly')"
                    >
                      {{ t('splits.distribute_evenly') }}
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    (click)="openParticipantDialog()"
                    [title]="t('splits.add_participant')"
                  >
                    + {{ t('splits.add_participant') }}
                  </button>
                </div>
              </div>

              @if (participants().length === 0) {
                <div class="py-8">
                  <app-empty-state [message]="'No participants in roster yet'" icon="users" />
                </div>
              } @else {
                <div class="grid gap-2 max-h-96 overflow-y-auto pr-1 scrollbar-thin">
                  @for (participant of participants(); track participant.user_id) {
                    <article class="card p-3 flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <p class="font-medium text-sm truncate" style="color: var(--color-text)">
                          {{ participant.raw_name }}
                        </p>
                        <p class="text-xs text-secondary truncate">
                          {{ participant.username }} ·
                          <span class="mono text-success font-semibold">
                            ~{{ formatAmount(calculateEstimatedShare(draftNetPreview(), participant.weight, totalWeight())) }}
                          </span>
                        </p>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <label class="flex items-center gap-1">
                          <input
                            class="input mono text-sm"
                            style="width: 5rem; text-align: right"
                            type="number"
                            min="1"
                            max="100"
                            [value]="participant.weight"
                            (input)="onWeightChange(participant.user_id, $event)"
                          />
                          <span class="text-xs text-secondary">%</span>
                        </label>
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm text-error"
                          (click)="removeParticipant(participant.user_id)"
                          aria-label="Remove participant"
                        >
                          <app-icon name="close" size="0.875rem" />
                        </button>
                      </div>
                    </article>
                  }
                </div>
              }
            </div>

            <div class="flex justify-end gap-2 border-t pt-4 mt-4" style="border-color: var(--color-border)">
              <button type="button" class="btn btn--ghost" (click)="toggleCreateForm()">
                {{ t('common.cancel') }}
              </button>
              <button
                type="submit"
                class="btn btn--primary"
                [disabled]="saving() || participants().length === 0 || !draftTitle().trim() || !draftTabId()"
              >
                {{ saving() ? t('common.loading') : t('common.create') }}
              </button>
            </div>
          </section>
        </div>
      </form>
    }

    <!-- ================= FILTER & SEARCH TOOLBAR ================= -->
    <section class="mt-6 flex flex-wrap items-center justify-between gap-4">
      <!-- Status Pills -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="statusFilter() === ''"
          [class.btn--outline]="statusFilter() !== ''"
          (click)="setStatusFilter('')"
        >
          {{ t('common.all') }} ({{ splits().length }})
        </button>
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="statusFilter() === 'pending'"
          [class.btn--outline]="statusFilter() !== 'pending'"
          (click)="setStatusFilter('pending')"
        >
          Pending ({{ pendingSplits().length }})
        </button>
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="statusFilter() === 'completed'"
          [class.btn--outline]="statusFilter() !== 'completed'"
          (click)="setStatusFilter('completed')"
        >
          Completed ({{ completedSplitsCount() }})
        </button>
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="statusFilter() === 'not_completed'"
          [class.btn--outline]="statusFilter() !== 'not_completed'"
          (click)="setStatusFilter('not_completed')"
        >
          Not completed
        </button>
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--primary]="statusFilter() === 'lost'"
          [class.btn--outline]="statusFilter() !== 'lost'"
          (click)="setStatusFilter('lost')"
        >
          Lost
        </button>
      </div>

      <label class="flex items-center gap-2">
        <span class="label" style="margin-bottom: 0">{{ t('splits.island') }}</span>
        <select class="select" style="width: auto" [value]="islandFilter()" (change)="onIslandFilterChange($event)">
          <option value="">{{ t('common.all') }}</option>
          @for (island of islands(); track island.id) {
            <option [value]="island.id">{{ cityLabel(island.city) }} · {{ island.name }}</option>
          }
        </select>
      </label>

      <!-- Search Input -->
      <div class="w-full sm:w-80">
        <input
          type="text"
          class="input input--sm"
          [placeholder]="t('splits.search_splits')"
          [value]="searchQuery()"
          (input)="onSearchQueryChange($event)"
        />
      </div>
    </section>

    <!-- ================= BATCH ACTIONS STRIP ================= -->
    @if (canAct() && pendingSplits().length > 0) {
      <section
        class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 surface"
        style="border-color: var(--color-border); background-color: var(--color-surface-2)"
      >
        <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            class="checkbox"
            type="checkbox"
            [checked]="allPendingSelected()"
            (change)="toggleAllPending($event)"
          />
          <span>
            {{ t('splits.batch.select') }}
            @if (selectedCount() > 0) {
              <strong class="text-primary font-mono">({{ selectedCount() }} selected)</strong>
            }
          </span>
        </label>
        <button
          type="button"
          class="btn btn--primary btn--sm flex items-center gap-2"
          [disabled]="selectedCount() === 0 || batchRunning()"
          (click)="completeSelected()"
        >
          <app-icon name="check" size="1rem" />
          {{ t('splits.batch.complete') }}
        </button>
      </section>
    }

    <!-- ================= SPLITS LIST / CARDS ================= -->
    @if (loading()) {
      <div class="py-12">
        <app-loading [label]="t('common.loading')" />
      </div>
    } @else if (loadFailed()) {
      <div class="py-12">
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
      </div>
    } @else if (filteredSplits().length === 0) {
      <div class="py-12">
        <app-empty-state [message]="t('common.empty')" icon="swords" />
      </div>
    } @else {
      <section class="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-label="Splits Grid">
        @for (split of filteredSplits(); track split.id) {
          <article
            class="card p-5 cursor-pointer flex flex-col justify-between splits__card transition-all hover:border-primary"
            (click)="openSplit(split.id)"
          >
            <div>
              <!-- Card Header -->
              <header class="mb-3 flex items-start justify-between gap-2">
                <div class="flex min-w-0 items-start gap-2.5">
                  @if (canAct() && split.status === 'pending') {
                    <input
                      class="checkbox mt-1 shrink-0"
                      type="checkbox"
                      [checked]="isSelected(split.id)"
                      (click)="$event.stopPropagation()"
                      (change)="toggleSelected(split.id, $event)"
                      [attr.aria-label]="t('splits.batch.selectOne')"
                    />
                  }
                  <div class="min-w-0">
                    <h3 class="truncate text-base font-bold" style="color: var(--color-text)">
                      {{ split.note || 'Split #' + split.id }}
                    </h3>
                    <p class="text-xs text-secondary mt-0.5">
                      By <span class="font-medium text-foreground">{{ split.created_by_username }}</span> · {{ formatDate(split.created_at) }}
                    </p>
                  </div>
                </div>
                <span class="chip font-mono text-xs uppercase" [class]="statusChip(split.status)">
                  {{ split.status }}
                </span>
              </header>

              <!-- Linked Event Badge -->
              @if (split.event_title || split.island_tab_id) {
                <div class="mb-3 flex flex-wrap gap-1.5">
                  @if (split.event_title) {
                    <a
                      class="chip chip--info text-xs no-underline inline-flex items-center gap-1.5"
                      [routerLink]="['/events', split.event_id]"
                      (click)="$event.stopPropagation()"
                    >
                      <app-icon name="calendar" size="0.8rem" />
                      <span class="truncate max-w-48">{{ split.event_title }}</span>
                    </a>
                  }
                  @if (split.island_tab_id) {
                    <span class="chip text-xs">{{ locationLabel(split) }}</span>
                  }
                </div>
              }

              <!-- Financial Breakdown Pill Grid -->
              <div class="surface p-3 rounded-lg grid grid-cols-3 gap-2 text-center my-3 border" style="border-color: var(--color-border)">
                <div>
                  <p class="text-xs text-disabled uppercase">Estimated</p>
                  <p class="font-bold text-sm mono text-warning">
                    {{ formatCompact(split.estimated_market_value) }}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-disabled uppercase">Deductions</p>
                  <p class="font-bold text-sm mono text-error">
                    -{{ formatCompact(split.repair_value) }}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-disabled uppercase">{{ t('splits.net_value') }}</p>
                  <p class="font-bold text-sm mono text-success">
                    {{ formatCompact(split.net_value ?? (split.estimated_market_value - split.repair_value + split.bags_value)) }}
                  </p>
                </div>
              </div>

              <!-- Participant Count & Info -->
              <div class="flex items-center justify-between text-xs text-secondary mb-4">
                <span class="inline-flex items-center gap-1">
                  <app-icon name="users" size="0.9rem" />
                  <strong>{{ split.participant_count }}</strong> {{ t('splits.participants') }}
                </span>
                @if (split.finalized_at) {
                  <span class="mono text-success">
                    Finalized {{ formatDate(split.finalized_at) }}
                  </span>
                }
              </div>
            </div>

            <!-- Card Actions -->
            <footer class="border-t pt-3 flex flex-wrap items-center justify-between gap-2" style="border-color: var(--color-border)">
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  (click)="$event.stopPropagation(); openSplit(split.id)"
                >
                  {{ t('splits.view_details') }}
                </button>
                @if (canAct() && split.status === 'pending') {
                  <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    (click)="$event.stopPropagation(); openEditSplitModal(split.id)"
                  >
                    {{ t('splits.edit') }}
                  </button>
                }
              </div>

              <!-- Quick Status Actions -->
              @if (canAct() && split.status === 'pending') {
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    [title]="t('splits.payout_complete')"
                    (click)="$event.stopPropagation(); close(split.id, 'complete')"
                  >
                    Pay
                  </button>
                  <button
                    type="button"
                    class="btn btn--danger btn--sm"
                    [title]="t('splits.mark_lost')"
                    (click)="$event.stopPropagation(); close(split.id, 'lost')"
                  >
                    Lost
                  </button>
                </div>
              }
            </footer>
          </article>
        }
      </section>

      <!-- Pagination -->
      <footer class="mt-6 flex items-center justify-between">
        <p class="text-xs text-secondary">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="page() <= 1"
            (click)="prev()"
          >
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </footer>
    }

    <!-- ================= DEDICATED EDIT SPLIT MODAL ================= -->
    @if (editingSplit(); as split) {
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm overflow-y-auto">
        <section class="card w-full max-w-3xl p-5 border-2 my-auto" style="border-color: var(--color-primary)" role="dialog" aria-modal="true">
          <header class="mb-4 flex items-start justify-between gap-3 border-b pb-3" style="border-color: var(--color-border)">
            <div>
              <div class="flex items-center gap-2">
                <span class="chip chip--primary font-mono text-xs">EDITING SPLIT #{{ split.id }}</span>
                <h2 class="text-xl font-bold" style="color: var(--color-text)">
                  {{ t('splits.edit') }}
                </h2>
              </div>
              <p class="text-xs text-secondary mt-1">
                {{ t('splits.edit_subtitle') }}
              </p>
            </div>
            <button type="button" class="btn btn--ghost" (click)="closeEditModal()">
              <app-icon name="close" size="1.1rem" />
            </button>
          </header>

          <form (submit)="onEditSubmit($event, split.id)" class="space-y-4">
            <!-- Split Note / Title -->
            <label class="block">
              <span class="label font-medium">{{ t('common.name') }} / Note</span>
              <input
                class="input"
                type="text"
                [value]="editNote()"
                (input)="onEditNoteChange($event)"
                placeholder="Split description / objective"
              />
            </label>

            <!-- Linked Event Selection -->
            <div>
              <span class="label font-medium">{{ t('splits.event_linked') }}</span>
              <div class="flex items-center gap-2">
                <div class="flex-1 input flex items-center bg-[var(--color-surface-1)]">
                  <span class="truncate">{{ editEventTitle() || t('splits.no_event') }}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--outline whitespace-nowrap"
                  (click)="showEditEventSearch.set(true)"
                >
                  {{ t('splits.link_event') }}
                </button>
                @if (editEventId()) {
                  <button
                    type="button"
                    class="btn btn--danger whitespace-nowrap"
                    [title]="t('splits.unlink_event')"
                    (click)="unlinkEditEvent()"
                  >
                    <app-icon name="close" size="1rem" />
                  </button>
                }
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="label font-medium">{{ t('splits.island') }}</span>
                <select class="select" [value]="editIslandId()" (change)="onEditIslandChange($event)">
                  <option value="">{{ t('splits.pick_island') }}</option>
                  @for (island of islands(); track island.id) {
                    <option [value]="island.id">{{ cityLabel(island.city) }} · {{ island.name }}</option>
                  }
                </select>
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.tab') }}</span>
                <select
                  class="select"
                  [value]="editTabId()"
                  [disabled]="!editIslandId()"
                  (change)="onEditTabChange($event)"
                >
                  <option value="">{{ t('splits.pick_tab') }}</option>
                  @for (tab of editIslandTabs(); track tab.id) {
                    <option [value]="tab.id">{{ tab.name }}</option>
                  }
                </select>
              </label>
            </div>

            <!-- Financial Inputs -->
            <div class="grid gap-3 sm:grid-cols-3">
              <label class="block">
                <span class="label font-medium">{{ t('splits.estimated') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="editEstimated()"
                  (input)="onEditEstimatedChange($event)"
                />
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.repair_cost') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="editRepair()"
                  (input)="onEditRepairChange($event)"
                />
              </label>
              <label class="block">
                <span class="label font-medium">{{ t('splits.bags_value') }}</span>
                <input
                  class="input mono"
                  type="number"
                  min="0"
                  [value]="editBags()"
                  (input)="onEditBagsChange($event)"
                />
              </label>
            </div>

            <!-- Live Net Value Formula Banner -->
            <div class="surface p-3 rounded-lg border flex items-center justify-between" style="border-color: var(--color-border)">
              <div>
                <p class="text-xs text-disabled uppercase font-semibold">{{ t('splits.net_value') }}</p>
                <p class="text-xs text-secondary">
                  {{ formatAmount(editEstimated()) }} - {{ formatAmount(editRepair()) }} + {{ formatAmount(editBags()) }}
                </p>
              </div>
              <p class="text-xl font-bold mono text-success">
                {{ formatAmount(editNetPreview()) }}
              </p>
            </div>

            <!-- Participant Roster & Weight Rebalancing -->
            <div class="surface p-4 rounded-lg space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2" style="border-color: var(--color-border)">
                <div>
                  <h3 class="font-semibold text-sm" style="color: var(--color-text)">
                    {{ t('splits.roster_management') }} ({{ editParticipants().length }})
                  </h3>
                  <p class="text-xs text-secondary">Manage members and relative payout weights</p>
                </div>
                <div class="flex items-center gap-2">
                  <span
                    class="chip mono font-bold"
                    [class.chip--success]="editTotalWeight() === 100"
                    [class.chip--warning]="editTotalWeight() !== 100"
                  >
                    {{ editTotalWeight() }}%
                  </span>
                  @if (editParticipants().length > 0) {
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      (click)="distributeEditWeightsEvenly()"
                    >
                      {{ t('splits.distribute_evenly') }}
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    (click)="openParticipantDialog()"
                  >
                    + {{ t('splits.add_participant') }}
                  </button>
                </div>
              </div>

              <div class="grid gap-2 max-h-64 overflow-y-auto pr-1 scrollbar-thin">
                @for (participant of editParticipants(); track participant.user_id) {
                  <article class="card p-2.5 flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium text-sm truncate" style="color: var(--color-text)">
                        {{ participant.username }}
                      </p>
                      <p class="text-xs text-secondary truncate">
                        Share:
                        <strong class="mono text-success">
                          {{ formatAmount(calculateEstimatedShare(editNetPreview(), participant.weight, editTotalWeight())) }}
                        </strong>
                      </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <label class="flex items-center gap-1">
                        <input
                          class="input mono text-sm"
                          style="width: 4.5rem; text-align: right"
                          type="number"
                          min="1"
                          max="100"
                          [value]="participant.weight"
                          (input)="onEditWeightChange(participant.user_id, $event)"
                        />
                        <span class="text-xs text-secondary">%</span>
                      </label>
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm text-error"
                        (click)="removeEditParticipant(split.id, participant.user_id)"
                        aria-label="Remove participant"
                      >
                        <app-icon name="close" size="0.875rem" />
                      </button>
                    </div>
                  </article>
                } @empty {
                  <p class="text-center text-xs text-secondary py-4">No participants in split.</p>
                }
              </div>
            </div>

            <!-- Modal Actions -->
            <footer class="flex items-center justify-between border-t pt-4" style="border-color: var(--color-border)">
              <button
                type="button"
                class="btn btn--danger btn--sm"
                (click)="deleteSplit(split.id)"
              >
                {{ t('common.delete') }}
              </button>
              <div class="flex items-center gap-2">
                <button type="button" class="btn btn--ghost" (click)="closeEditModal()">
                  {{ t('common.cancel') }}
                </button>
                <button
                  type="submit"
                  class="btn btn--primary"
                  [disabled]="saving()"
                >
                  {{ saving() ? t('common.loading') : t('common.save') }}
                </button>
              </div>
            </footer>
          </form>
        </section>
      </div>
    }

    <!-- ================= FULL SPLIT INSPECTOR DETAIL MODAL ================= -->
    @if (selectedSplit(); as detail) {
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm overflow-y-auto">
        <section class="card w-full max-w-3xl p-6 my-auto" role="dialog" aria-modal="true">
          <header class="mb-4 flex items-start justify-between gap-3 border-b pb-4" style="border-color: var(--color-border)">
            <div>
              <div class="flex items-center gap-2 mb-1">
                <h2 class="text-2xl font-bold" style="color: var(--color-text)">
                  {{ detail.note || 'Split #' + detail.id }}
                </h2>
                <span class="chip font-mono text-xs uppercase" [class]="statusChip(detail.status)">
                  {{ detail.status }}
                </span>
              </div>
              <p class="text-xs text-secondary">
                Created by <strong class="text-foreground">{{ detail.created_by_username }}</strong> on {{ formatDate(detail.created_at) }}
                @if (detail.event_title) {
                  · Event: <a class="text-primary font-medium no-underline hover:underline" [routerLink]="['/events', detail.event_id]">{{ detail.event_title }}</a>
                }
                @if (detail.island_tab_id) {
                  · {{ locationLabel(detail) }}
                }
              </p>
            </div>
            <div class="flex items-center gap-2">
              @if (canAct() && detail.status === 'pending') {
                <button
                  type="button"
                  class="btn btn--primary btn--sm"
                  (click)="openEditSplitModal(detail.id)"
                >
                  {{ t('splits.edit') }}
                </button>
              }
              <button type="button" class="btn btn--ghost" (click)="closeSplitDetail()">
                <app-icon name="close" size="1.1rem" />
              </button>
            </div>
          </header>

          <!-- Financial Overview Cards -->
          <div class="grid gap-3 grid-cols-2 sm:grid-cols-4 mb-5">
            <div class="surface p-3 rounded-lg">
              <p class="text-xs text-disabled uppercase">{{ t('splits.estimated') }}</p>
              <p class="font-bold text-base mono text-warning">
                {{ formatAmount(detail.estimated_market_value) }}
              </p>
            </div>
            <div class="surface p-3 rounded-lg">
              <p class="text-xs text-disabled uppercase">{{ t('splits.repair_cost') }}</p>
              <p class="font-bold text-base mono text-error">
                -{{ formatAmount(detail.repair_value) }}
              </p>
            </div>
            <div class="surface p-3 rounded-lg">
              <p class="text-xs text-disabled uppercase">{{ t('splits.bags_value') }}</p>
              <p class="font-bold text-base mono">
                +{{ formatAmount(detail.bags_value) }}
              </p>
            </div>
            <div class="surface p-3 rounded-lg border-2" style="border-color: var(--color-success)">
              <p class="text-xs text-disabled uppercase">{{ t('splits.net_value') }}</p>
              <p class="font-bold text-base mono text-success">
                {{ formatAmount(detail.net_value ?? (detail.estimated_market_value - detail.repair_value + detail.bags_value)) }}
              </p>
            </div>
          </div>

          <!-- Participants Table -->
          <div class="surface rounded-lg overflow-hidden border mb-5" style="border-color: var(--color-border)">
            <header class="p-3 border-b flex items-center justify-between" style="border-color: var(--color-border)">
              <h3 class="font-semibold text-sm" style="color: var(--color-text)">
                {{ t('splits.participants') }} ({{ detail.participants.length }})
              </h3>
              @if (detail.status === 'pending') {
                <span class="text-xs text-warning mono">
                  Pending Payout
                </span>
              } @else {
                <span class="text-xs text-success mono">
                  Paid Out
                </span>
              }
            </header>
            <div class="overflow-x-auto">
              <table class="table w-full text-sm">
                <thead>
                  <tr class="text-xs uppercase text-secondary">
                    <th class="p-3 text-left">Player</th>
                    <th class="p-3 text-right">Weight</th>
                    <th class="p-3 text-right">Payout Share</th>
                  </tr>
                </thead>
                <tbody>
                  @for (participant of detail.participants; track participant.user_id) {
                    <tr class="border-t" style="border-color: var(--color-border)">
                      <td class="p-3 font-medium">{{ participant.username }}</td>
                      <td class="p-3 text-right mono">{{ participant.weight }}%</td>
                      <td class="p-3 text-right mono font-bold text-success">
                        {{ formatAmount(participant.share_amount ?? calculateEstimatedShare(detail.net_value ?? (detail.estimated_market_value - detail.repair_value + detail.bags_value), participant.weight, 100)) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>

          <!-- Footer Actions -->
          <footer class="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style="border-color: var(--color-border)">
            @if (canAct()) {
              <button type="button" class="btn btn--danger btn--sm" (click)="deleteSplit(detail.id)">
                {{ t('common.delete') }}
              </button>
            } @else {
              <div></div>
            }

            <div class="flex flex-wrap items-center gap-2">
              @if (detail.status === 'pending' && canAct()) {
                <button
                  type="button"
                  class="btn btn--primary"
                  (click)="close(detail.id, 'complete')"
                >
                  {{ t('splits.payout_complete') }}
                </button>
                <button
                  type="button"
                  class="btn btn--outline"
                  (click)="close(detail.id, 'not-completed')"
                >
                  {{ t('splits.mark_not_completed') }}
                </button>
                <button
                  type="button"
                  class="btn btn--danger"
                  (click)="close(detail.id, 'lost')"
                >
                  {{ t('splits.mark_lost') }}
                </button>
              }
              <button type="button" class="btn btn--ghost" (click)="closeSplitDetail()">
                {{ t('common.close') }}
              </button>
            </div>
          </footer>
        </section>
      </div>
    }

    <!-- Participant Search Dialog -->
    @if (isParticipantDialogOpen()) {
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
        <section class="card w-full max-w-lg p-5" role="dialog" aria-modal="true">
          <header class="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 class="text-lg font-semibold" style="color: var(--color-text)">
                {{ t('splits.add_participant') }}
              </h3>
              <p class="text-xs text-secondary">
                Search the Albion roster to find linked guild members.
              </p>
            </div>
            <button type="button" class="btn btn--ghost" (click)="closeParticipantDialog()">
              <app-icon name="close" size="1rem" />
            </button>
          </header>

          <form class="mb-4 flex gap-2" (submit)="onParticipantSearchSubmit($event)">
            <input
              class="input flex-1"
              type="text"
              [value]="participantSearch()"
              (input)="onParticipantSearchChange($event)"
              placeholder="Search Albion player name..."
              autofocus
            />
            <button type="submit" class="btn btn--primary" [disabled]="searchingRoster()">
              Search
            </button>
          </form>

          @if (searchingRoster()) {
            <app-loading [label]="t('common.loading')" />
          } @else if (participantRoster().length === 0) {
            <app-empty-state [message]="'Type a name and press search'" icon="search" />
          } @else {
            <div class="grid max-h-80 gap-1.5 overflow-y-auto pr-1 scrollbar-thin">
              @for (member of participantRoster(); track member.id) {
                <button
                  type="button"
                  class="surface flex items-center justify-between gap-3 p-3 rounded text-left transition-colors hover:bg-surface-2"
                  (click)="addRosterMember(member)"
                >
                  <span class="font-medium text-sm" style="color: var(--color-text)">{{ member.name }}</span>
                  <span class="chip chip--primary text-xs py-0.5 px-2">Add to roster</span>
                </button>
              }
            </div>
          }
        </section>
      </div>
    }

    <!-- Event Search Dialogs -->
    @if (showEventSearch()) {
      <app-search-dialog
        title="Link Event"
        [options]="eventSearchOptions()"
        [loading]="eventSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onEventSearchFilter($event)"
        (select)="onDraftEventSelect($event)"
        (close)="showEventSearch.set(false)"
      />
    }

    @if (showEditEventSearch()) {
      <app-search-dialog
        title="Link Event"
        [options]="eventSearchOptions()"
        [loading]="eventSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onEventSearchFilter($event)"
        (select)="onEditEventSelect($event)"
        (close)="showEditEventSearch.set(false)"
      />
    }
  `,
  styles: `
    @layer components {
      .splits__label {
        color: var(--color-text-disabled);
        font-size: 0.72rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .splits__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.65rem);
        font-weight: 700;
        font-family: var(--font-mono);
      }
      .splits__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .splits__card {
        border: 1px solid var(--color-border);
      }
      .splits__card:hover {
        border-color: var(--color-primary);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }
    }
  `,
})
export class Splits {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly splits = signal<SplitSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);

  // Filter signals
  protected readonly statusFilter = signal<SplitStatus | ''>('');
  protected readonly searchQuery = signal<string>('');
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);

  // Batch action selection
  private readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly batchRunning = signal(false);

  // Create form state
  protected readonly showCreateForm = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftEventId = signal('');
  protected readonly draftEventTitle = signal('');
  protected readonly draftEstimated = signal(0);
  protected readonly draftRepair = signal(0);
  protected readonly draftBags = signal(0);
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  protected readonly rawNames = signal('');
  protected readonly participants = signal<SplitParticipantDraft[]>([]);
  protected readonly weightsCustomized = signal(false);
  protected readonly saving = signal(false);
  protected readonly matching = signal(false);

  // Inspector & Edit Modal state
  protected readonly selectedSplit = signal<SplitDetail | null>(null);
  protected readonly editingSplit = signal<SplitDetail | null>(null);
  protected readonly editNote = signal('');
  protected readonly editEstimated = signal(0);
  protected readonly editRepair = signal(0);
  protected readonly editBags = signal(0);
  protected readonly editEventId = signal<number | null>(null);
  protected readonly editEventTitle = signal('');
  protected readonly editIslandId = signal('');
  protected readonly editTabId = signal('');
  protected readonly editParticipants = signal<SplitParticipant[]>([]);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly islandFilter = signal('');
  protected readonly catalogSaving = signal(false);
  protected readonly newIslandCity = signal<SplitIslandCity>('lymhurst');
  protected readonly newIslandName = signal('');
  protected readonly newIslandTabs = signal('');
  protected readonly newTabNameByIsland = signal<Record<number, string>>({});
  protected readonly islandCities = ISLAND_CITIES;

  // Participant Search Dialog
  protected readonly isParticipantDialogOpen = signal(false);
  protected readonly participantSearch = signal('');
  protected readonly participantRoster = signal<AlbionGuildMember[]>([]);
  protected readonly searchingRoster = signal(false);

  // Event Search Dialog
  protected readonly showEventSearch = signal(false);
  protected readonly showEditEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  // Computed KPIs
  protected readonly pendingSplits = computed(() =>
    this.splits().filter((s) => s.status === 'pending'),
  );

  protected readonly completedSplitsCount = computed(() =>
    this.splits().filter((s) => s.status === 'completed').length,
  );

  protected readonly totalNetDistributed = computed(() => {
    return this.splits()
      .filter((s) => s.status === 'completed')
      .reduce((sum, s) => sum + (s.net_value ?? (s.estimated_market_value - s.repair_value + s.bags_value)), 0);
  });

  protected readonly totalEstimatedVolume = computed(() => {
    return this.splits().reduce((sum, s) => sum + s.estimated_market_value, 0);
  });

  protected readonly totalParticipantsCount = computed(() => {
    return this.splits().reduce((sum, s) => sum + s.participant_count, 0);
  });

  // Filtered splits
  protected readonly filteredSplits = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    let list = this.splits();
    if (query) {
      list = list.filter(
        (s) =>
          (s.note && s.note.toLowerCase().includes(query)) ||
          s.created_by_username.toLowerCase().includes(query) ||
          (s.event_title && s.event_title.toLowerCase().includes(query)),
      );
    }
    return list;
  });

  // Real-time net preview calculations
  protected readonly draftNetPreview = computed(() => {
    return Math.max(0, this.draftEstimated() - this.draftRepair() + this.draftBags());
  });

  protected readonly editNetPreview = computed(() => {
    return Math.max(0, this.editEstimated() - this.editRepair() + this.editBags());
  });

  protected readonly selectedCount = computed(() => this.selectedIds().size);

  protected readonly allPendingSelected = computed(() => {
    const pending = this.pendingSplits();
    return pending.length > 0 && pending.every((split) => this.selectedIds().has(split.id));
  });

  constructor() {
    void this.load();
    void this.loadIslands();
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
  }

  protected canAct(): boolean {
    return this.auth.hasPermission('splits.manage');
  }

  protected canManageIslands(): boolean {
    return this.auth.hasPermission('splits.islands.manage');
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected locationLabel(split: SplitSummary): string {
    if (!split.island_tab_id || !split.island_name || !split.island_city || !split.island_tab_name) {
      return this.t('splits.no_location');
    }
    return `${this.cityLabel(split.island_city as SplitIslandCity)} · ${split.island_name} · ${split.island_tab_name}`;
  }

  protected readonly draftIslandTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });

  protected readonly editIslandTabs = computed(() => {
    const id = Number(this.editIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });

  protected totalWeight(): number {
    return this.participants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected editTotalWeight(): number {
    return this.editParticipants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected calculateEstimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) return 0;
    return Math.round((netValue * (weight / totalWeight)) * 100) / 100;
  }

  // Filter Actions
  protected setStatusFilter(status: SplitStatus | ''): void {
    this.statusFilter.set(status);
    this.page.set(1);
    void this.load();
  }

  protected onSearchQueryChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  // Create Form Handlers
  protected toggleCreateForm(): void {
    this.showCreateForm.update((v) => !v);
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onEstimatedChange(event: Event): void {
    this.draftEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onRepairChange(event: Event): void {
    this.draftRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onBagsChange(event: Event): void {
    this.draftBags.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onRawNamesChange(event: Event): void {
    this.rawNames.set((event.target as HTMLTextAreaElement).value);
  }

  protected onWeightChange(userId: number, event: Event): void {
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
    this.weightsCustomized.set(true);
    this.participants.update((list) =>
      list.map((p) => (p.user_id === userId ? { ...p, weight } : p)),
    );
  }

  protected distributeDraftWeightsEvenly(): void {
    this.weightsCustomized.set(false);
    this.participants.set(this.redistributeWeights(this.participants()));
  }

  protected removeParticipant(userId: number): void {
    const next = this.participants().filter((p) => p.user_id !== userId);
    this.participants.set(this.weightsCustomized() ? next : this.redistributeWeights(next));
  }

  protected clearParticipants(): void {
    this.rawNames.set('');
    this.participants.set([]);
    this.weightsCustomized.set(false);
  }

  // Edit Modal Handlers
  protected async openEditSplitModal(splitId: number): Promise<void> {
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${splitId}`));
      this.editingSplit.set(detail);
      this.editNote.set(detail.note || '');
      this.editEstimated.set(Number(detail.estimated_market_value) || 0);
      this.editRepair.set(Number(detail.repair_value) || 0);
      this.editBags.set(Number(detail.bags_value) || 0);
      this.editEventId.set(detail.event_id ?? null);
      this.editEventTitle.set(detail.event_title || '');
      this.editIslandId.set(detail.island_id ? String(detail.island_id) : '');
      this.editTabId.set(detail.island_tab_id ? String(detail.island_tab_id) : '');
      this.editParticipants.set([...detail.participants]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected closeEditModal(): void {
    this.editingSplit.set(null);
  }

  protected onEditNoteChange(event: Event): void {
    this.editNote.set((event.target as HTMLInputElement).value);
  }

  protected onEditEstimatedChange(event: Event): void {
    this.editEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onEditRepairChange(event: Event): void {
    this.editRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onEditBagsChange(event: Event): void {
    this.editBags.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected onEditWeightChange(userId: number, event: Event): void {
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
    this.editParticipants.update((list) =>
      list.map((p) => (p.user_id === userId ? { ...p, weight } : p)),
    );
  }

  protected distributeEditWeightsEvenly(): void {
    const list = this.editParticipants();
    if (list.length === 0) return;
    const baseWeight = Math.floor(100 / list.length);
    this.editParticipants.set(
      list.map((p, index) => ({
        ...p,
        weight: index === list.length - 1 ? 100 - baseWeight * index : baseWeight,
      })),
    );
  }

  protected async removeEditParticipant(splitId: number, userId: number): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.api.delete<SplitDetail>(`api/splits/${splitId}/participants/${userId}`),
      );
      const detail = res as SplitDetail | undefined;
      if (detail && detail.participants) {
        this.editParticipants.set([...detail.participants]);
        if (this.selectedSplit()?.id === splitId) {
          this.selectedSplit.set(detail);
        }
      } else {
        this.editParticipants.update((list) => list.filter((p) => p.user_id !== userId));
      }
      await this.load();
      this.toasts.success('Participant removed');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async onEditSubmit(event: SubmitEvent, splitId: number): Promise<void> {
    event.preventDefault();
    this.saving.set(true);
    try {
      // 1. Update split general values & event
      const request: UpdateSplitRequest = {
        note: this.editNote().trim(),
        estimated_market_value: this.editEstimated(),
        repair_value: this.editRepair(),
        bags_value: this.editBags(),
        event_id: this.editEventId(),
        island_tab_id: this.editTabId() ? Number(this.editTabId()) : undefined,
      };

      let detail = await firstValueFrom(
        this.api.patch<SplitDetail>(`api/splits/${splitId}`, request),
      );

      // 2. Synchronize participant weights
      for (const p of this.editParticipants()) {
        detail = await firstValueFrom(
          this.api.post<SplitDetail>(`api/splits/${splitId}/participants`, {
            user_id: p.user_id,
            weight: p.weight,
          }),
        );
      }

      this.editingSplit.set(null);
      if (this.selectedSplit()?.id === splitId) {
        this.selectedSplit.set(detail);
      }
      await this.load();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  // Participant Search & Add
  protected openParticipantDialog(): void {
    this.isParticipantDialogOpen.set(true);
  }

  protected closeParticipantDialog(): void {
    this.isParticipantDialogOpen.set(false);
    this.participantSearch.set('');
    this.participantRoster.set([]);
  }

  protected onParticipantSearchChange(event: Event): void {
    this.participantSearch.set((event.target as HTMLInputElement).value);
  }

  protected onParticipantSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.searchParticipantRoster();
  }

  private async searchParticipantRoster(): Promise<void> {
    const query = this.participantSearch().trim();
    if (!query) {
      this.toasts.error(this.t('validation.required'));
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
      this.participantRoster.set(rosterPage.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected async addRosterMember(member: AlbionGuildMember): Promise<void> {
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', {
          names: [member.name],
        }),
      );
      const draft = this.toDraftParticipants(matched).at(0);
      if (!draft) {
        this.toasts.error('This Albion character is not linked to an app user.');
        return;
      }

      // If in editing modal
      const editing = this.editingSplit();
      if (editing) {
        const detail = await firstValueFrom(
          this.api.post<SplitDetail>(`api/splits/${editing.id}/participants`, {
            user_id: draft.user_id,
            weight: 1,
          }),
        );
        this.editParticipants.set([...detail.participants]);
        if (this.selectedSplit()?.id === editing.id) {
          this.selectedSplit.set(detail);
        }
        await this.load();
        this.toasts.success(`${draft.raw_name} added to split`);
        this.closeParticipantDialog();
        return;
      }

      // If in draft create form
      if (this.participants().some((p) => p.user_id === draft.user_id)) {
        this.toasts.info(`${draft.raw_name} is already in the roster.`);
        this.closeParticipantDialog();
        return;
      }

      this.participants.set(
        this.weightsCustomized()
          ? [...this.participants(), draft]
          : this.redistributeWeights([...this.participants(), draft]),
      );
      this.closeParticipantDialog();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  // Screenshot OCR
  protected async onScreenshotChange(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.item(0);
    if (!file) return;

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
      .map((n) => n.trim())
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
      this.participants.set(this.redistributeWeights(this.toDraftParticipants(matched)));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.matching.set(false);
    }
  }

  // Create Submit
  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createSplit();
  }

  private async createSplit(): Promise<void> {
    const title = this.draftTitle().trim();
    const finalParticipants = this.participants();

    if (!title || finalParticipants.length === 0 || !this.draftTabId()) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.saving.set(true);
    try {
      const request: CreateSplitRequest = {
        note: title,
        estimated_market_value: this.draftEstimated(),
        repair_value: this.draftRepair(),
        bags_value: this.draftBags(),
        event_id: this.draftEventId() ? Number(this.draftEventId()) : undefined,
        island_tab_id: Number(this.draftTabId()),
        participants: finalParticipants.map((p) => ({
          user_id: p.user_id,
          weight: p.weight,
        })),
      };

      await firstValueFrom(this.api.post<SplitDetail>('api/splits', request));
      this.resetCreateForm();
      await this.load();
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
    this.draftRepair.set(0);
    this.draftBags.set(0);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.rawNames.set('');
    this.participants.set([]);
    this.showCreateForm.set(false);
  }

  // Inspector Modal
  protected async openSplit(splitId: number): Promise<void> {
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${splitId}`));
      this.selectedSplit.set(detail);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected closeSplitDetail(): void {
    this.selectedSplit.set(null);
  }

  protected async deleteSplit(id: number): Promise<void> {
    if (!confirm(this.t('common.confirm'))) return;
    try {
      await firstValueFrom(this.api.delete(`api/splits/${id}`));
      this.toasts.success(this.t('common.delete'));
      this.closeSplitDetail();
      this.closeEditModal();
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async close(id: number, action: 'complete' | 'not-completed' | 'lost'): Promise<void> {
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${id}/${action}`, {}),
      );
      this.selectedSplit.set(detail);
      this.toasts.success(action);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  // Batch Actions
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
    const next: ReadonlySet<number> = checked
      ? new Set<number>(this.pendingSplits().map((split) => split.id))
      : new Set<number>();
    this.selectedIds.set(next);
  }

  protected async completeSelected(): Promise<void> {
    const ids = [...this.selectedIds()];
    if (ids.length === 0) return;
    this.batchRunning.set(true);
    try {
      const result = await firstValueFrom(
        this.api.post<CompleteSplitsBatchResult>('api/splits/complete-batch', {
          split_ids: ids,
        }),
      );
      this.selectedIds.set(new Set<number>());
      if (result.completed.length > 0) {
        this.toasts.success(
          `${result.completed.length} ${this.t('splits.batch.completed')}`,
        );
      }
      for (const failure of result.failed) {
        this.toasts.error(`Split #${failure.split_id}: ${failure.reason}`);
      }
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.batchRunning.set(false);
    }
  }

  // Event Linking
  protected async onEventSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.eventSearchLoading.set(true);
    try {
      const params: Record<string, string> = { page: '1', limit: '50' };
      if (filters.search) params['search'] = filters.search;
      if (filters.dateFrom) params['date_from'] = filters.dateFrom;
      if (filters.dateTo) params['date_to'] = filters.dateTo;

      const res = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('/api/events', params),
      );
      this.eventSearchOptions.set(
        res.items.map((e) => ({
          id: e.id,
          title: e.title,
          subtitle: this.formatDate(e.event_date_utc),
          chip: e.status,
        })),
      );
    } catch (err) {
      this.toasts.error(err instanceof Error ? err.message : this.t('common.error'));
    } finally {
      this.eventSearchLoading.set(false);
    }
  }

  protected onDraftEventSelect(opt: SearchDialogOption): void {
    this.draftEventId.set(String(opt.id));
    this.draftEventTitle.set(opt.title);
    this.showEventSearch.set(false);
  }

  protected unlinkDraftEvent(): void {
    this.draftEventId.set('');
    this.draftEventTitle.set('');
  }

  protected onEditEventSelect(opt: SearchDialogOption): void {
    this.editEventId.set(Number(opt.id));
    this.editEventTitle.set(opt.title);
    this.showEditEventSearch.set(false);
  }

  protected unlinkEditEvent(): void {
    this.editEventId.set(null);
    this.editEventTitle.set('');
  }

  // Pagination
  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) return;
    this.page.update((p) => p + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) return;
    this.page.update((p) => p - 1);
    await this.load();
  }

  // Helpers
  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString();
  }

  protected formatCompact(value: number | string | null | undefined): string {
    if (value === null || value === undefined) return '0';
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      Number(value),
    );
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected statusChip(status: SplitStatus): string {
    switch (status) {
      case 'completed':
        return 'chip--success';
      case 'pending':
        return 'chip--warning';
      case 'lost':
        return 'chip--error';
      default:
        return 'chip--info';
    }
  }

  private toDraftParticipants(matched: MatchedParticipant[]): SplitParticipantDraft[] {
    return matched.map((participant) => ({
      raw_name: participant.matched_name,
      user_id: participant.user_id,
      username: participant.username,
      weight: 1,
    }));
  }

  private redistributeWeights(participants: SplitParticipantDraft[]): SplitParticipantDraft[] {
    if (participants.length === 0) return [];
    const baseWeight = Math.floor(100 / participants.length);
    return participants.map((participant, index) => ({
      ...participant,
      weight: index === participants.length - 1 ? 100 - baseWeight * index : baseWeight,
    }));
  }

  protected onDraftIslandChange(event: Event): void {
    this.draftIslandId.set((event.target as HTMLSelectElement).value);
    this.draftTabId.set('');
  }

  protected onDraftTabChange(event: Event): void {
    this.draftTabId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditIslandChange(event: Event): void {
    this.editIslandId.set((event.target as HTMLSelectElement).value);
    this.editTabId.set('');
  }

  protected onEditTabChange(event: Event): void {
    this.editTabId.set((event.target as HTMLSelectElement).value);
  }

  protected onIslandFilterChange(event: Event): void {
    this.islandFilter.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
    void this.load();
  }

  protected onNewIslandCity(event: Event): void {
    this.newIslandCity.set((event.target as HTMLSelectElement).value as SplitIslandCity);
  }

  protected onNewIslandName(event: Event): void {
    this.newIslandName.set((event.target as HTMLInputElement).value);
  }

  protected onNewIslandTabs(event: Event): void {
    this.newIslandTabs.set((event.target as HTMLInputElement).value);
  }

  protected onNewTabName(islandId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newTabNameByIsland.update((current) => ({ ...current, [islandId]: value }));
  }

  protected async onCreateIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = this.newIslandName().trim();
    const tabs = this.newIslandTabs()
      .split(',')
      .map((tab) => tab.trim())
      .filter((tab) => tab.length > 0);
    if (!name || tabs.length === 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    this.catalogSaving.set(true);
    try {
      await firstValueFrom(
        this.api.post<SplitIsland>('api/splits/islands', {
          name,
          city: this.newIslandCity(),
          tabs,
        }),
      );
      this.newIslandName.set('');
      this.newIslandTabs.set('');
      await this.loadIslands();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.catalogSaving.set(false);
    }
  }

  protected async onAddTab(event: SubmitEvent, islandId: number): Promise<void> {
    event.preventDefault();
    const name = (this.newTabNameByIsland()[islandId] ?? '').trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    try {
      await firstValueFrom(
        this.api.post<SplitIsland>(`api/splits/islands/${islandId}/tabs`, { name }),
      );
      this.newTabNameByIsland.update((current) => ({ ...current, [islandId]: '' }));
      await this.loadIslands();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async deleteIsland(islandId: number): Promise<void> {
    if (!confirm(this.t('common.confirm'))) return;
    try {
      await firstValueFrom(this.api.delete(`api/splits/islands/${islandId}`));
      await this.loadIslands();
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async loadIslands(): Promise<void> {
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      this.islands.set(islands);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const filter = this.statusFilter();
      const params: Record<string, string | number> = { page: this.page(), limit: PAGE_SIZE };
      if (filter) {
        params['status'] = filter;
      }
      if (this.islandFilter()) {
        params['island_id'] = Number(this.islandFilter());
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<SplitSummary>>('api/splits', params),
      );
      this.splits.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
