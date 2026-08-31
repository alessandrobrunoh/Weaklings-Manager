import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
import { StatusChip } from '../../shared/components/status-chip/status-chip';

import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const SORT_WHITELIST = new Set(['created_at', 'status', 'note']);

interface SplitParticipantDraft {
  readonly raw_name: string;
  readonly user_id: number;
  readonly username: string;
  weight: number;
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
    StatCard,
    StatusChip,
    TooltipDirective,
  ],
  template: `
    <app-page-header [title]="t('splits.title')" [subtitle]="t('splits.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="'Aggiorna elenco split'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canManageIslands()) {
        <a
          routerLink="/admin/islands"
          class="btn btn--ghost btn--sm"
          [appTooltip]="'Gestisci catalogo isole e chest'"
          tooltipPosition="bottom"
        >{{ t('splits.catalog.manage') }}</a>
      }
      <button
        type="button"
        class="btn btn--primary btn--sm flex items-center gap-2"
        (click)="openCreateDialog()"
        [appTooltip]="'Crea nuova divisione di bottino'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="1.1rem" />
        {{ t('splits.new') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Split KPI Summary">
        <app-stat-card
          [label]="t('splits.total_distributed')"
          [value]="formatCompact(kpi()?.total_net_distributed ?? 0)"
          [sub]="t('splits.kpi.completed_across', { count: kpi()?.completed_count ?? 0 })"
          icon="bank"
          tone="success"
        />
        <app-stat-card
          [label]="t('splits.pending_splits')"
          [value]="(kpi()?.pending_count ?? 0).toString()"
          [sub]="t('splits.kpi.pending_sub')"
          icon="alert"
          tone="warning"
        />
        <app-stat-card
          [label]="t('splits.total_silver_volume')"
          [value]="formatCompact(kpi()?.total_estimated_volume ?? 0)"
          [sub]="t('splits.kpi.volume_sub')"
          icon="chart"
        />
        <app-stat-card
          [label]="t('splits.participants')"
          [value]="(kpi()?.total_participants ?? 0).toString()"
          [sub]="t('splits.kpi.recipients_sub')"
          icon="users"
          tone="primary"
        />
      </section>

      @if (canAct() && pendingSplits().length > 0) {
        <section
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 surface"
          style="border-color: var(--color-border); background-color: var(--color-surface-2)"
        >
          <label class="flex cursor-pointer select-none items-center gap-2 text-sm">
            <input
              class="checkbox"
              type="checkbox"
              [checked]="allPendingSelected()"
              (change)="toggleAllPending($event)"
            />
            <span>
              {{ t('splits.batch.select') }}
              @if (selectedCount() > 0) {
                <strong class="font-mono text-primary">
                  ({{ t('splits.batch.selected', { count: selectedCount() }) }})
                </strong>
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
        emptyIcon="swords"
      >
        <ng-template dataTableCell="select" let-row>
          @if (canAct() && row.status === 'pending') {
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
          <span class="font-medium">{{ row.note || t('splits.untitled', { id: row.id }) }}</span>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <app-status-chip [value]="row.status" />
        </ng-template>
        <ng-template dataTableCell="island" let-row>
          {{ locationLabel(row) }}
        </ng-template>
        <ng-template dataTableCell="event" let-row>
          @if (row.event_id && row.event_title) {
            <a
              class="text-primary no-underline hover:underline"
              [routerLink]="['/events', row.event_id]"
              (click)="$event.stopPropagation()"
            >
              {{ row.event_title }}
            </a>
          } @else {
            <span style="color: var(--color-text-secondary)">{{ t('splits.no_event') }}</span>
          }
        </ng-template>
        <ng-template dataTableCell="net" let-row>
          <span class="mono font-semibold text-success">{{ formatAmount(netOf(row)) }}</span>
        </ng-template>
        <ng-template dataTableCell="participants" let-row>
          {{ row.participant_count }}
        </ng-template>
        <ng-template dataTableCell="created_at" let-row>
          <span style="color: var(--color-text-secondary)">{{ formatDate(row.created_at) }}</span>
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex justify-end gap-1" (click)="$event.stopPropagation()">
            <button type="button" class="btn btn--outline btn--sm" (click)="openSplit(row)">
              {{ t('common.open') }}
            </button>
            @if (canAct()) {
              <button type="button" class="btn btn--danger btn--sm" (click)="askDelete(row)">
                {{ t('common.delete') }}
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (showCreateForm()) {
      <app-dialog [title]="t('splits.new')" size="lg" (closed)="closeCreateDialog()">
        <form id="create-split-form" class="grid gap-5" (submit)="onCreateSubmit($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('splits.create_hint') }}
          </p>
          <div class="grid gap-5 lg:grid-cols-2">
            <section class="space-y-4">
              <label class="block">
                <span class="label font-medium"
                  >{{ t('common.name') }} / {{ t('splits.note') }} *</span
                >
                <input
                  class="input"
                  type="text"
                  [value]="draftTitle()"
                  (input)="onTitleChange($event)"
                  required
                />
              </label>

              <div>
                <span class="label font-medium">{{ t('splits.event_linked') }}</span>
                <div class="flex items-center gap-2">
                  <div
                    class="input flex flex-1 items-center"
                    style="background: var(--color-surface-1)"
                  >
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
                      [attr.aria-label]="t('splits.unlink_event')"
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
                      <option [value]="island.id">
                        {{ cityLabel(island.city) }} · {{ island.name }}
                      </option>
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
                <p class="text-xs" style="color: var(--color-warning)">
                  {{ t('splits.catalog.empty') }}
                </p>
              }

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

              <div
                class="surface flex items-center justify-between rounded-lg border p-3"
                style="border-color: var(--color-border)"
              >
                <div>
                  <p
                    class="text-xs font-semibold uppercase"
                    style="color: var(--color-text-disabled)"
                  >
                    {{ t('splits.net_value') }} ({{ t('splits.net_preview') }})
                  </p>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ t('splits.net_formula') }}
                  </p>
                </div>
                <p class="mono text-xl font-bold text-success">
                  {{ formatAmount(draftNetPreview()) }}
                </p>
              </div>

              <div
                class="surface space-y-2 rounded-lg border p-3"
                style="border-color: var(--color-border)"
              >
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
                  <span class="label font-medium">{{ t('splits.ocr_names') }}</span>
                  <textarea
                    class="textarea font-mono text-xs"
                    rows="3"
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
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    (click)="clearParticipants()"
                  >
                    {{ t('splits.clear_roster') }}
                  </button>
                </div>
              </div>
            </section>

            <section class="surface flex flex-col justify-between rounded-lg p-4">
              <div>
                <div class="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 class="text-base font-semibold" style="color: var(--color-text)">
                      {{ t('splits.participants') }} ({{ participants().length }})
                    </h3>
                    <p class="text-xs" style="color: var(--color-text-secondary)">
                      {{ t('splits.roster_hint') }}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <span
                      class="chip mono font-bold"
                      [class.chip--success]="totalWeight() === 100"
                      [class.chip--warning]="totalWeight() !== 100"
                    >
                      {{ totalWeight() }}%
                    </span>
                    @if (participants().length > 0) {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm"
                        (click)="distributeDraftWeightsEvenly()"
                      >
                        {{ t('splits.distribute_evenly') }}
                      </button>
                    }
                    <button
                      type="button"
                      class="btn btn--primary btn--sm"
                      (click)="showParticipantSearch.set(true)"
                    >
                      + {{ t('splits.add_participant') }}
                    </button>
                  </div>
                </div>

                @if (participants().length === 0) {
                  <div class="py-8">
                    <app-empty-state [message]="t('splits.roster_empty')" icon="users" />
                  </div>
                } @else {
                  <div class="grid max-h-96 gap-2 overflow-y-auto pr-1">
                    @for (participant of participants(); track participant.user_id) {
                      <article class="card flex items-center justify-between gap-3 p-3">
                        <div class="min-w-0">
                          <p class="truncate text-sm font-medium" style="color: var(--color-text)">
                            {{ participant.raw_name }}
                          </p>
                          <p class="truncate text-xs" style="color: var(--color-text-secondary)">
                            {{ participant.username }} ·
                            <span class="mono font-semibold text-success">
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
                        <div class="flex shrink-0 items-center gap-2">
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
                            <span class="text-xs" style="color: var(--color-text-secondary)"
                              >%</span
                            >
                          </label>
                          <button
                            type="button"
                            class="btn btn--ghost btn--sm text-error"
                            (click)="removeParticipant(participant.user_id)"
                            [attr.aria-label]="t('splits.remove_participant')"
                          >
                            <app-icon name="close" size="0.875rem" />
                          </button>
                        </div>
                      </article>
                    }
                  </div>
                }
              </div>
            </section>
          </div>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreateDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            form="create-split-form"
            class="btn btn--primary"
            [disabled]="
              saving() || participants().length === 0 || !draftTitle().trim() || !draftTabId()
            "
          >
            {{ saving() ? t('common.loading') : t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (deleteTarget(); as split) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteTarget.set(null)">
        <p>{{ t('splits.confirm_delete') }}</p>
        <p class="mt-2 font-medium">{{ split.note || t('splits.untitled', { id: split.id }) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="deleteTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="saving()"
            (click)="confirmDelete()"
          >
            {{ t('common.delete') }}
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

  private readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly batchRunning = signal(false);
  protected readonly deleteTarget = signal<SplitSummary | null>(null);

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
    this.splits().filter((split) => split.status === 'pending'),
  );
  protected readonly selectedCount = computed(() => this.selectedIds().size);
  protected readonly allPendingSelected = computed(() => {
    const pending = this.pendingSplits();
    return pending.length > 0 && pending.every((split) => this.selectedIds().has(split.id));
  });
  protected readonly draftNetPreview = computed(() =>
    Math.max(0, this.draftEstimated() - this.draftRepair() + this.draftBags()),
  );
  protected readonly draftIslandTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });
  protected readonly canAct = computed(() => this.auth.hasPermission('splits.manage'));
  protected readonly canManageIslands = computed(() =>
    this.auth.hasPermission('splits.islands.manage'),
  );

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
    return (
      Number(split.estimated_market_value) - Number(split.repair_value) + Number(split.bags_value)
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

  protected askDelete(row: SplitSummary): void {
    this.deleteTarget.set(row);
  }

  protected async confirmDelete(): Promise<void> {
    const target = this.deleteTarget();
    if (!target) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/splits/${target.id}`));
      this.deleteTarget.set(null);
      this.toasts.success(this.t('common.delete'));
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
    const status = event.columnFilters['status'] ?? '';
    this.statusFilter.set(isSplitStatus(status) ? status : '');
    this.islandFilter.set(event.columnFilters['island'] ?? '');
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
  protected onRepairChange(event: Event): void {
    this.draftRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onBagsChange(event: Event): void {
    this.draftBags.set(Number((event.target as HTMLInputElement).value) || 0);
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
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
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

  protected async completeSelected(): Promise<void> {
    const ids = [...this.selectedIds()];
    if (ids.length === 0) {
      return;
    }
    this.batchRunning.set(true);
    try {
      const result = await firstValueFrom(
        this.api.post<CompleteSplitsBatchResult>('api/splits/complete-batch', { split_ids: ids }),
      );
      this.selectedIds.set(new Set<number>());
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
    if (value === null || value === undefined) {
      return '0';
    }
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      Number(value),
    );
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
      const sort = this.sortKey();
      if (sort) {
        params['sort'] = sort;
        params['order'] = this.sortOrder() ?? 'desc';
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
    this.draftRepair.set(0);
    this.draftBags.set(0);
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

function isSplitStatus(value: string): value is SplitStatus {
  return (
    value === 'pending' || value === 'completed' || value === 'not_completed' || value === 'lost'
  );
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
  const baseWeight = Math.floor(100 / participants.length);
  return participants.map((participant, index) => ({
    ...participant,
    weight: index === participants.length - 1 ? 100 - baseWeight * index : baseWeight,
  }));
}
