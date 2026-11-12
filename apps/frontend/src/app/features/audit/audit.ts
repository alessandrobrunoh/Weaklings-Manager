import { DatePipe, JsonPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PaginatedData, UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../shared/components/searchable-select/searchable-select';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

export interface AuditLog {
  id: number;
  action: string;
  entity_type?: string;
  entity_id?: number;
  split_id?: number;
  user_id?: number;
  details?: unknown;
  created_at: string;
}

const ACTION_FILTERS = [
  'WITHDRAW_REQUESTED',
  'WITHDRAW_ACCEPTED',
  'WITHDRAW_REJECTED',
  'TRANSACTION_CREATED',
  'EVENT_CREATED',
  'REGEAR_REQUESTED',
  'REGEAR_ACCEPTED',
  'REGEAR_REJECTED',
  'REGEAR_EXTRACTED',
  'REGEAR_SETTINGS_SET',
  'WARN_ISSUE',
  'WARN_REVOKE',
  'WARN_ESCALATION_ACK',
  'WARN_ESCALATION_OPEN',
  'PROGRESSION_SETTINGS_SET',
  'PROGRESSION_SEASON_CREATE',
  'PROGRESSION_SEASON_UPDATE',
  'PROGRESSION_SEASON_ACTIVATE',
  'PROGRESSION_ADJUST',
  'GUILD_SETTINGS_SET',
  'AUTOROLE_SET',
  'ROLE_CREATE',
  'ROLE_UPDATE',
  'ROLE_DELETE',
] as const;

const ENTITY_FILTERS = [
  'TRANSACTION',
  'EVENT',
  'REGEAR_DEATH',
  'REGEAR_SETTINGS',
  'PROGRESSION_SETTINGS',
  'PROGRESSION_SEASON',
  'PROGRESSION_ACCOUNT',
  'USER_WARN',
  'WARN_ESCALATION',
  'GUILD_SETTINGS',
  'ROLE',
] as const;

/** Debounce for the search box, so typing does not fire one request per key. */
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .audit-page {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--page-gap, 1rem);
    }
    .audit-page > app-page-stack {
      min-width: 0;
    }
    .audit-link {
      color: var(--color-primary);
      text-decoration: none;
    }
    .audit-link:hover {
      text-decoration: underline;
    }
    .audit-action {
      font-family: var(--font-mono);
      font-size: var(--ui-text-sm);
      overflow-wrap: anywhere;
    }
    .audit-time {
      white-space: nowrap;
    }
    .audit-facts {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 0.5rem 1rem;
      margin: 0 0 1rem;
      font-size: var(--ui-text-md);
    }
    .audit-facts dt {
      color: var(--color-text-secondary);
      font-size: var(--ui-text-sm);
      font-weight: 600;
    }
    .audit-facts dd {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .audit-json {
      margin: 0;
      max-height: 18rem;
      overflow: auto;
      padding: 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: var(--ui-text-sm);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  imports: [
    PageHeader,
    PageStack,
    DataTable,
    DataTableCell,
    DatePipe,
    JsonPipe,
    Icon,
    RouterLink,
    TooltipDirective,
    FilterBar,
    SearchableSelect,
    Dialog,
  ],
  template: `
    <div class="audit-page">
      <app-page-header [title]="t('audit.title')" [subtitle]="t('audit.subtitle')">
        <button
          type="button"
          class="btn btn--outline btn--sm"
          [disabled]="loading()"
          (click)="refreshNow()"
          [appTooltip]="t('common.refreshNow')"
          tooltipPosition="bottom"
        >
          <app-icon name="refresh" size="0.875rem" />
          {{ t('common.refreshNow') }}
        </button>
      </app-page-header>

      <app-page-stack>
        <app-filter-bar
          [searchLabel]="t('audit.filter.search')"
          [searchPlaceholder]="t('audit.filter.searchPlaceholder')"
          [query]="search()"
          [activeCount]="activeFacetCount()"
          (queryChange)="onSearch($event)"
          (clear)="clearFilters()"
        >
          <label class="filter-field">
            <span class="filter-field__label">{{ t('audit.filter.action') }}</span>
            <select class="select select--sm" [value]="actionFilter()" (change)="onActionChange($event)">
              <option value="">{{ t('audit.filter.allActions') }}</option>
              @for (value of actionFilters; track value) {
                <option [value]="value">{{ value }}</option>
              }
            </select>
          </label>

          <label class="filter-field">
            <span class="filter-field__label">{{ t('audit.filter.entity') }}</span>
            <select class="select select--sm" [value]="entityFilter()" (change)="onEntityChange($event)">
              <option value="">{{ t('audit.filter.allEntities') }}</option>
              @for (value of entityFilters; track value) {
                <option [value]="value">{{ value }}</option>
              }
            </select>
          </label>

          <div class="filter-field">
            <span class="filter-field__label">{{ t('audit.filter.actor') }}</span>
            <app-searchable-select
              [options]="actorOptions()"
              [value]="actorFilter()"
              [emptyLabel]="t('audit.filter.anyActor')"
              [searchPlaceholder]="t('common.search')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('picker.empty')"
              [ariaLabel]="t('audit.filter.actor')"
              (valueChange)="onActorChange($event)"
            />
          </div>

          <label class="filter-field">
            <span class="filter-field__label">{{ t('audit.filter.from') }}</span>
            <input type="date" class="input input--sm" [value]="dateFrom()" (change)="onDateChange('from', $event)" />
          </label>

          <label class="filter-field">
            <span class="filter-field__label">{{ t('audit.filter.to') }}</span>
            <input type="date" class="input input--sm" [value]="dateTo()" (change)="onDateChange('to', $event)" />
          </label>

          @if (dateFrom() || dateTo()) {
            <p class="hint">{{ t('audit.filter.dateHint') }}</p>
          }
        </app-filter-bar>

        <app-data-table
          [columns]="columns"
          [rows]="visibleLogs()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackById"
          [serverMode]="true"
          [hideSearch]="true"
          [totalItems]="totalItems()"
          [pageSize]="20"
          [ariaLabel]="t('audit.title')"
          mobileLayout="stack"
          emptyIcon="activity"
          (pageChange)="onTableChange($event)"
        >
          <ng-template dataTableCell="created_at" let-row>
            <time class="audit-time num" [attr.datetime]="row.created_at">{{ row.created_at | date: 'short' }}</time>
          </ng-template>
          <ng-template dataTableCell="user" let-row>
            @if (row.user_id) {
              <a class="audit-link" [routerLink]="['/users', row.user_id]">{{ actorName(row) }}</a>
            } @else {
              <span class="hint">{{ t('audit.system') }}</span>
            }
          </ng-template>
          <ng-template dataTableCell="action" let-row>
            <code class="audit-action">{{ row.action }}</code>
          </ng-template>
          <ng-template dataTableCell="entity" let-row>
            <span>{{ targetLabel(row) }}</span>
          </ng-template>
          <ng-template dataTableCell="details" let-row>
            @if (row.details) {
              <button type="button" class="btn btn--ghost btn--sm" (click)="selected.set(row)">
                {{ t('audit.details') }}
              </button>
            }
          </ng-template>
        </app-data-table>
      </app-page-stack>

      @if (selected(); as row) {
        <app-dialog [title]="t('audit.detailsTitle')" size="lg" (closed)="selected.set(null)">
          <dl class="audit-facts">
            <dt>{{ t('audit.date') }}</dt>
            <dd>{{ row.created_at | date: 'medium' }}</dd>
            <dt>{{ t('audit.actor') }}</dt>
            <dd>{{ row.user_id ? actorName(row) : t('audit.system') }}</dd>
            <dt>{{ t('audit.action') }}</dt>
            <dd><code class="audit-action">{{ row.action }}</code></dd>
            <dt>{{ t('audit.target') }}</dt>
            <dd>{{ targetLabel(row) }}</dd>
          </dl>
          @if (row.details) {
            <pre class="audit-json">{{ row.details | json }}</pre>
          } @else {
            <p class="hint">{{ t('audit.noDetails') }}</p>
          }
        </app-dialog>
      }
    </div>
  `,
})
export class Audit {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly actionFilters = ACTION_FILTERS;
  protected readonly entityFilters = ENTITY_FILTERS;

