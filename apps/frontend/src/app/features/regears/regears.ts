import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  PaginatedData,
  RegearBudgetSummary,
  RegearDeathView,
  RegearStatus,
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
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/** Tab toggle inside the Regears page. Settings live on `/admin/regears`. */
type RegearTab = 'mine' | 'queue' | 'history';

function isRegearTab(value: string): value is RegearTab {
  return value === 'mine' || value === 'queue' || value === 'history';
}

const PAGE_SIZE = 10;

/**
 * Backend exposes no guild-wide regear stats/summary endpoint (only the
 * paginated `/deaths` list and the per-user `/me/summary` budget). The stat
 * cards need a full, unfiltered-by-status picture, so a separate fetch pulls
 * a large enough page of the same tab-scoped dataset — independent of the
 * table's own small page size — to aggregate from.
 */
const STATS_FETCH_LIMIT = 1000;

/**
 * Regears list: Mine / Queue / History tables of Call-To-Arms deaths.
 *
 * Item breakdown and officer adjudication live on `/regears/:deathId`. Guild
 * settings are an admin page — this view only links there when the caller can
 * manage them.
 */
@Component({
  selector: 'app-regears',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DataTable,
    DataTableCell,
    Icon,
    PageHeader,
    PageStack,
    TooltipDirective,
    ViewToggle,
  ],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .status-pill--approved {
      background: var(--color-success-container);
      color: var(--color-success);
      border: 1px solid var(--color-success);
    }
    .status-pill--pending {
      background: var(--color-warning-container);
      color: var(--color-warning);
      border: 1px solid var(--color-warning);
    }
    .status-pill--rejected {
      background: var(--color-error-container);
      color: var(--color-error);
      border: 1px solid var(--color-error);
    }
  `,
  template: `
    <app-page-header
      [title]="t('regears.title')"
      [subtitle]="t('regears.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canManageSettings()) {
        <a
          class="btn btn--outline btn--sm"
          routerLink="/admin/regears"
          [appTooltip]="t('regears.settingsLink')"
          tooltipPosition="bottom"
        >
          <app-icon name="settings" size="0.875rem" />
          {{ t('regears.settingsLink') }}
        </a>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Regear summary">
        @if (tab() === 'mine') {
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.budget.event') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ (summary()?.per_event_used ?? 0) }} / {{ (summary()?.per_event_max ?? 0) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Event allowance
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-primary)] border border-[var(--color-primary)]">
                <app-icon name="shield" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.budget.month') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ (summary()?.per_month_used ?? 0) }} / {{ (summary()?.per_month_max ?? 0) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Monthly quota
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                <app-icon name="calendar" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.status.pending') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ pendingMineCount() }}
                </p>
                <p class="text-xs text-warning mt-1 truncate flex items-center gap-1.5">
                  @if (pendingMineCount() > 0) {
                    <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                  }
                  Awaiting review
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
                <app-icon name="alert" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.status.approved') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ approvedMineCount() }}
                </p>
                <p class="text-xs text-success mt-1 truncate">
                  Approved & paid
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
                <app-icon name="check" size="1.25rem" />
              </div>
            </div>
          </article>
        } @else {
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.stat.pending') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ tab() === 'queue' ? totalItems() : pendingMineCount() }}
                </p>
                <p class="text-xs text-warning mt-1 truncate flex items-center gap-1.5">
                  <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                  Queue to verify
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
                <app-icon name="alert" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.stat.approved') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ approvedMineCount() }}
                </p>
                <p class="text-xs text-success mt-1 truncate">
                  Reimbursed deaths
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
                <app-icon name="check" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.stat.rejected') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-(--color-text) mt-1">
                  {{ rejectedMineCount() }}
                </p>
                <p class="text-xs text-error mt-1 truncate">
                  Ineligible deaths
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-error-container)] text-error border border-[var(--color-error)]">
                <app-icon name="close" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('regears.stat.totalReimbursed') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-[var(--color-text-secondary)] mt-1">
                  {{ formatSilver(totalEstimatedValue()) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Total silver estimated
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                <app-icon name="bank" size="1.25rem" />
              </div>
            </div>
          </article>
        }
      </section>

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
        emptyIcon="shield"
        emptyLabel="regears.empty"
        [rowClickable]="true"
        (rowClick)="openDeath($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="player_name" let-row>
          <div class="flex flex-col gap-0.5">
            <span class="font-bold text-sm text-(--color-text) hover:underline cursor-pointer">{{ row.player_name }}</span>
            @if (row.primary_build_name) {
              <span class="text-xs text-[var(--color-text-secondary)] font-medium inline-flex items-center gap-1">
                <app-icon name="shield" size="0.75rem" class="text-[var(--color-text-tertiary)]" />
                {{ row.primary_build_name }}
              </span>
            }
          </div>
        </ng-template>

        <ng-template dataTableCell="event" let-row>
          <span class="font-medium text-xs text-[var(--color-text)]">{{ row.event_title }}</span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          @switch (row.status) {
            @case ('approved') {
              <span class="status-pill status-pill--approved">
                <app-icon name="check" size="0.75rem" />
                {{ statusLabel(row.status) }}
              </span>
            }
            @case ('pending') {
              <span class="status-pill status-pill--pending">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] animate-pulse"></span>
                {{ statusLabel(row.status) }}
              </span>
            }
            @case ('rejected') {
              <span class="status-pill status-pill--rejected">
                <app-icon name="close" size="0.75rem" />
                {{ statusLabel(row.status) }}
              </span>
            }
            @default {
              <span class="status-pill status-pill--pending">
                {{ statusLabel(row.status) }}
              </span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="estimate" let-row>
          <span class="font-mono text-sm font-semibold text-success">{{ formatSilver(row.auto_estimate_total) }}</span>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          @if (canRequest(row)) {
            <button
              type="button"
              class="btn btn--primary btn--sm"
              (click)="requestRegear(row.id, $event)"
              [disabled]="acting()"
            >
              {{ t('regears.request') }}
            </button>
          } @else {
            <span class="btn btn--ghost btn--sm text-xs inline-flex items-center gap-1">
              <span>{{ t('common.open') }}</span>
              &rarr;
            </span>
          }
        </ng-template>
      </app-data-table>
    </app-page-stack>
  `,
})
export class Regears {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly tab = signal<RegearTab>('mine');
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly acting = signal(false);
  protected readonly deaths = signal<RegearDeathView[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly summary = signal<RegearBudgetSummary | null>(null);

  /**
   * Full (unpaginated, up to `STATS_FETCH_LIMIT`) dataset for the current
   * tab's scope, used only to aggregate the stat cards below — kept separate
   * from `deaths()`, which holds just the table's current page.
   */
  private readonly statsDeaths = signal<RegearDeathView[]>([]);

  protected readonly pendingMineCount = computed(
    () => this.statsDeaths().filter((d) => d.status === 'pending').length,
  );
  protected readonly approvedMineCount = computed(
    () => this.statsDeaths().filter((d) => d.status === 'approved').length,
  );
  protected readonly rejectedMineCount = computed(
    () => this.statsDeaths().filter((d) => d.status === 'rejected').length,
  );
  /** Sums `final_amount` (the officer-approved payout), not the pre-adjudication estimate. */
  protected readonly totalEstimatedValue = computed(() =>
    this.statsDeaths().reduce((sum, d) => sum + (Number(d.final_amount) || 0), 0),
  );

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected readonly trackById = (death: RegearDeathView): unknown => death.id;

  private readonly tablePage = signal(1);
  private readonly tablePageSize = signal(PAGE_SIZE);
  private readonly tableSearch = signal('');
  private readonly tableSort = signal<DataTablePageChange['sort']>(null);
  private readonly tableFilters = signal<Readonly<Record<string, string>>>({});

  protected readonly canAdjudicate = computed(() => this.auth.hasPermission('regear.adjudicate'));
  protected readonly canManageSettings = computed(() =>
    this.auth.hasPermission('regear.settings.manage'),
  );
  protected readonly currentUserId = computed(() => this.auth.profile()?.user_id ?? null);

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => {
    const options: ViewToggleOption[] = [{ id: 'mine', label: this.t('regears.tab.mine') }];
    if (this.canAdjudicate()) {
      options.push(
        { id: 'queue', label: this.t('regears.tab.queue') },
        { id: 'history', label: this.t('regears.tab.history') },
      );
    }
    return options;
  });

  protected readonly columns = computed<readonly DataTableColumn<RegearDeathView>[]>(() => {
    const statusOptions = this.statusFilterOptions();
    return [
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
        filterOptions: statusOptions.length > 0 ? statusOptions : undefined,
      },
      {
        key: 'estimate',
        label: 'regears.estimate',
        align: 'right',
        accessor: (death) => death.auto_estimate_total,
      },
      {
        key: 'actions',
        label: 'common.actions',
        align: 'right',
      },
    ];
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
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
    this.tableSearch.set('');
    this.tableSort.set(null);
    this.tableFilters.set({});
    void this.load();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tablePage.set(event.page);
    this.tablePageSize.set(event.pageSize);
    this.tableSearch.set(event.search);
    this.tableSort.set(event.sort);
    this.tableFilters.set(event.columnFilters);
    void this.load();
  }

  protected openDeath(death: RegearDeathView): void {
    void this.router.navigate(['/regears', death.id]);
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
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
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
      return String(value);
    }
    return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${this.t('regears.silver')}`;
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

  protected statusChipClass(status: RegearDeathView['status']): string {
    switch (status) {
      case 'approved':
        return 'chip--success';
      case 'rejected':
        return 'chip--error';
      case 'pending':
        return 'chip--warning';
      default:
        return '';
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const tab = this.tab();
      const sort = this.tableSort();
      const statusFilter = this.tableFilters()['status'] as RegearStatus | undefined;
      const params: Record<string, string | number | boolean | undefined> = {
        page: this.tablePage(),
        limit: this.tablePageSize(),
        global: tab !== 'mine',
        search: this.tableSearch().trim() || undefined,
        sort: sort?.columnKey,
        order: sort?.direction,
      };
      if (tab === 'queue') {
        params['status'] = 'pending';
      } else if (tab === 'history') {
        params['history'] = true;
        if (statusFilter === 'approved' || statusFilter === 'rejected') {
          params['status'] = statusFilter;
        }
      } else if (statusFilter) {
        params['status'] = statusFilter;
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
      this.toasts.error(this.errorMessage(error));
      this.deaths.set([]);
      this.totalItems.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Fetches the full (well beyond one table page) dataset for the current
   * tab's scope so the stat cards aggregate across every matching death, not
   * just the page currently shown in the table. Reuses the same `global`
   * scope as the table fetch (own deaths for "mine", guild-wide otherwise)
   * but drops the status/search/sort narrowing so every status is counted.
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
      // Stat cards are supplementary; the table fetch above already surfaced any error.
    }
  }

  private statusFilterOptions(): { value: string; label: string }[] {
    const tab = this.tab();
    if (tab === 'queue') {
      return [];
    }
    if (tab === 'history') {
      return [
        { value: 'approved', label: this.t('regears.status.approved') },
        { value: 'rejected', label: this.t('regears.status.rejected') },
      ];
    }
    return [
      { value: 'available', label: this.t('regears.status.available') },
      { value: 'pending', label: this.t('regears.status.pending') },
      { value: 'approved', label: this.t('regears.status.approved') },
      { value: 'rejected', label: this.t('regears.status.rejected') },
    ];
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return this.t('common.error');
  }
}
