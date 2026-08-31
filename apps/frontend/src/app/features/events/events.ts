import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompSummary,
  CreateEventRequest,
  EventStatus,
  EventView,
  PaginatedData,
  SplitIsland,
  SplitIslandCity,
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
import { StatusChip } from '../../shared/components/status-chip/status-chip';

import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const PAGE_SIZE = 10;
const EVENT_STATUSES: readonly EventStatus[] = ['scheduled', 'live', 'stopped', 'auto_stopped'];

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  date: 'event_date_utc',
  status: 'status',
};

/**
 * Events list page.
 *
 * Server-driven table of guild events. Create lives in a native `<dialog>`
 * (focus trap, Esc, light-dismiss) so `/events/new` is no longer a route.
 * Row actions stay compact: Open is primary, Join still lands on detail,
 * and Start/Stop/Leave stay on the detail page.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, Icon, PageHeader, PageStack, StatCard, StatusChip, TooltipDirective],
  template: `
    <app-page-header [title]="t('events.title')" [subtitle]="t('events.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="'Aggiorna elenco eventi'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canManage()) {
        <button
          type="button"
          class="btn btn--primary btn--sm"
          (click)="openCreate()"
          [appTooltip]="'Crea un nuovo evento di gilda'"
          tooltipPosition="bottom"
        >
          <app-icon name="plus" size="0.875rem" />
          {{ t('events.new') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Events summary">
        <app-stat-card
          [label]="t('events.stat.total')"
          [value]="totalItems()"
          icon="calendar"
          tone="neutral"
        />
        <app-stat-card
          [label]="t('events.stat.live')"
          [value]="liveCount()"
          icon="sparkles"
          tone="success"
        />
        <app-stat-card
          [label]="t('events.stat.scheduled')"
          [value]="scheduledCount()"
          icon="calendar"
          tone="primary"
        />
        <app-stat-card
          [label]="t('events.stat.cta')"
          [value]="ctaCount()"
          icon="alert"
          tone="warning"
        />
      </section>

      <app-data-table
        [columns]="columns()"
        [rows]="events()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [pageSize]="pageSize()"
        emptyIcon="calendar"
        [rowClickable]="true"
        (rowClick)="openEventDetail($event.id)"
        (pageChange)="onPageChange($event)"
      >
        <ng-template dataTableCell="title" let-row>
          <span class="font-medium" style="color: var(--color-text)">
            @if (row.call_to_arms) {
              <span class="cta-star" [title]="t('events.call_to_arms')">★</span>
            }
            {{ row.title }}
          </span>
        </ng-template>
        <ng-template dataTableCell="date" let-row>
          <span style="color: var(--color-text-secondary)">{{ formatDate(row.event_date_utc) }}</span>
        </ng-template>
        <ng-template dataTableCell="comp" let-row>
          {{ row.comp_name }}
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <app-status-chip [value]="row.status" />
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex flex-wrap justify-end gap-1">
            <button
              type="button"
              class="btn btn--primary btn--sm"
              (click)="$event.stopPropagation(); openEventDetail(row.id)"
            >
              {{ t('common.open') }}
            </button>
            @if (row.status === 'scheduled') {
              <button
                type="button"
                class="btn btn--tonal btn--sm"
                (click)="$event.stopPropagation(); join(row.id)"
              >
                {{ t('events.participate') }}
              </button>
            }
            @if (canManage()) {
              <button
                type="button"
                class="btn btn--danger btn--sm"
                (click)="$event.stopPropagation(); requestDelete(row)"
              >
                {{ t('common.delete') }}
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('events.new')" size="lg" (closed)="closeCreate()">
        <form id="create-event-form" class="grid gap-4" (submit)="onCreateSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="draftTitle()"
              (input)="onTitleChange($event)"
            />
          </label>

          <label>
            <span class="label">{{ t('common.description') }}</span>
            <textarea
              class="textarea"
              rows="3"
              [value]="draftDescription()"
              (input)="onDescriptionChange($event)"
            ></textarea>
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label>
              <span class="label">{{ t('events.detail.comp') }}</span>
              <select
                class="select"
                [value]="draftCompId()"
                [disabled]="compsLoading()"
                (change)="onCompChange($event)"
              >
                <option value="">{{ compsLoading() ? t('common.loading') : '—' }}</option>
                @for (comp of comps(); track comp.id) {
                  <option [value]="comp.id">{{ comp.name }}</option>
                }
              </select>
            </label>

            <label>
              <span class="label">{{ t('common.date') }}</span>
              <input
                class="input"
                type="datetime-local"
                [attr.min]="minScheduledAt"
                [value]="draftScheduledAt()"
                (input)="onScheduledAtChange($event)"
              />
            </label>
          </div>

          <label class="flex items-center gap-2">
            <input
              class="checkbox"
              type="checkbox"
              [checked]="draftCallToArms()"
              (change)="onCallToArmsChange($event)"
            />
            <span>{{ t('events.call_to_arms') }}</span>
          </label>

          <label class="flex items-start gap-2">
            <input
              class="checkbox mt-0.5"
              type="checkbox"
              [checked]="draftCreateSplit()"
              (change)="onCreateSplitChange($event)"
            />
            <span>
              {{ t('events.createSplit') }}
              <span class="mt-0.5 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('events.createSplitHint') }}
              </span>
            </span>
          </label>

          @if (draftCreateSplit()) {
            <div class="grid gap-3 sm:grid-cols-2">
              <label>
                <span class="label">{{ t('splits.island') }}</span>
                <select class="select" [value]="draftIslandId()" (change)="onIslandChange($event)">
                  <option value="">{{ t('splits.pick_island') }}</option>
                  @for (island of islands(); track island.id) {
                    <option [value]="island.id">{{ cityLabel(island.city) }} · {{ island.name }}</option>
                  }
                </select>
              </label>
              <label>
                <span class="label">{{ t('splits.tab') }}</span>
                <select
                  class="select"
                  [value]="draftTabId()"
                  [disabled]="!draftIslandId()"
                  (change)="onTabChange($event)"
                >
                  <option value="">{{ t('splits.pick_tab') }}</option>
                  @for (tab of draftTabs(); track tab.id) {
                    <option [value]="tab.id">{{ tab.name }}</option>
                  }
                </select>
              </label>
            </div>
          }

          @if (compError()) {
            <p class="text-sm" style="color: var(--color-danger)">{{ compError() }}</p>
          }
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-event-form"
            [disabled]="saving()"
          >
            {{ t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingDelete()) {
      <app-dialog [title]="t('events.detail.delete')" size="sm" (closed)="cancelDelete()">
        <p>{{ t('events.detail.confirm_delete') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelDelete()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="deleting()"
            (click)="confirmDelete()"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Events {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly events = signal<EventView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(PAGE_SIZE);
  protected readonly totalItems = signal(0);
  protected readonly search = signal('');
  protected readonly statusFilter = signal('');
  protected readonly sortColumn = signal<string | null>(null);
  protected readonly sortOrder = signal<'asc' | 'desc' | null>(null);

  protected readonly liveCount = computed(
    () => this.events().filter((e) => e.status === 'live').length,
  );
  protected readonly scheduledCount = computed(
    () => this.events().filter((e) => e.status === 'scheduled').length,
  );
  protected readonly ctaCount = computed(
    () => this.events().filter((e) => e.call_to_arms).length,
  );

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected readonly createOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly compsLoading = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftScheduledAt = signal(defaultScheduledAt());
  protected readonly minScheduledAt = minScheduledAt();
  protected readonly draftCallToArms = signal(false);
  protected readonly draftCreateSplit = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  protected readonly draftTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });
  protected readonly compError = signal<string | null>(null);

  protected readonly pendingDelete = signal<EventView | null>(null);
  protected readonly deleting = signal(false);

  protected readonly trackById = (event: EventView): number => event.id;

  protected readonly columns = computed<readonly DataTableColumn<EventView>[]>(() => [
    {
      key: 'title',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (event) => event.title,
    },
    {
      key: 'date',
      label: 'common.date',
      sortable: true,
      accessor: (event) => event.event_date_utc,
    },
    {
      key: 'comp',
      label: 'events.detail.comp',
      searchable: true,
      accessor: (event) => event.comp_name,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (event) => event.status,
      filterOptions: EVENT_STATUSES.map((status) => ({
        value: status,
        label: this.t(statusLabel(status)),
      })),
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** True when the current user can create or delete events. */
  protected canManage(): boolean {
    return this.auth.hasPermission('events.manage');
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected openCreate(): void {
    this.resetCreateDraft();
    this.createOpen.set(true);
    void this.loadCreateOptions();
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  /** Opens the analytics view for a single event. */
  protected openEventDetail(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  /** Formats ISO date strings using the browser locale. */
  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Join still lands on detail, where picking a build is what actually joins. */
  protected join(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  protected requestDelete(event: EventView): void {
    this.pendingDelete.set(event);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const doomed = this.pendingDelete();
    if (!doomed) {
      return;
    }
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/events/${doomed.id}`));
      this.pendingDelete.set(null);
      this.toasts.success(this.t('common.delete'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.deleting.set(false);
    }
  }

  protected onPageChange(change: DataTablePageChange): void {
    this.page.set(change.page);
    this.pageSize.set(change.pageSize);
    this.search.set(change.search);
    this.statusFilter.set(change.columnFilters['status'] ?? '');
    this.sortColumn.set(change.sort?.columnKey ?? null);
    this.sortOrder.set(change.sort?.direction ?? null);
    void this.load();
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onScheduledAtChange(event: Event): void {
    this.draftScheduledAt.set((event.target as HTMLInputElement).value);
  }

  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
    this.compError.set(null);
  }

  protected onCreateSplitChange(event: Event): void {
    this.draftCreateSplit.set((event.target as HTMLInputElement).checked);
  }

  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
  }

  protected onIslandChange(event: Event): void {
    this.draftIslandId.set((event.target as HTMLSelectElement).value);
    this.draftTabId.set('');
  }

  protected onTabChange(event: Event): void {
    this.draftTabId.set((event.target as HTMLSelectElement).value);
  }

  protected async onCreateSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();

    const title = this.draftTitle().trim();
    const compId = Number(this.draftCompId());

    if (!title) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (compId <= 0) {
      this.compError.set(this.t('events.create.comp_required'));
      return;
    }
    if (this.draftCreateSplit() && !this.draftTabId()) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const scheduledAt = new Date(this.draftScheduledAt());
    if (Number.isNaN(scheduledAt.getTime())) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const request: CreateEventRequest = {
      title,
      comp_id: compId,
      event_date_utc: scheduledAt.toISOString(),
      call_to_arms: this.draftCallToArms(),
      create_split: this.draftCreateSplit(),
      island_tab_id: this.draftCreateSplit() ? Number(this.draftTabId()) : undefined,
    };
    const description = this.draftDescription().trim();
    if (description) {
      request.description = description;
    }

    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.post<EventView>('api/events', request));
      this.toasts.success(this.t('common.create'));
      this.closeCreate();
      await this.load();
      void this.router.navigate(['/events', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const sort = this.sortColumn() ? (SORT_COLUMNS[this.sortColumn()!] ?? this.sortColumn()) : undefined;
      const data = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', {
          page: this.page(),
          limit: this.pageSize(),
          search: this.search().trim() || undefined,
          status: this.statusFilter() || undefined,
          sort,
          order: sort ? (this.sortOrder() ?? 'asc') : undefined,
        }),
      );
      this.events.set(data.items);
      this.totalItems.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private resetCreateDraft(): void {
    this.draftTitle.set('');
    this.draftDescription.set('');
    this.draftCompId.set('');
    this.draftScheduledAt.set(defaultScheduledAt());
    this.draftCallToArms.set(false);
    this.draftCreateSplit.set(false);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.compError.set(null);
  }

  private async loadCreateOptions(): Promise<void> {
    this.compsLoading.set(true);
    try {
      const [comps, islands] = await Promise.all([
        firstValueFrom(this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 })),
        firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands')),
      ]);
      this.comps.set(comps.items);
      this.islands.set(islands);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compsLoading.set(false);
    }
  }
}

function statusLabel(status: EventStatus): TranslationKey {
  switch (status) {
    case 'scheduled':
      return 'events.status.scheduled';
    case 'live':
      return 'events.status.live';
    case 'stopped':
      return 'events.status.stopped';
    case 'auto_stopped':
      return 'events.status.auto_stopped';
  }
}

/** Formats a `Date` as `YYYY-MM-DDTHH:mm` in the user's local timezone. */
function formatDatetimeLocal(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Snap to the next whole hour so the default event time is human-readable. */
function defaultScheduledAt(): string {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  nextHour.setMinutes(0, 0, 0);
  return formatDatetimeLocal(nextHour);
}

/** Floor for the date picker — officers can still pick sooner than the next hour. */
function minScheduledAt(): string {
  return formatDatetimeLocal(new Date());
}