  protected readonly logs = signal<AuditLog[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly members = signal<UserProfile[]>([]);
  protected readonly selected = signal<AuditLog | null>(null);

  // Filter state lives on the page and mirrors the URL, so a filtered view can be shared.
  private readonly initialParams = this.route.snapshot.queryParamMap;
  protected readonly search = signal(this.initialParams.get('q') ?? '');
  protected readonly actionFilter = signal(this.initialParams.get('action') ?? '');
  protected readonly entityFilter = signal(this.initialParams.get('entity') ?? '');
  protected readonly actorFilter = signal(this.initialParams.get('actor') ?? '');
  protected readonly dateFrom = signal(this.initialParams.get('from') ?? '');
  protected readonly dateTo = signal(this.initialParams.get('to') ?? '');

  protected readonly activeFacetCount = computed(
    () =>
      [
        this.search(),
        this.actionFilter(),
        this.entityFilter(),
        this.actorFilter(),
        this.dateFrom(),
        this.dateTo(),
      ].filter((value) => value.trim() !== '').length,
  );

  protected readonly actorOptions = computed<SearchableSelectOption[]>(() =>
    this.members().map((member) => ({ id: String(member.id), label: member.username })),
  );

  private readonly memberNames = computed(
    () => new Map(this.members().map((member) => [member.id, member.username])),
  );

  /**
   * The API has no date-range parameter, so the date facets narrow the rows already loaded
   * for the current page. The filter bar hint says so.
   */
  protected readonly visibleLogs = computed(() => {
    const from = this.dateFrom() ? Date.parse(`${this.dateFrom()}T00:00:00`) : null;
    const to = this.dateTo() ? Date.parse(`${this.dateTo()}T23:59:59.999`) : null;
    if (from === null && to === null) {
      return this.logs();
    }
    return this.logs().filter((log) => {
      const time = Date.parse(log.created_at);
      if (Number.isNaN(time)) {
        return true;
      }
      return (from === null || time >= from) && (to === null || time <= to);
    });
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSeq = 0;

  private readonly tableQuery = signal<DataTablePageChange>(
    parseDataTableQuery(this.initialParams, {
      defaultPageSize: 20,
    }),
  );

  protected readonly columns: readonly DataTableColumn<AuditLog>[] = [
    {
      key: 'created_at',
      label: 'audit.date',
      sortable: true,
      accessor: (log) => log.created_at,
    },
    {
      key: 'user',
      label: 'audit.actor',
      sortable: true,
      accessor: (log) => String(log.user_id || ''),
    },
    {
      key: 'action',
      label: 'audit.action',
      sortable: true,
      accessor: (log) => log.action,
    },
    {
      key: 'entity',
      label: 'audit.target',
      sortable: true,
      accessor: (log) => log.entity_type || '',
    },
    {
      key: 'details',
      label: 'audit.details',
      sortable: false,
    },
  ];

  protected readonly trackById = (log: AuditLog): unknown => log.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
    });
    void this.loadMembers();
    void this.load();
  }

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected actorName(log: AuditLog): string {
    if (!log.user_id) {
      return this.t('audit.system');
    }
    return this.memberNames().get(log.user_id) ?? this.t('audit.userId', { id: log.user_id });
  }

