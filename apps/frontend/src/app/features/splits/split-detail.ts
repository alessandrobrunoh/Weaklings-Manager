import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  EventView,
  MatchedParticipant,
  PaginatedData,
  SplitDetail,
  SplitIsland,
  SplitIslandCity,
  SplitParticipant,
  UpdateSplitRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

type DetailMode = 'view' | 'edit';

/**
 * View-first split page. Officers can switch to edit only while the split
 * is still pending.
 */
@Component({
  selector: 'app-split-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    ErrorState,
    Icon,
    Loading,
    PageStack,
    RouterLink,
    SearchDialog,
    StatusChip,
  ],
  template: `
    <a routerLink="/splits" class="btn btn--ghost mb-4 inline-flex"
      >← {{ t('splits.detail.back') }}</a
    >

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed() || !split()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="reload()"
      />
    } @else {
      @if (split(); as detail) {
        <app-page-stack>
          <header class="card p-5">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <h1 class="text-2xl font-bold" style="color: var(--color-text)">
                    {{ detail.note || t('splits.untitled', { id: detail.id }) }}
                  </h1>
                  <app-status-chip [value]="detail.status" />
                </div>
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  {{ t('splits.created_by', { name: detail.created_by_username }) }}
                  · {{ formatDate(detail.created_at) }}
                  @if (detail.event_title && detail.event_id) {
                    · {{ t('splits.event_linked') }}:
                    <a
                      class="text-primary no-underline hover:underline"
                      [routerLink]="['/events', detail.event_id]"
                    >
                      {{ detail.event_title }}
                    </a>
                  }
                  @if (detail.island_tab_id) {
                    · {{ locationLabel(detail) }}
                  }
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                @if (canEdit()) {
                  <button type="button" class="btn btn--ghost" (click)="toggleMode()">
                    {{ mode() === 'edit' ? t('common.close') : t('common.edit') }}
                  </button>
                }
                @if (detail.status === 'pending' && canAct()) {
                  <button type="button" class="btn btn--primary" (click)="closeSplit('complete')">
                    {{ t('splits.payout_complete') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--outline"
                    (click)="closeSplit('not-completed')"
                  >
                    {{ t('splits.mark_not_completed') }}
                  </button>
                  <button type="button" class="btn btn--danger" (click)="closeSplit('lost')">
                    {{ t('splits.mark_lost') }}
                  </button>
                }
                @if (canAct()) {
                  <button type="button" class="btn btn--danger" (click)="showDelete.set(true)">
                    {{ t('common.delete') }}
                  </button>
                }
              </div>
            </div>
          </header>

          @if (mode() === 'edit' && canEdit()) {
            <form id="edit-split-form" class="card grid gap-4 p-5" (submit)="onEditSubmit($event)">
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('splits.edit_subtitle') }}
              </p>
              <label class="block">
                <span class="label font-medium"
                  >{{ t('common.name') }} / {{ t('splits.note') }}</span
                >
                <input
                  class="input"
                  type="text"
                  [value]="editNote()"
                  (input)="onEditNoteChange($event)"
                />
              </label>

              <div>
                <span class="label font-medium">{{ t('splits.event_linked') }}</span>
                <div class="flex items-center gap-2">
                  <div
                    class="input flex flex-1 items-center"
                    style="background: var(--color-surface-1)"
                  >
                    <span class="truncate">{{ editEventTitle() || t('splits.no_event') }}</span>
                  </div>
                  <button
                    type="button"
                    class="btn btn--outline whitespace-nowrap"
                    (click)="showEventSearch.set(true)"
                  >
                    {{ t('splits.link_event') }}
                  </button>
                  @if (editEventId()) {
                    <button
                      type="button"
                      class="btn btn--danger whitespace-nowrap"
                      [attr.aria-label]="t('splits.unlink_event')"
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
                  <select
                    class="select"
                    [value]="editIslandId()"
                    (change)="onEditIslandChange($event)"
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

              <div
                class="surface flex items-center justify-between rounded-lg border p-3"
                style="border-color: var(--color-border)"
              >
                <div>
                  <p
                    class="text-xs font-semibold uppercase"
                    style="color: var(--color-text-disabled)"
                  >
                    {{ t('splits.net_value') }}
                  </p>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ formatAmount(editEstimated()) }} − {{ formatAmount(editRepair()) }} +
                    {{ formatAmount(editBags()) }}
                  </p>
                </div>
                <p class="mono text-xl font-bold text-success">
                  {{ formatAmount(editNetPreview()) }}
                </p>
              </div>

              <div class="surface space-y-3 rounded-lg p-4">
                <div
                  class="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                  style="border-color: var(--color-border)"
                >
                  <div>
                    <h3 class="text-sm font-semibold" style="color: var(--color-text)">
                      {{ t('splits.roster_management') }} ({{ editParticipants().length }})
                    </h3>
                    <p class="text-xs" style="color: var(--color-text-secondary)">
                      {{ t('splits.roster_hint') }}
                    </p>
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
                      (click)="showParticipantSearch.set(true)"
                    >
                      + {{ t('splits.add_participant') }}
                    </button>
                  </div>
                </div>

                <div class="grid max-h-64 gap-2 overflow-y-auto pr-1">
                  @for (participant of editParticipants(); track participant.user_id) {
                    <article class="card flex items-center justify-between gap-3 p-2.5">
                      <div class="min-w-0">
                        <p class="truncate text-sm font-medium" style="color: var(--color-text)">
                          {{ participant.username }}
                        </p>
                        <p class="truncate text-xs" style="color: var(--color-text-secondary)">
                          {{ t('splits.share') }}:
                          <strong class="mono text-success">
                            {{
                              formatAmount(
                                estimatedShare(
                                  editNetPreview(),
                                  participant.weight,
                                  editTotalWeight()
                                )
                              )
                            }}
                          </strong>
                        </p>
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
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
                          <span class="text-xs" style="color: var(--color-text-secondary)">%</span>
                        </label>
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm text-error"
                          (click)="removeEditParticipant(participant.user_id)"
                          [attr.aria-label]="t('splits.remove_participant')"
                        >
                          <app-icon name="close" size="0.875rem" />
                        </button>
                      </div>
                    </article>
                  } @empty {
                    <p class="py-4 text-center text-xs" style="color: var(--color-text-secondary)">
                      {{ t('splits.roster_empty') }}
                    </p>
                  }
                </div>
              </div>

              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn--ghost" (click)="cancelEdit()">
                  {{ t('common.cancel') }}
                </button>
                <button type="submit" class="btn btn--primary" [disabled]="saving()">
                  {{ saving() ? t('common.loading') : t('common.save') }}
                </button>
              </div>
            </form>
          } @else {
            <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <article class="surface rounded-lg p-3">
                <p class="text-xs uppercase" style="color: var(--color-text-disabled)">
                  {{ t('splits.estimated') }}
                </p>
                <p class="mono text-base font-bold text-warning">
                  {{ formatAmount(detail.estimated_market_value) }}
                </p>
              </article>
              <article class="surface rounded-lg p-3">
                <p class="text-xs uppercase" style="color: var(--color-text-disabled)">
                  {{ t('splits.repair_cost') }}
                </p>
                <p class="mono text-base font-bold text-error">
                  -{{ formatAmount(detail.repair_value) }}
                </p>
              </article>
              <article class="surface rounded-lg p-3">
                <p class="text-xs uppercase" style="color: var(--color-text-disabled)">
                  {{ t('splits.bags_value') }}
                </p>
                <p class="mono text-base font-bold">+{{ formatAmount(detail.bags_value) }}</p>
              </article>
              <article
                class="surface rounded-lg border-2 p-3"
                style="border-color: var(--color-success)"
              >
                <p class="text-xs uppercase" style="color: var(--color-text-disabled)">
                  {{ t('splits.net_value') }}
                </p>
                <p class="mono text-base font-bold text-success">
                  {{ formatAmount(netOf(detail)) }}
                </p>
              </article>
            </section>

            <section
              class="surface overflow-hidden rounded-lg border"
              style="border-color: var(--color-border)"
            >
              <header
                class="flex items-center justify-between border-b p-3"
                style="border-color: var(--color-border)"
              >
                <h2 class="text-sm font-semibold" style="color: var(--color-text)">
                  {{ t('splits.participants') }} ({{ detail.participants.length }})
                </h2>
                <span
                  class="mono text-xs"
                  [class.text-warning]="detail.status === 'pending'"
                  [class.text-success]="detail.status !== 'pending'"
                >
                  {{
                    detail.status === 'pending' ? t('splits.pending_payout') : t('splits.paid_out')
                  }}
                </span>
              </header>
              <app-data-table
                [columns]="participantColumns"
                [rows]="detail.participants"
                [trackBy]="trackParticipant"
                [hideSearch]="true"
                emptyIcon="users"
                [emptyLabel]="'splits.roster_empty'"
              >
                <ng-template dataTableCell="username" let-row>
                  <span class="font-medium">{{ row.username }}</span>
                </ng-template>
                <ng-template dataTableCell="weight" let-row>
                  <span class="mono">{{ row.weight }}%</span>
                </ng-template>
                <ng-template dataTableCell="share" let-row>
                  <span class="mono font-bold text-success">
                    {{
                      formatAmount(
                        row.share_amount ?? estimatedShare(netOf(detail), row.weight, 100)
                      )
                    }}
                  </span>
                </ng-template>
              </app-data-table>
            </section>
          }
        </app-page-stack>
      }
    }

    @if (showDelete()) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="showDelete.set(false)">
        <p>{{ t('splits.confirm_delete') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="showDelete.set(false)">
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
        (select)="onEditEventSelect($event)"
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
export class SplitDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly split = signal<SplitDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly mode = signal<DetailMode>('view');
  protected readonly showDelete = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);

  protected readonly editNote = signal('');
  protected readonly editEstimated = signal(0);
  protected readonly editRepair = signal(0);
  protected readonly editBags = signal(0);
  protected readonly editEventId = signal<number | null>(null);
  protected readonly editEventTitle = signal('');
  protected readonly editIslandId = signal('');
  protected readonly editTabId = signal('');
  protected readonly editParticipants = signal<SplitParticipant[]>([]);

  protected readonly showEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);
  protected readonly showParticipantSearch = signal(false);
  protected readonly participantSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly searchingRoster = signal(false);

  protected readonly trackParticipant = (row: SplitParticipant): number => row.user_id;

  protected readonly participantColumns: readonly DataTableColumn<SplitParticipant>[] = [
    { key: 'username', label: 'splits.player', accessor: (row) => row.username },
    { key: 'weight', label: 'splits.weight', align: 'right', accessor: (row) => row.weight },
    { key: 'share', label: 'splits.share', align: 'right', accessor: (row) => row.share_amount },
  ];

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly canAct = computed(() => this.auth.hasPermission('splits.manage'));
  protected readonly canEdit = computed(() => this.canAct() && this.split()?.status === 'pending');
  protected readonly editNetPreview = computed(() =>
    Math.max(0, this.editEstimated() - this.editRepair() + this.editBags()),
  );
  protected readonly editIslandTabs = computed(() => {
    const id = Number(this.editIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });

  constructor() {
    void this.loadIslands();
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('splitId'));
      if (!Number.isFinite(id) || id <= 0) {
        this.loadFailed.set(true);
        this.split.set(null);
        return;
      }
      void this.load(id);
    });
  }

  protected reload(): void {
    const id = Number(this.route.snapshot.paramMap.get('splitId'));
    if (Number.isFinite(id) && id > 0) {
      void this.load(id);
    }
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected locationLabel(split: SplitDetail): string {
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

  protected netOf(split: SplitDetail): number {
    if (split.net_value !== null && split.net_value !== undefined) {
      return Number(split.net_value);
    }
    return (
      Number(split.estimated_market_value) - Number(split.repair_value) + Number(split.bags_value)
    );
  }

  protected editTotalWeight(): number {
    return this.editParticipants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected estimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) {
      return 0;
    }
    return Math.round(netValue * (weight / totalWeight) * 100) / 100;
  }

  protected toggleMode(): void {
    if (this.mode() === 'edit') {
      this.cancelEdit();
      return;
    }
    this.hydrateEdit();
    this.mode.set('edit');
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.showEventSearch.set(false);
    this.showParticipantSearch.set(false);
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
  protected onEditIslandChange(event: Event): void {
    this.editIslandId.set((event.target as HTMLSelectElement).value);
    this.editTabId.set('');
  }
  protected onEditTabChange(event: Event): void {
    this.editTabId.set((event.target as HTMLSelectElement).value);
  }
  protected onEditWeightChange(userId: number, event: Event): void {
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
    this.editParticipants.update((list) =>
      list.map((participant) =>
        participant.user_id === userId ? { ...participant, weight } : participant,
      ),
    );
  }

  protected distributeEditWeightsEvenly(): void {
    const list = this.editParticipants();
    if (list.length === 0) {
      return;
    }
    const baseWeight = Math.floor(100 / list.length);
    this.editParticipants.set(
      list.map((participant, index) => ({
        ...participant,
        weight: index === list.length - 1 ? 100 - baseWeight * index : baseWeight,
      })),
    );
  }

  protected unlinkEditEvent(): void {
    this.editEventId.set(null);
    this.editEventTitle.set('');
  }

  protected onEditEventSelect(opt: SearchDialogOption): void {
    this.editEventId.set(Number(opt.id));
    this.editEventTitle.set(opt.title);
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
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', {
          names: [opt.title],
        }),
      );
      const hit = matched.at(0);
      if (!hit) {
        this.toasts.error(this.t('splits.unlinked_character'));
        return;
      }
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
          user_id: hit.user_id,
          weight: 1,
        }),
      );
      this.split.set(detail);
      this.editParticipants.set([...detail.participants]);
      this.toasts.success(this.t('splits.added_to_split', { name: hit.matched_name }));
      this.showParticipantSearch.set(false);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async removeEditParticipant(userId: number): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.delete<SplitDetail>(`api/splits/${current.id}/participants/${userId}`),
      );
      if (detail?.participants) {
        this.split.set(detail);
        this.editParticipants.set([...detail.participants]);
      } else {
        this.editParticipants.update((list) =>
          list.filter((participant) => participant.user_id !== userId),
        );
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async onEditSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      const request: UpdateSplitRequest = {
        note: this.editNote().trim(),
        estimated_market_value: this.editEstimated(),
        repair_value: this.editRepair(),
        bags_value: this.editBags(),
        event_id: this.editEventId(),
        island_tab_id: this.editTabId() ? Number(this.editTabId()) : undefined,
      };
      let detail = await firstValueFrom(
        this.api.patch<SplitDetail>(`api/splits/${current.id}`, request),
      );
      for (const participant of this.editParticipants()) {
        detail = await firstValueFrom(
          this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
            user_id: participant.user_id,
            weight: participant.weight,
          }),
        );
      }
      this.split.set(detail);
      this.mode.set('view');
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async closeSplit(action: 'complete' | 'not-completed' | 'lost'): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/${action}`, {}),
      );
      this.split.set(detail);
      this.mode.set('view');
      const toastKey: TranslationKey =
        action === 'complete'
          ? 'splits.status.completed'
          : action === 'not-completed'
            ? 'splits.status.not_completed'
            : 'splits.status.lost';
      this.toasts.success(this.t(toastKey));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async confirmDelete(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/splits/${current.id}`));
      this.toasts.success(this.t('common.delete'));
      void this.router.navigate(['/splits']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
      this.showDelete.set(false);
    }
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    return Number(value).toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  private hydrateEdit(): void {
    const detail = this.split();
    if (!detail) {
      return;
    }
    this.editNote.set(detail.note || '');
    this.editEstimated.set(Number(detail.estimated_market_value) || 0);
    this.editRepair.set(Number(detail.repair_value) || 0);
    this.editBags.set(Number(detail.bags_value) || 0);
    this.editEventId.set(detail.event_id ?? null);
    this.editEventTitle.set(detail.event_title || '');
    this.editIslandId.set(detail.island_id ? String(detail.island_id) : '');
    this.editTabId.set(detail.island_tab_id ? String(detail.island_tab_id) : '');
    this.editParticipants.set([...detail.participants]);
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${id}`));
      this.split.set(detail);
      if (detail.status !== 'pending') {
        this.mode.set('view');
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.split.set(null);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
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
}
