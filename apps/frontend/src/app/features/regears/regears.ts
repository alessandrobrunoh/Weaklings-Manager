import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AcceptRegearRequest,
  PaginatedData,
  RegearBudgetSummary,
  RegearDeathView,
  RegearStatus,
  RejectRegearRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

/** Section tab inside the Regears page. Settings live on `/admin/regears`. */
type RegearTab = 'mine' | 'queue' | 'history';

/** Status filter applied on top of the section tab; `all` means no status narrowing. */
type StatusFilter = 'all' | RegearStatus;

function isRegearTab(value: string): value is RegearTab {
  return value === 'mine' || value === 'queue' || value === 'history';
}

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Backend exposes no guild-wide regear stats/summary endpoint (only the
 * paginated `/deaths` list and the per-user `/me/summary` budget). The summary
 * band needs a full, unfiltered-by-status picture, so a separate fetch pulls
 * a large enough page of the same section-scoped dataset — independent of the
 * table's own small page size — to aggregate from and to count the status tabs.
 */
const STATS_FETCH_LIMIT = 1000;

/**
 * Regears list: Mine / Queue / History sections of Call-To-Arms deaths.
 *
 * Rows open the detail page, where the full item breakdown lives. Officers can
 * approve or reject straight from the row; approval credits the estimate, so it
 * asks for confirmation first. Guild settings are an admin page this view only
 * links to when the caller can manage them.
 */