  protected targetLabel(log: AuditLog): string {
    const parts: string[] = [];
    if (log.entity_type) {
      parts.push(`${log.entity_type}${log.entity_id != null ? ` #${log.entity_id}` : ''}`);
    }
    if (log.split_id != null) {
      parts.push(this.t('audit.splitId', { id: log.split_id }));
    }
    return parts.length ? parts.join(' · ') : '-';
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.applyServerFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onActionChange(event: Event): void {
    this.actionFilter.set((event.target as HTMLSelectElement).value);
    this.applyServerFilters();
  }

  protected onEntityChange(event: Event): void {
    this.entityFilter.set((event.target as HTMLSelectElement).value);
    this.applyServerFilters();
  }

  protected onActorChange(value: string): void {
    this.actorFilter.set(value);
    this.applyServerFilters();
  }

  protected onDateChange(which: 'from' | 'to', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (which === 'from') {
      this.dateFrom.set(value);
    } else {
      this.dateTo.set(value);
    }
    this.syncUrl();
  }

  protected clearFilters(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.search.set('');
    this.actionFilter.set('');
    this.entityFilter.set('');
    this.actorFilter.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.applyServerFilters();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.load();
  }

  /** Filters that the server understands restart at page 1 and reload. */
  private applyServerFilters(): void {
    this.tableQuery.update((query) => ({ ...query, page: 1 }));
    this.syncUrl();
    void this.load();
  }

  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: {
        q: this.search().trim() || null,
        action: this.actionFilter() || null,
        entity: this.entityFilter() || null,
        actor: this.actorFilter() || null,
        from: this.dateFrom() || null,
        to: this.dateTo() || null,
        page: null,
      },
    });
  }

  private async loadMembers(): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', { page: 1, limit: 100 }),
      );
      this.members.set(data.items ?? []);
    } catch {
      // The actor picker degrades to "Anyone" and the rows fall back to user ids.
      this.members.set([]);
    }
  }

  protected async load(): Promise<void> {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const query = this.tableQuery();
      const params: Record<string, string | number | boolean> = {
        page: query.page,
        limit: query.pageSize,
      };
      const search = this.search().trim();
      if (search) {
        params['search'] = search;
      }
      if (query.sort) {
        const sortKey =
          query.sort.columnKey === 'entity'
            ? 'entity_type'
            : query.sort.columnKey === 'user'
              ? 'user_id'
              : query.sort.columnKey;
        params['sort'] = sortKey;
        params['order'] = query.sort.direction;
      }
      if (this.actionFilter()) {
        params['action'] = this.actionFilter();
      }
      if (this.entityFilter()) {
        params['entity_type'] = this.entityFilter();
      }
      if (this.actorFilter()) {
        params['user_id'] = Number(this.actorFilter());
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<AuditLog>>('api/audit', params),
      );
      if (seq !== this.requestSeq) {
        return;
      }
      this.logs.set(data.items);
      this.totalItems.set(data.total_items);
    } catch {
      if (seq !== this.requestSeq) {
        return;
      }
      this.loadFailed.set(true);
      this.toasts.error(this.t('common.error'));
    } finally {
      if (seq === this.requestSeq) {
        this.loading.set(false);
      }
    }
  }
}
