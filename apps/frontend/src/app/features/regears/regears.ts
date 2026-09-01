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
    StatCard,
    TooltipDirective,
    ViewToggle,
  ],
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
        >{{ t('regears.settingsLink') }}</a>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Regear summary">
        @if (tab() === 'mine') {
          <app-stat-card
            [label]="t('regears.budget.event')"
            [value]="(summary()?.per_event_used ?? 0) + ' / ' + (summary()?.per_event_max ?? 0)"
            icon="shield"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('regears.budget.month')"
            [value]="(summary()?.per_month_used ?? 0) + ' / ' + (summary()?.per_month_max ?? 0)"
            icon="calendar"
            tone="primary"
          />
          <app-stat-card
            [label]="t('regears.status.pending')"
            [value]="pendingMineCount()"
            icon="alert"
            tone="warning"
          />
          <app-stat-card
            [label]="t('regears.status.approved')"
            [value]="approvedMineCount()"
            icon="check"
            tone="success"
          />
        } @else {
          <app-stat-card
            [label]="t('regears.stat.pending')"
            [value]="tab() === 'queue' ? totalItems() : pendingMineCount()"
            icon="alert"
            tone="warning"
          />
          <app-stat-card
            [label]="t('regears.stat.approved')"
            [value]="approvedMineCount()"
            icon="check"
            tone="success"
          />
          <app-stat-card
            [label]="t('regears.stat.rejected')"
            [value]="rejectedMineCount()"
            icon="close"
            tone="danger"
          />
          <app-stat-card
            [label]="t('regears.stat.totalReimbursed')"
            [value]="formatSilver(totalEstimatedValue())"
            icon="bank"
            tone="neutral"
          />
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
            <span class="font-bold text-sm text-[var(--color-text)]">{{ row.player_name }}</span>
            @if (row.primary_build_name) {
              <span class="text-xs text-[var(--color-text-secondary)] font-medium">{{ row.primary_build_name }}</span>
            }
          </div>
        </ng-template>
        <ng-template dataTableCell="event" let-row>
          <span class="font-medium text-sm text-[var(--color-text)]">{{ row.event_title }}</span>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <span class="chip" [class]="statusChipClass(row.status)">{{ statusLabel(row.status) }}</span>
        </ng-template>
        <ng-template dataTableCell="estimate" let-row>
          <span class="font-bold font-mono text-sm text-[var(--color-text)]">{{ formatSilver(row.auto_estimate_total) }}</span>
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
            <span class="btn btn--ghost btn--sm text-xs">{{ t('common.open') }}</span>
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

  protected readonly pendingMineCount = computed(
    () => this.deaths().filter((d) => d.status === 'pending').length,
  );
  protected readonly approvedMineCount = computed(
    () => this.deaths().filter((d) => d.status === 'approved').length,
  );
  protected readonly rejectedMineCount = computed(
    () => this.deaths().filter((d) => d.status === 'rejected').length,
  );
  protected readonly totalEstimatedValue = computed(() =>
    this.deaths().reduce((sum, d) => sum + (Number(d.auto_estimate_total) || 0), 0),
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
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(this.errorMessage(error));
      this.deaths.set([]);
      this.totalItems.set(0);
    } finally {
      this.loading.set(false);
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