@Component({
  selector: 'app-regears',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Dialog,
    DataTable,
    DataTableCell,
    FilterBar,
    Icon,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    .workbench-page > * {
      min-width: 0;
    }
    .regear-member {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
    }
    .regear-member__name {
      font-weight: 600;
      color: var(--color-text);
      text-decoration: none;
    }
    .regear-member__name:hover {
      text-decoration: underline;
    }
    .regear-member__build,
    .regear-value__paid {
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
    }
    .regear-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.375rem;
    }
  `,
  template: `
    <app-page-header
      [title]="t('regears.title')"
      [subtitle]="t('regears.subtitle')"
      [menuItems]="headerMenu()"
      (menuSelect)="onHeaderMenu($event)"
    >
      @if (canOpenNewRequest()) {
        <a class="btn btn--primary btn--sm" routerLink="/regears/new">
          <app-icon name="plus" size="0.875rem" />
          {{ t('regears.newRequest') }}
        </a>
      }
      <app-tabs
        pageTabs
        [ariaLabel]="t('regears.views')"
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack class="workbench-page">
      @if (loading() && deaths().length === 0) {
        <app-loading variant="summary" [label]="t('common.loading')" />
      } @else if (!loadFailed()) {
        <app-summary-band [items]="summaryItems()" [ariaLabel]="t('regears.summary.label')" />
      }

      <app-filter-bar
        [searchLabel]="t('regears.searchLabel')"
        [searchPlaceholder]="t('regears.searchPlaceholder')"
        [query]="search()"
        [activeCount]="activeFilterCount()"
        (queryChange)="onSearch($event)"
        (clear)="clearFilters()"
      >
        @if (statusOptions().length > 0) {
          <app-tabs
            filterPrimary
            variant="segmented"
            [ariaLabel]="t('regears.statusFilter')"
            [options]="statusOptions()"
            [active]="statusFilter()"
            (activeChange)="setStatus($event)"
          />
        }
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="deaths()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [pageSize]="pageSize"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [hideSearch]="true"
        [bordered]="true"
        [stickyFirstColumn]="true"
        [ariaLabel]="t('regears.tableLabel')"
        emptyIcon="shield"
        emptyLabel="regears.empty"
        [rowClickable]="true"
        (rowClick)="openDeath($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="player_name" let-row>
          <div class="regear-member">
            <a class="regear-member__name" [routerLink]="['/regears', row.id]">{{ row.player_name }}</a>
            <span class="inline-flex flex-wrap items-center gap-1.5">
              @if (row.primary_build_name) {
                <span class="regear-member__build">{{ row.primary_build_name }}</span>
              }
              @if (row.source === 'self_reported') {
                <span class="chip chip--neutral">{{ t('regears.source.selfReported') }}</span>
              }
            </span>
          </div>
        </ng-template>

        <ng-template dataTableCell="event" let-row>
          <span class="text-sm">{{ row.event_title }}</span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
        </ng-template>

        <ng-template dataTableCell="estimate" let-row>
          <div class="regear-value">
            <span class="num text-sm font-semibold">{{ formatSilver(row.auto_estimate_total) }}</span>
            @if (row.status === 'approved' && row.final_amount !== null) {
              <span class="regear-value__paid num">
                {{ t('regears.final') }}: {{ formatSilver(row.final_amount) }}
              </span>
            }
          </div>
        </ng-template>

        <ng-template dataTableCell="killed" let-row>
          <span class="num text-sm">{{ formatDate(row.killed_at) }}</span>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <div class="regear-actions">
            @if (canRequest(row)) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                (click)="requestRegear(row.id, $event)"
                [disabled]="acting()"
              >
                {{ t('regears.request') }}
              </button>
            } @else if (canAdjudicateRow(row)) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                (click)="askApprove(row)"
                [disabled]="acting()"
              >
                {{ t('regears.approve') }}
              </button>
            }
            <app-menu
              [items]="rowMenu(row)"
              [label]="t('regears.rowMenu', { name: row.player_name })"
              (itemSelect)="onRowMenu($event, row)"
            />
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (approveTarget(); as target) {
      <app-dialog [title]="t('regears.approveTitle')" size="sm" (closed)="closeApprove()">
        <div class="grid gap-3">
          <p class="text-sm">
            <span class="font-semibold">{{ target.player_name }}</span>
            · {{ target.event_title }}
          </p>
          <p class="text-sm text-[var(--color-text-secondary)]">{{ t('regears.approveBody') }}</p>
          <p class="text-sm">
            {{ t('regears.approveTotal') }}:
            <span class="num font-semibold">{{ formatSilver(approveTotal(target)) }}</span>
          </p>
        </div>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeApprove()">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="btn btn--primary"
            (click)="confirmApprove()"
            [disabled]="acting()"
          >
            {{ t('regears.approveConfirm') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (rejectTarget(); as target) {
      <app-dialog [title]="t('regears.rejectTitle')" size="sm" (closed)="closeReject()">
        <form id="regear-reject-form" class="grid gap-3" (submit)="confirmReject($event)">
          <p class="text-sm">
            <span class="font-semibold">{{ target.player_name }}</span>
            · {{ target.event_title }}
          </p>
          <p class="text-sm text-[var(--color-text-secondary)]">{{ t('regears.rejectWarning') }}</p>
          <label class="grid gap-1">
            <span class="label">{{ t('regears.rejectReason') }}</span>
            <textarea
              class="textarea"
              rows="3"
              required
              [value]="rejectNote()"
              (input)="onRejectNote($event)"
            ></textarea>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeReject()">{{ t('common.cancel') }}</button>
          <button
            type="submit"
            form="regear-reject-form"
            class="btn btn--danger"
            [disabled]="acting() || rejectNote().trim().length === 0"
          >
            {{ t('regears.reject') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Regears {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly tab = signal<RegearTab>('mine');
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly acting = signal(false);
  protected readonly deaths = signal<RegearDeathView[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly summary = signal<RegearBudgetSummary | null>(null);

  /** Officer decisions in progress (the dialogs render while these are set). */
  protected readonly approveTarget = signal<RegearDeathView | null>(null);
  protected readonly rejectTarget = signal<RegearDeathView | null>(null);
  protected readonly rejectNote = signal('');

  /**
   * Full (unpaginated, up to `STATS_FETCH_LIMIT`) dataset for the current
   * section's scope, used for the summary band and the status tab counts —
   * kept separate from `deaths()`, which holds just the table's current page.
   */
  private readonly statsDeaths = signal<RegearDeathView[]>([]);

  /** Free-text search, owned by the page and sent to the server. */
  protected readonly search = signal('');
  protected readonly statusFilter = signal<StatusFilter>('all');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly initialQuery = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: PAGE_SIZE,
  });
  private readonly tablePage = signal(this.initialQuery.page);
  private readonly tablePageSize = signal(this.initialQuery.pageSize);
  private readonly tableSort = signal<DataTablePageChange['sort']>(this.initialQuery.sort);

  protected readonly canAdjudicate = computed(() => this.auth.hasPermission('regear.adjudicate'));
  protected readonly canOpenNewRequest = computed(() => this.auth.hasPermission('regear.request'));
  protected readonly canManageSettings = computed(() =>
    this.auth.hasPermission('regear.settings.manage'),
  );
  protected readonly currentUserId = computed(() => this.auth.profile()?.user_id ?? null);

  protected readonly activeFilterCount = computed(() => (this.statusFilter() === 'all' ? 0 : 1));

  protected readonly tabOptions = computed<TabOption[]>(() => {
    const options: TabOption[] = [{ id: 'mine', label: this.t('regears.tab.mine') }];
    if (this.canAdjudicate()) {
      options.push(
        { id: 'queue', label: this.t('regears.tab.queue') },
        { id: 'history', label: this.t('regears.tab.history') },
      );
    }
    return options;
  });

  /**
   * Status switch shown next to the search. The queue is always pending, so it
   * has none. Counts come from the unpaginated stats fetch.
   */
  protected readonly statusOptions = computed<TabOption[]>(() => {
    const tab = this.tab();
    if (tab === 'queue') {
      return [];
    }
    const all = this.statsDeaths();
    const count = (status: RegearStatus) => all.filter((d) => d.status === status).length;
    if (tab === 'history') {
      return [
        { id: 'all', label: this.t('regears.status.all'), count: count('approved') + count('rejected') },
        { id: 'approved', label: this.t('regears.status.approved'), count: count('approved') },
        { id: 'rejected', label: this.t('regears.status.rejected'), count: count('rejected') },
      ];
    }
    return [
      { id: 'all', label: this.t('regears.status.all'), count: all.length },
      { id: 'available', label: this.t('regears.status.available'), count: count('available') },
      { id: 'pending', label: this.t('regears.status.pending'), count: count('pending') },
      { id: 'approved', label: this.t('regears.status.approved'), count: count('approved') },
      { id: 'rejected', label: this.t('regears.status.rejected'), count: count('rejected') },
    ];
  });

  /** Totals for the summary band; each section shows the figures its officers act on. */
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const all = this.statsDeaths();
    const pending = all.filter((d) => d.status === 'pending');
    const credited: SummaryItem = {
      label: this.t('regears.stat.totalReimbursed'),
      value: this.formatSilver(this.approvedTotal()),
      hint: this.t('regears.stat.approvedAmount'),
    };

    if (this.tab() === 'mine') {
      const summary = this.summary();
      return [
        {
          label: this.t('regears.budget.weekly'),
          value: `${summary?.weekly_balance ?? 0} / ${summary?.weekly_cap ?? 0}`,
          hint: this.t('regears.budget.weeklyHint'),
        },
        {
          label: this.t('regears.budget.bonus'),
          value: `${summary?.bonus_balance ?? 0} / ${summary?.bonus_cap ?? 0}`,
          hint: this.t('regears.budget.bonusHint'),
        },
        {
          label: this.t('regears.status.pending'),
          value: pending.length,
          hint: this.t('regears.summary.awaiting'),
          tone: pending.length > 0 ? 'warning' : 'default',
        },
        credited,
      ];
    }

    if (this.tab() === 'queue') {
      return [
        {
          label: this.t('regears.summary.awaiting'),
          value: pending.length,
          hint: this.t('regears.summary.queueHint'),
          tone: pending.length > 0 ? 'warning' : 'default',
        },
        {
          label: this.t('regears.summary.pendingValue'),
          value: this.formatSilver(
            pending.reduce((sum, d) => sum + (Number(d.auto_estimate_total) || 0), 0),
          ),
          hint: this.t('regears.summary.pendingValueHint'),
        },
        credited,
      ];
    }

    return [
      {
        label: this.t('regears.status.approved'),
        value: all.filter((d) => d.status === 'approved').length,
        hint: this.t('regears.summary.approvedHint'),
      },
      {
        label: this.t('regears.status.rejected'),
        value: all.filter((d) => d.status === 'rejected').length,
        hint: this.t('regears.summary.rejectedHint'),
      },
      credited,
    ];
  });

  /** Sums `final_amount` (the officer-approved payout), not the pre-adjudication estimate. */
  private readonly approvedTotal = computed(() =>
    this.statsDeaths().reduce((sum, d) => sum + (Number(d.final_amount) || 0), 0),
  );

  protected readonly headerMenu = computed<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { id: 'refresh', label: this.t('common.refreshNow'), icon: 'sparkles', disabled: this.loading() },
    ];
    if (this.canManageSettings()) {
      items.push({ id: 'settings', label: this.t('regears.settingsLink'), icon: 'settings' });
    }
    return items;
  });

  protected readonly trackById = (death: RegearDeathView): unknown => death.id;

  protected readonly canAdjudicateRow = (death: RegearDeathView): boolean =>
    this.canAdjudicate() && death.status === 'pending';

  protected readonly columns = computed<readonly DataTableColumn<RegearDeathView>[]>(() => [
    {
      key: 'player_name',
      label: 'common.player',
      sortable: true,
      searchable: true,
      accessor: (death) => death.player_name,
    },
    {
      key: 'event',
      label: 'regears.event',
      accessor: (death) => death.event_title,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (death) => death.status,
    },
    {
      key: 'estimate',
      label: 'regears.itemsValue',
      align: 'right',
      accessor: (death) => death.auto_estimate_total,
    },
    {
      key: 'killed',
      label: 'regears.killedAt',
      accessor: (death) => death.killed_at,
    },
    {
      key: 'actions',
      label: 'common.actions',
      align: 'right',
    },
  ]);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.searchTimer));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requested = params.get('tab') ?? 'mine';
      const tab = isRegearTab(requested) && (requested === 'mine' || this.canAdjudicate())
        ? requested
        : 'mine';
      if (tab !== this.tab()) {
        this.switchTab(tab);
      } else {
        void this.load();
      }
    });
  }

  protected switchTab(next: string): void {
    if (!isRegearTab(next)) {
      return;
    }
    if ((next === 'queue' || next === 'history') && !this.canAdjudicate()) {
      return;
    }
    this.tab.set(next);
    this.tablePage.set(1);
    this.search.set('');
    this.statusFilter.set('all');
    this.tableSort.set(null);
    void this.load();
  }

  protected setStatus(next: string): void {
    if (!this.statusOptions().some((option) => option.id === next)) {
      return;
    }
    this.statusFilter.set(next as StatusFilter);
    this.tablePage.set(1);
    void this.load();
  }

  protected onSearch(query: string): void {
    this.search.set(query);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.tablePage.set(1);
      void this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected clearFilters(): void {
    clearTimeout(this.searchTimer);
    this.search.set('');
    this.statusFilter.set('all');
    this.tablePage.set(1);
    void this.load();
  }

  protected onTableChange(event: DataTablePageChange): void {
    // Search lives in the filter bar and status in the tab switch; the table's own
    // search box is hidden, so its echoed search and column filters are ignored.
    this.tablePage.set(event.page);
    this.tablePageSize.set(event.pageSize);
    this.tableSort.set(event.sort);
    void this.load();
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    } else if (id === 'settings') {
      void this.router.navigate(['/admin/regears']);
    }
  }

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected openDeath(death: RegearDeathView): void {
    void this.router.navigate(['/regears', death.id]);
  }

  protected rowMenu(death: RegearDeathView): MenuItem[] {
    const items: MenuItem[] = [{ id: 'open', label: this.t('regears.viewDetails') }];
    if (this.canAdjudicateRow(death)) {
      items.push({ id: 'reject', label: this.t('regears.reject'), danger: true, separatorBefore: true });
    }
    return items;
  }

  protected onRowMenu(id: string, death: RegearDeathView): void {
    if (id === 'open') {
      this.openDeath(death);
    } else if (id === 'reject') {
      this.openReject(death);
    }
  }

  protected canRequest(death: RegearDeathView): boolean {
    return (
      this.tab() === 'mine' &&
      death.status === 'available' &&
      death.user_id === this.currentUserId() &&
      this.auth.hasPermission('regear.request')
    );
  }

  protected async requestRegear(deathId: number, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    if (this.acting()) {
      return;
    }
    this.acting.set(true);
    try {
      await firstValueFrom(this.api.post<RegearDeathView>(`api/regear/deaths/${deathId}/request`));
      this.toasts.success(this.t('regears.requested'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  /** The approved amount is the sum of included slots at their estimated prices. */
  protected approveTotal(death: RegearDeathView): number {
    return death.auto_estimate_breakdown
      .filter((row) => row.included)
      .reduce((sum, row) => sum + (Number(row.unit_price) || 0) * row.quantity, 0);
  }

  protected askApprove(death: RegearDeathView): void {
    this.approveTarget.set(death);
  }

  protected closeApprove(): void {
    this.approveTarget.set(null);
  }

  protected async confirmApprove(): Promise<void> {
    const death = this.approveTarget();
    if (!death || this.acting()) {
      return;
    }
    this.acting.set(true);
    try {
      const payload: AcceptRegearRequest = {
        final_amount: this.approveTotal(death),
        breakdown: death.auto_estimate_breakdown,
      };
      await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${death.id}/accept`, payload),
      );
      this.approveTarget.set(null);
      this.toasts.success(this.t('regears.accepted'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected openReject(death: RegearDeathView): void {
    this.rejectNote.set('');
    this.rejectTarget.set(death);
  }

  protected closeReject(): void {
    this.rejectTarget.set(null);
  }

  protected onRejectNote(event: Event): void {
    this.rejectNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirmReject(event: Event): Promise<void> {
    event.preventDefault();
    const death = this.rejectTarget();
    const note = this.rejectNote().trim();
    if (!death || !note || this.acting()) {
      return;
    }
    this.acting.set(true);
    try {
      const payload: RejectRegearRequest = { note };
      await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${death.id}/reject`, payload),
      );
      this.rejectTarget.set(null);
      this.toasts.success(this.t('regears.rejected'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected formatSilver(value: number | string | null): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return '—';
    }
    return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${this.t('regears.silver')}`;
  }

  protected formatDate(value: string | null): string {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
  }

  protected statusLabel(status: RegearStatus): string {
    switch (status) {
      case 'approved':
        return this.t('regears.status.approved');
      case 'rejected':
        return this.t('regears.status.rejected');
      case 'pending':
        return this.t('regears.status.pending');
      default:
        return this.t('regears.status.available');
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const tab = this.tab();
      const status = this.statusFilter();
      const sort = this.tableSort();
      const params: Record<string, string | number | boolean | undefined> = {
        page: this.tablePage(),
        limit: this.tablePageSize(),
        global: tab !== 'mine',
        search: this.search().trim() || undefined,
        sort: sort?.columnKey,
        order: sort?.direction,
      };
      if (tab === 'queue') {
        params['status'] = 'pending';
      } else if (tab === 'history') {
        params['history'] = true;
        if (status === 'approved' || status === 'rejected') {
          params['status'] = status;
        }
      } else if (status !== 'all') {
        params['status'] = status;
      }

      const page = await firstValueFrom(
        this.api.get<PaginatedData<RegearDeathView>>('api/regear/deaths', params),
      );
      this.deaths.set(page.items);
      this.totalItems.set(page.total_items);

      if (tab === 'mine') {
        const summary = await firstValueFrom(
          this.api.get<RegearBudgetSummary>('api/regear/me/summary'),
        );
        this.summary.set(summary);
      }

      await this.loadStats(params);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(this.t('common.error'));
      this.deaths.set([]);
      this.totalItems.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Fetches the full (well beyond one table page) dataset for the current
   * section's scope so the summary band and tab counts aggregate across every
   * matching death, not just the page shown in the table. Reuses the same
   * `global` scope as the table fetch but drops the status/search/sort
   * narrowing so every status is counted.
   */
  private async loadStats(
    tableParams: Record<string, string | number | boolean | undefined>,
  ): Promise<void> {
    try {
      const page = await firstValueFrom(
        this.api.get<PaginatedData<RegearDeathView>>('api/regear/deaths', {
          page: 1,
          limit: STATS_FETCH_LIMIT,
          global: tableParams['global'],
        }),
      );
      this.statsDeaths.set(page.items);
    } catch {
      // Summary and counts are supplementary; the table fetch above already surfaced any error.
    }
  }
}
