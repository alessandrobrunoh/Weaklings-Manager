import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AllianceContext,
  CompSummary,
  CreateEventRequest,
  DiscordRoleView,
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
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  type DataTableTab,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { roleSelectOptionsMany } from '../../shared/discord/discord-options';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const PAGE_SIZE = 10;
const EVENT_STATUSES: readonly EventStatus[] = ['scheduled', 'live', 'stopped', 'auto_stopped', 'cancelled'];

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  date: 'event_date_utc',
  status: 'status',
};

/**
 * Events list page.
 *
 * Pixel-perfect implementation matching the modern dark midnight specification.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    Icon,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    StatCard,
    TooltipDirective,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    :host ::ng-deep .rounded-xl,
    :host ::ng-deep .rounded-2xl,
    :host ::ng-deep .rounded-lg,
    :host ::ng-deep .rounded-md,
    :host ::ng-deep .shadow-lg,
    :host ::ng-deep .shadow-xl {
      border-radius: var(--radius-cards, 2px);
      box-shadow: none;
    }
  `,
  template: `
    <app-page-header [title]="t('events.title')" [subtitle]="t('events.subtitle')">
      @if (canDelete()) {
        <button
          type="button"
          class="btn btn--sm"
          [class.btn--tonal]="showArchived()"
          [class.btn--outline]="!showArchived()"
          (click)="toggleShowArchived()"
        >
          {{ t('events.showArchived') }}
        </button>
      }
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="refresh" size="0.875rem" [class.animate-spin]="loading()" />
        {{ t('common.refreshNow') }}
      </button>
      @if (canCreate()) {
        <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('events.new') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-5" aria-label="Events summary">
        <app-stat-card
          [label]="t('events.stat.total')"
          [value]="totalEventsCount()"
          sub="All scheduled and past events"
          icon="calendar"
          tone="primary"
        />
        <app-stat-card
          [label]="t('events.stat.live')"
          [value]="liveEventsCount()"
          sub="Active war rooms"
          icon="zap"
          tone="success"
        />
        <app-stat-card
          [label]="t('events.stat.scheduled')"
          [value]="scheduledEventsCount()"
          sub="Upcoming deployments"
          icon="calendar"
          tone="primary"
        />
        <app-stat-card
          [label]="t('events.stat.cta')"
          [value]="ctaEventsCount()"
          sub="Mandatory guild CTA"
          icon="alert"
          tone="warning"
        />
      </section>

      <app-data-table
        [columns]="columns()"
        [rows]="events()"
        [loading]="loading()"
        [error]="loadFailed()"
        [trackBy]="trackById"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [pageSize]="pageSize()"
        [pageSizeOptions]="[10, 20, 50]"
        itemLabel="events"
        emptyIcon="calendar"
        emptyTitle="No events found"
        emptySubtitle="There are no events matching the selected filters."
        searchPlaceholder="Search events..."
        [tabs]="statusTabs()"
        [activeTab]="statusFilter()"
        (tabChange)="setStatusFilter($event)"
        (pageChange)="onTablePageChange($event)"
        (retry)="refreshNow()"
      >
        <ng-template dataTableCell="title" let-event>
          <div class="flex items-center gap-1.5 min-w-[220px]">
            @if (event.call_to_arms) {
              <span class="text-warning font-bold text-sm select-none" [title]="t('events.call_to_arms')">★</span>
            }
            <a
              [routerLink]="['/events', event.id]"
              class="text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors no-underline truncate max-w-xs"
            >
              {{ event.title }}
            </a>
            @if (event.archived_at) {
              <span class="chip chip--neutral text-[10px]">{{ t('events.archived') }}</span>
            }
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            Mass: {{ formatMassTime(event) }}
          </div>
        </ng-template>

        <ng-template dataTableCell="date" let-event>
          <div class="text-xs font-medium text-[var(--color-text)]">
            {{ formatDateDay(event.start_time_utc ?? event.event_date_utc) }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            {{ formatDateTime(event.start_time_utc ?? event.event_date_utc) }}
          </div>
        </ng-template>

        <ng-template dataTableCell="comp_name" let-event>
          <div class="inline-flex items-center gap-1.5 text-xs text-[var(--color-text)]">
            <app-icon name="swords" size="0.875rem" class="text-[var(--color-text-tertiary)] shrink-0" />
            <span>{{ event.comp_name || t('events.detail.fill_option') }}</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="status" let-event>
          @switch (event.status) {
            @case ('live') {
              <span class="chip chip--success text-xs">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                {{ t('events.status.live') }}
              </span>
            }
            @case ('scheduled') {
              <span class="chip chip--info text-xs">
                <app-icon name="calendar" size="0.75rem" />
                {{ t('events.status.scheduled') }}
              </span>
            }
            @case ('cancelled') {
              <span class="chip chip--error text-xs">
                <app-icon name="close" size="0.75rem" />
                {{ t('events.status.cancelled') }}
              </span>
            }
            @case ('auto_stopped') {
              <span class="chip chip--neutral text-xs">{{ t('events.status.auto_stopped') }}</span>
            }
            @default {
              <span class="chip chip--neutral text-xs">{{ t('events.status.stopped') }}</span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="actions" let-event>
          <div class="inline-flex items-center justify-end gap-1.5">
            <button type="button" class="btn btn--ghost btn--sm" (click)="openEventDetail(event.id)">
              {{ t('common.open') }}
            </button>
            @if (event.status === 'scheduled' && !event.archived_at) {
              <button type="button" class="btn btn--primary btn--sm" (click)="join(event.id)">
                {{ t('events.participate') }}
              </button>
            }
            @if (canEdit() && event.status === 'cancelled' && !event.archived_at) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="reopening()"
                (click)="requestUncancel(event)"
              >
                {{ t('events.uncancel') }}
              </button>
            }
            @if (canDelete()) {
              @if (event.archived_at) {
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  [disabled]="archiving()"
                  (click)="unarchiveEvent(event)"
                >
                  {{ t('events.unarchive') }}
                </button>
              } @else {
                <button type="button" class="btn btn--ghost btn--sm" (click)="requestArchive(event)">
                  {{ t('events.archive') }}
                </button>
              }
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

          <div class="grid gap-4 sm:grid-cols-5">
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
              <span class="label">{{ t('events.create.playerCap') }}</span>
              <input
                id="event-player-cap"
                name="player_cap"
                class="input"
                type="number"
                min="1"
                step="1"
                inputmode="numeric"
                [value]="draftPlayerCap()"
                aria-describedby="event-player-cap-hint"
                (input)="onPlayerCapChange($event)"
              />
              <span id="event-player-cap-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('events.create.playerCapHint') }}
              </span>
            </label>

            <label>
              <span class="label">{{ t('common.date') }}</span>
              <input class="input" type="date" required [attr.min]="minEventDate" [value]="draftEventDate()" (input)="onEventDateChange($event)" />
            </label>

            <label>
              <span class="label">Mass</span>
              <input class="input" type="time" required [value]="draftMassTime()" (input)="onMassTimeChange($event)" />
            </label>

            <label>
              <span class="label">Start</span>
              <input class="input" type="time" required [value]="draftStartTime()" (input)="onStartTimeChange($event)" />
            </label>
          </div>

          <fieldset class="grid gap-3">
            <legend class="label">{{ t('events.discordRoles.label') }}</legend>
            <p id="event-discord-roles-hint" class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('events.discordRoles.hint') }}
            </p>
            @if (roleError()) {
              <p class="text-sm" style="color: var(--color-danger)" aria-live="polite">{{ roleError() }}</p>
            } @else {
              <app-searchable-select
                [options]="eventRoleOptions()"
                [values]="draftDiscordRoleIds()"
                [multiple]="true"
                [allowEmpty]="false"
                [emptyLabel]="t('events.discordRoles.none')"
                [searchPlaceholder]="t('events.discordRoles.search')"
                [noMatchesLabel]="t('events.discordRoles.noMatches')"
                [emptyOptionsLabel]="t('events.discordRoles.empty')"
                [ariaLabel]="t('events.discordRoles.label')"
                (valuesChange)="draftDiscordRoleIds.set($event)"
              />
            }
          </fieldset>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex items-center gap-2">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftCallToArms()"
                (change)="onCallToArmsChange($event)"
              />
              <span>{{ t('events.call_to_arms') }}</span>
            </label>
            <label class="flex items-center gap-2">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftRegear()"
                (change)="onRegearChange($event)"
              />
              <span>{{ t('events.regear') }}</span>
            </label>
            @if (canPingAlliance()) {
              <label class="flex items-start gap-2 sm:col-span-2">
                <input
                  class="checkbox mt-0.5"
                  type="checkbox"
                  [checked]="draftPingAlliance()"
                  (change)="onPingAllianceChange($event)"
                />
                <span>
                  {{ t('events.pingAlliance') }}
                  <span class="mt-0.5 block text-xs" style="color: var(--color-text-secondary)">
                    {{ t('events.pingAllianceHint') }}
                  </span>
                </span>
              </label>
            }
          </div>

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

    @if (pendingArchive()) {
      <app-dialog [title]="t('events.archive')" size="sm" (closed)="cancelArchive()">
        <p>{{ t('events.detail.confirm_delete') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelArchive()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--tonal"
            [disabled]="archiving()"
            (click)="confirmArchive()"
          >
            {{ t('events.archive') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingUncancel()) {
      <app-dialog [title]="t('events.uncancel')" size="sm" (closed)="cancelUncancel()">
        <p>{{ t('events.detail.confirm_uncancel') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelUncancel()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary"
            [disabled]="reopening()"
            (click)="confirmUncancel()"
          >
            {{ t('events.uncancel') }}
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
  // Keep the initial table view aligned with the API's newest-first default.
  protected readonly sortColumn = signal<string | null>('date');
  protected readonly sortOrder = signal<'asc' | 'desc' | null>('desc');

  protected readonly totalEventsCount = signal(0);
  protected readonly liveEventsCount = signal(0);
  protected readonly scheduledEventsCount = signal(0);
  protected readonly ctaEventsCount = signal(0);
  protected readonly finishedEventsCount = signal(0);

  protected readonly columns = computed<readonly DataTableColumn<EventView>[]>(() => [
    {
      key: 'title',
      label: 'events.table.event',
      sortable: true,
      searchable: true,
      accessor: (event) => event.title,
    },
    {
      key: 'date',
      label: 'events.table.date',
      sortable: true,
      accessor: (event) => event.start_time_utc ?? event.event_date_utc,
    },
    {
      key: 'comp_name',
      label: 'events.table.composition',
      searchable: true,
      accessor: (event) => event.comp_name,
    },
    {
      key: 'status',
      label: 'events.table.status',
      sortable: true,
      accessor: (event) => event.status,
    },
    { key: 'actions', label: 'events.table.actions', align: 'right' },
  ]);

  protected readonly statusTabs = computed<readonly DataTableTab[]>(() => [
    { id: '', label: this.t('common.all'), count: this.totalEventsCount() },
    {
      id: 'live',
      label: this.t('events.status.live'),
      count: this.liveEventsCount(),
      dotClass: 'bg-[var(--color-success)]',
    },
    {
      id: 'scheduled',
      label: this.t('events.status.scheduled'),
      count: this.scheduledEventsCount(),
      dotClass: 'bg-[var(--color-info)]',
    },
    {
      id: 'stopped',
      label: 'Finished',
      count: this.finishedEventsCount(),
      dotClass: 'bg-[var(--color-text-tertiary)]',
    },
  ]);

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.load(), this.loadStats()]);
  }

  constructor() {
    void this.load();
    void this.loadStats();
  }

  protected readonly createOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly compsLoading = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftPlayerCap = signal('');
  protected readonly draftEventDate = signal(defaultEventDate());
  protected readonly draftMassTime = signal(defaultMassTime());
  protected readonly draftStartTime = signal(defaultStartTime());
  protected readonly minEventDate = defaultEventDate();
  protected readonly draftCallToArms = signal(false);
  protected readonly draftRegear = signal(false);
  protected readonly draftPingAlliance = signal(false);
  protected readonly allianceId = signal<string | null>(null);
  protected readonly allianceMembershipStatus = signal<string | null>(null);
  protected readonly canPingAlliance = computed(
    () =>
      this.auth.profile()?.tenant_kind === 'guild' &&
      Boolean(this.allianceId()) &&
      this.allianceMembershipStatus() === 'active',
  );
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly draftDiscordRoleIds = signal<string[]>([]);
  protected readonly roleError = signal<string | null>(null);
  protected readonly draftCreateSplit = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  protected readonly draftTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });
  protected readonly compError = signal<string | null>(null);

  protected readonly pendingArchive = signal<EventView | null>(null);
  protected readonly pendingUncancel = signal<EventView | null>(null);
  protected readonly archiving = signal(false);
  protected readonly reopening = signal(false);
  protected readonly showArchived = signal(false);

  protected readonly trackById = (event: EventView): number => event.id;
  protected t = (key: TranslationKey) => this.translate.t(key);

  /** True when the current user can create a new event. */
  protected canCreate(): boolean {
    return this.auth.hasPermission('events.create');
  }

  /** True when the current user can archive or restore an event. */
  protected canDelete(): boolean {
    return this.auth.hasPermission('events.delete');
  }

  /** True when the current user can cancel or reopen an event. */
  protected canEdit(): boolean {
    return this.auth.hasPermission('events.edit');
  }

  protected toggleShowArchived(): void {
    this.showArchived.update((value) => !value);
    this.page.set(1);
    void this.load();
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
    return new Date(iso).toLocaleString(this.translate.locale());
  }

  /** Join still lands on detail, where picking a build is what actually joins. */
  protected join(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  protected requestArchive(event: EventView): void {
    this.pendingArchive.set(event);
  }

  protected cancelArchive(): void {
    this.pendingArchive.set(null);
  }

  protected async confirmArchive(): Promise<void> {
    const target = this.pendingArchive();
    if (!target) {
      return;
    }
    this.archiving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${target.id}/archive`, {}));
      this.pendingArchive.set(null);
      this.toasts.success(this.t('events.archiveSuccess'));
      if (this.events().length === 1 && this.page() > 1) {
        this.page.set(this.page() - 1);
      }
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.archiving.set(false);
    }
  }

  protected requestUncancel(event: EventView): void {
    this.pendingUncancel.set(event);
  }

  protected cancelUncancel(): void {
    this.pendingUncancel.set(null);
  }

  protected async confirmUncancel(): Promise<void> {
    const target = this.pendingUncancel();
    if (!target) {
      return;
    }
    this.reopening.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${target.id}/uncancel`, {}));
      this.pendingUncancel.set(null);
      this.toasts.success(this.t('events.uncancelSuccess'));
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.reopening.set(false);
    }
  }

  protected async unarchiveEvent(event: EventView): Promise<void> {
    this.archiving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${event.id}/unarchive`, {}));
      this.toasts.success(this.t('events.unarchiveSuccess'));
      if (this.events().length === 1 && this.page() > 1) {
        this.page.set(this.page() - 1);
      }
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.archiving.set(false);
    }
  }

  protected setStatusFilter(status: string): void {
    this.statusFilter.set(status);
    this.page.set(1);
    void this.load();
  }

  protected onTablePageChange(change: DataTablePageChange): void {
    this.page.set(change.page);
    this.pageSize.set(change.pageSize);
    this.search.set(change.search);
    this.sortColumn.set(change.sort?.columnKey ?? null);
    this.sortOrder.set(change.sort?.direction ?? null);
    void this.load();
  }

  protected formatMassTime(event: EventView): string {
    const dateStr = event.mass_time_utc ?? event.event_date_utc;
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected formatDateDay(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString(this.translate.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  }

  protected formatDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected async loadStats(): Promise<void> {
    try {
      const allData = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 100 }),
      );
      const items = allData.items;
      this.totalEventsCount.set(allData.total_items);
      this.liveEventsCount.set(items.filter((e) => e.status === 'live').length);
      this.scheduledEventsCount.set(items.filter((e) => e.status === 'scheduled').length);
      this.ctaEventsCount.set(items.filter((e) => e.call_to_arms).length);
      this.finishedEventsCount.set(
        items.filter((e) => e.status === 'stopped' || e.status === 'auto_stopped' || e.status === 'cancelled').length,
      );
    } catch {
      // Fallback
    }
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onEventDateChange(event: Event): void {
    this.draftEventDate.set((event.target as HTMLInputElement).value);
  }

  protected onMassTimeChange(event: Event): void {
    this.draftMassTime.set((event.target as HTMLInputElement).value);
  }

  protected onStartTimeChange(event: Event): void {
    this.draftStartTime.set((event.target as HTMLInputElement).value);
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
    this.compError.set(null);
  }

  protected onPlayerCapChange(event: Event): void {
    this.draftPlayerCap.set((event.target as HTMLInputElement).value);
    this.compError.set(null);
  }

  protected onCreateSplitChange(event: Event): void {
    this.draftCreateSplit.set((event.target as HTMLInputElement).checked);
  }

  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
  }

  protected onRegearChange(event: Event): void {
    this.draftRegear.set((event.target as HTMLInputElement).checked);
  }

  protected onPingAllianceChange(event: Event): void {
    this.draftPingAlliance.set((event.target as HTMLInputElement).checked);
  }

  protected eventRoleOptions() {
    return roleSelectOptionsMany(this.discordRoles(), this.draftDiscordRoleIds());
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
    const playerCapText = this.draftPlayerCap().trim();
    const playerCap = playerCapText ? Number(playerCapText) : undefined;

    if (!title) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (compId <= 0) {
      this.compError.set(this.t('events.create.comp_required'));
      return;
    }
    if (
      playerCap !== undefined &&
      (!Number.isSafeInteger(playerCap) || playerCap <= 0)
    ) {
      this.compError.set(this.t('events.create.playerCapInvalid'));
      return;
    }
    if (this.draftCreateSplit() && !this.draftTabId()) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const massAt = combineLocalDateTime(this.draftEventDate(), this.draftMassTime());
    const startAt = combineLocalDateTime(this.draftEventDate(), this.draftStartTime());
    if (!massAt || !startAt) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (massAt > startAt) {
      this.toasts.error('Mass deve essere uguale o precedente all\'orario di Start.');
      return;
    }

    const request: CreateEventRequest = {
      title,
      comp_id: compId,
      player_cap: playerCap,
      event_date_utc: startAt.toISOString(),
      mass_time_utc: massAt.toISOString(),
      start_time_utc: startAt.toISOString(),
      call_to_arms: this.draftCallToArms(),
      regear: this.draftRegear(),
      ping_alliance: this.canPingAlliance() && this.draftPingAlliance(),
      discord_role_ids: this.draftDiscordRoleIds(),
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
      void this.loadStats();
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
          archived: this.showArchived() ? 'true' : undefined,
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
    this.draftPlayerCap.set('');
    this.draftEventDate.set(defaultEventDate());
    this.draftMassTime.set(defaultMassTime());
    this.draftStartTime.set(defaultStartTime());
    this.draftCallToArms.set(false);
    this.draftRegear.set(false);
    this.draftPingAlliance.set(false);
    this.draftDiscordRoleIds.set([]);
    this.roleError.set(null);
    this.draftCreateSplit.set(false);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.compError.set(null);
  }

  private async loadCreateOptions(): Promise<void> {
    this.compsLoading.set(true);
    this.allianceId.set(null);
    this.allianceMembershipStatus.set(null);
    try {
      const [comps, islands, alliance] = await Promise.all([
        firstValueFrom(this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 })),
        firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands')),
        firstValueFrom(this.api.get<AllianceContext>('api/alliances/me')).catch(() => null),
      ]);
      this.comps.set(comps.items);
      this.islands.set(islands);
      this.allianceId.set(alliance?.alliance_id ?? null);
      this.allianceMembershipStatus.set(alliance?.membership_status ?? null);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }

    try {
      const discordRoles = await firstValueFrom(this.api.get<DiscordRoleView[]>('api/events/discord-roles'));
      this.discordRoles.set(discordRoles);
      this.roleError.set(null);
    } catch (error) {
      this.roleError.set(error instanceof Error ? error.message : this.t('common.error'));
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
    case 'cancelled':
      return 'events.status.cancelled';
  }
}

/** Formats a date as `YYYY-MM-DD` in the user's local timezone. */
function formatDateInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultEventDate(): string {
  return formatDateInput(new Date(Date.now() + 60 * 60 * 1000));
}

function defaultMassTime(): string {
  return '19:30';
}

function defaultStartTime(): string {
  return '20:00';
}

function combineLocalDateTime(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? null : value;
}
