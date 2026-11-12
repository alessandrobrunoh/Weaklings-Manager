import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateWarnRequest,
  PaginatedData,
  UserProfile,
  WarnEscalationView,
  WarnSeverity,
  WarnView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type WarnsTab = 'register' | 'escalations';
type WarnStatusFilter = 'all' | 'active' | 'revoked';

interface IssueDraft {
  userId: string;
  reason: string;
  severity: WarnSeverity;
  multiplier: string;
  expiresAt: string;
}

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

function emptyIssueDraft(): IssueDraft {
  return { userId: '', reason: '', severity: 'warn', multiplier: '', expiresAt: '' };
}

function isWarnsTab(value: string): value is WarnsTab {
  return value === 'register' || value === 'escalations';
}

function isWarnSeverity(value: string): value is WarnSeverity {
  return value === 'note' || value === 'warn' || value === 'strike';
}

function toStatusFilter(value: string | null): WarnStatusFilter {
  return value === 'active' || value === 'revoked' ? value : 'all';
}

/**
 * Guild warn register and escalation queue.
 *
 * Officers issue and revoke warns, and acknowledge threshold escalations after a manual
 * Albion/Discord kick. The URL is the single source of truth for the tab, the search, the
 * facets and the table's page, size and sort, so a filtered view can be shared and the page
 * reloads its data whenever the query changes. The page is role-gated at the route.
 */
@Component({
  selector: 'app-warns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DataTable,
    DataTableCell,
    Dialog,
    FilterBar,
    Icon,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    .warns-page {
      min-width: 0;
    }
  `,
  template: `
    <app-page-header
      [title]="t('warns.title')"
      [subtitle]="t('warns.subtitle')"
      [menuItems]="headerMenu()"
      (menuSelect)="onHeaderMenu($event)"
    >
      @if (canIssue() && tab() === 'register') {
        <button type="button" class="btn btn--primary btn--sm" (click)="openIssueForm()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('warns.issueWarning') }}
        </button>
      }
      <app-tabs
        pageTabs
        [ariaLabel]="t('warns.title')"
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack class="warns-page">
      @if (!canIssue()) {
        <p class="hint" role="status">{{ t('warns.missingManagePermission') }}</p>
      }

      @if (loaded() && !loadFailed()) {
        <app-summary-band [ariaLabel]="t('warns.summaryLabel')" [items]="summaryItems()" />
      } @else if (!loaded() && !loadFailed()) {
        <app-loading [variant]="'summary'" [label]="t('common.loading')" />
      }

      @if (tab() === 'register') {
        <app-filter-bar
          [searchLabel]="t('warns.searchLabel')"
          [searchPlaceholder]="t('warns.searchPlaceholder')"
          [query]="searchDraft()"
          [activeCount]="activeFilterCount()"
          (queryChange)="onSearch($event)"
          (clear)="clearFilters()"
        >
          <app-tabs
            filterPrimary
            [variant]="'segmented'"
            [ariaLabel]="t('warns.statusFilter')"
            [options]="statusOptions()"
            [active]="statusFilter()"
            (activeChange)="onStatusFilter($event)"
          />
          <label class="filter-field">
            <span class="filter-field__label">{{ t('warns.severity') }}</span>
            <select class="select select--sm" [value]="severityFilter()" (change)="onSeverityFilter($event)">
              <option value="">{{ t('warns.allSeverities') }}</option>
              <option value="note">{{ t('warns.severity.note') }}</option>
              <option value="warn">{{ t('warns.severity.warn') }}</option>
              <option value="strike">{{ t('warns.severity.strike') }}</option>
            </select>
          </label>
        </app-filter-bar>

        <app-data-table
          [columns]="columns()"
          [rows]="warns()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackById"
          [serverMode]="true"
          [hideSearch]="true"
          [totalItems]="warnTotal()"
          [pageSize]="20"
          [ariaLabel]="t('warns.register')"
          [mobileLayout]="'stack'"
          emptyIcon="alert"
          [emptyLabel]="hasFilters() ? 'warns.emptyNoMatch' : 'warns.empty'"
        >
          <ng-template dataTableCell="user" let-row>
            <a class="font-medium text-[var(--color-text)] hover:underline" [routerLink]="['/users', row.user_id]">{{ displayName(row.user_id, row.username) }}</a>
          </ng-template>
          <ng-template dataTableCell="reason" let-row>
            <span class="block">{{ row.reason }}</span>
            <span class="hint">{{ severityLabel(row.severity) }}</span>
          </ng-template>
          <ng-template dataTableCell="issued_by" let-row>
            {{ displayName(row.issued_by_user_id, row.issued_by_username) }}
          </ng-template>
          <ng-template dataTableCell="created_at" let-row>
            <span class="text-[var(--color-text-secondary)]">{{ row.created_at | date: 'short' }}</span>
          </ng-template>
          <ng-template dataTableCell="status" let-row>
            @if (row.revoked_at) {
              <app-status-chip value="revoked" [toneOverride]="'neutral'" [label]="t('warns.revoked')" />
            } @else {
              <app-status-chip value="active" [toneOverride]="'warning'" [label]="t('warns.active')" />
            }
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @let items = warnMenu(row);
            @if (items.length > 0) {
              <app-menu
                [items]="items"
                [label]="t('warns.rowActions', { name: displayName(row.user_id, row.username) })"
                (itemSelect)="onWarnAction(row, $event)"
              />
            } @else {
              <span class="hint">{{ t('bank.actions.none') }}</span>
            }
          </ng-template>
        </app-data-table>
      } @else {
        <app-data-table
          [columns]="escalationColumns"
          [rows]="escalations()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackEscalation"
          [serverMode]="true"
          [hideSearch]="true"
          [totalItems]="escalationTotal()"
          [pageSize]="20"
          [ariaLabel]="t('warns.escalations')"
          [mobileLayout]="'stack'"
          emptyIcon="alert"
          [emptyLabel]="'warns.escalations.empty'"
        >
          <ng-template dataTableCell="user" let-row>
            <a class="font-medium text-[var(--color-text)] hover:underline" [routerLink]="['/users', row.user_id]">{{ displayName(row.user_id, row.username) }}</a>
          </ng-template>
          <ng-template dataTableCell="opened_at" let-row>
            <span class="text-[var(--color-text-secondary)]">{{ row.opened_at | date: 'short' }}</span>
          </ng-template>
          <ng-template dataTableCell="status" let-row>
            @if (row.acknowledged_at) {
              <app-status-chip value="acked" [toneOverride]="'success'" [label]="t('warns.acked')" />
            } @else if (row.closed_reason) {
              <app-status-chip value="closed" [toneOverride]="'neutral'" [label]="row.closed_reason ?? ''" />
            } @else {
              <app-status-chip value="open" [toneOverride]="'error'" [label]="t('common.open')" />
            }
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @let items = escalationMenu(row);
            @if (items.length > 0) {
              <app-menu
                [items]="items"
                [label]="t('warns.rowActions', { name: displayName(row.user_id, row.username) })"
                (itemSelect)="onEscalationAction(row, $event)"
              />
            } @else {
              <span class="hint">{{ t('bank.actions.none') }}</span>
            }
          </ng-template>
        </app-data-table>
      }
    </app-page-stack>

    @if (showIssueForm()) {
      <app-dialog [title]="t('warns.issueWarning')" (closed)="closeIssueForm()">
        <form id="warn-issue-form" class="grid gap-3 sm:grid-cols-2" (submit)="onIssueSubmit($event)">
          <p class="hint sm:col-span-2">{{ t('validation.requiredLegend') }}</p>
          <label>
            <span class="label">{{ t('warns.user') }} <span class="text-[var(--color-error)]" aria-hidden="true">*</span></span>
            <select
              class="select"
              name="user_id"
              autofocus
              [value]="issueDraft().userId"
              (change)="updateIssue('userId', $event)"
              required
            >
              <option value="">{{ t('common.none') }}</option>
              @for (user of members(); track user.id) {
                <option [value]="user.id">{{ user.username }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('warns.severity') }}</span>
            <select
              class="select"
              name="severity"
              [value]="issueDraft().severity"
              (change)="updateIssue('severity', $event)"
            >
              <option value="note">{{ t('warns.severity.note') }}</option>
              <option value="warn">{{ t('warns.severity.warn') }}</option>
              <option value="strike">{{ t('warns.severity.strike') }}</option>
            </select>
          </label>
          <label class="sm:col-span-2">
            <span class="label">{{ t('warns.reason') }} <span class="text-[var(--color-error)]" aria-hidden="true">*</span></span>
            <input
              class="input"
              name="reason"
              required
              [value]="issueDraft().reason"
              (input)="updateIssue('reason', $event)"
            />
          </label>
          <label>
            <span class="label">{{ t('warns.multiplier') }} ({{ t('common.optional') }})</span>
            <input
              class="input"
              type="number"
              min="0"
              max="5"
              step="0.1"
              aria-describedby="warn-multiplier-hint"
              [value]="issueDraft().multiplier"
              (input)="updateIssue('multiplier', $event)"
            />
            <span class="hint" id="warn-multiplier-hint">{{ t('warns.multiplierHint') }}</span>
          </label>
          <label>
            <span class="label">{{ t('warns.expires') }} ({{ t('common.optional') }})</span>
            <input
              class="input"
              name="multiplier_expires_at"
              type="datetime-local"
              aria-describedby="warn-expires-hint"
              [value]="issueDraft().expiresAt"
              (input)="updateIssue('expiresAt', $event)"
            />
            <span class="hint" id="warn-expires-hint">{{ t('warns.expiresHint') }}</span>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeIssueForm()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" form="warn-issue-form" [disabled]="saving()">
            {{ t('warns.issueWarning') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (revokeId() !== null) {
      <app-dialog [title]="t('common.confirm')" (closed)="revokeId.set(null)">
        @if (revokeName(); as name) {
          <p>{{ t('warns.confirmRevokeNamed', { name }) }}</p>
        } @else {
          <p>{{ t('warns.confirmRevoke') }}</p>
        }
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="revokeId.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="revoke()">
            {{ t('warns.revoke') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Warns {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Query string of the page: tab, search, facets, and the table's page, size and sort. */
  private readonly params = toSignal(this.route.queryParamMap, { requireSync: true });

  protected readonly tab = computed<WarnsTab>(() => {
    const value = this.params().get('tab') ?? '';
    return isWarnsTab(value) ? value : 'register';
  });
  protected readonly search = computed(() => this.params().get('search') ?? '');
  protected readonly severityFilter = computed<WarnSeverity | ''>(() => {
    const value = this.params().get('severity') ?? '';
    return isWarnSeverity(value) ? value : '';
  });
  protected readonly statusFilter = computed(() => toStatusFilter(this.params().get('status')));
  protected readonly query = computed(() =>
    parseDataTableQuery(this.params(), { defaultPageSize: PAGE_SIZE }),
  );
  protected readonly hasFilters = computed(
    () =>
      this.search().trim() !== '' ||
      this.severityFilter() !== '' ||
      this.statusFilter() !== 'all',
  );
  protected readonly activeFilterCount = computed(
    () => (this.severityFilter() ? 1 : 0) + (this.statusFilter() !== 'all' ? 1 : 0),
  );

  /** What the search box shows while typing; the URL follows after a short pause. */
  protected readonly searchDraft = signal(this.route.snapshot.queryParamMap.get('search') ?? '');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly loadFailed = signal(false);
  private loadId = 0;

  protected readonly warns = signal<WarnView[]>([]);
  protected readonly warnTotal = signal(0);
  protected readonly escalations = signal<WarnEscalationView[]>([]);
  protected readonly escalationTotal = signal(0);
  protected readonly members = signal<UserProfile[]>([]);
  protected readonly saving = signal(false);
  protected readonly showIssueForm = signal(false);
  protected readonly issueDraft = signal<IssueDraft>(emptyIssueDraft());
  protected readonly ackingId = signal<number | null>(null);
  protected readonly revokingId = signal<number | null>(null);
  protected readonly revokeId = signal<number | null>(null);
  protected readonly revokeName = computed(() => {
    const id = this.revokeId();
    const warn = id === null ? undefined : this.warns().find((row) => row.id === id);
    return warn ? this.displayName(warn.user_id, warn.username) : '';
  });

  protected readonly trackById = (row: WarnView): unknown => row.id;
  protected readonly trackEscalation = (row: WarnEscalationView): unknown => row.id;

  protected readonly canIssue = computed(() => this.auth.hasPermission('warns.issue'));

  protected readonly tabOptions = computed<TabOption[]>(() => [
    { id: 'register', label: this.t('warns.register') },
    { id: 'escalations', label: this.t('warns.escalations') },
  ]);
  protected readonly statusOptions = computed<TabOption[]>(() => [
    { id: 'all', label: this.t('common.all') },
    { id: 'active', label: this.t('warns.active') },
    { id: 'revoked', label: this.t('warns.revoked') },
  ]);
  protected readonly headerMenu = computed<MenuItem[]>(() => [
    { id: 'refresh', label: this.t('common.refreshNow'), disabled: this.loading() },
  ]);

  /** Counts on the loaded page only: the server does not return totals per state. */
  protected readonly activeOnPage = computed(
    () => this.warns().filter((row) => !row.revoked_at).length,
  );
  protected readonly openOnPage = computed(
    () => this.escalations().filter((row) => !row.acknowledged_at && !row.closed_reason).length,
  );
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    if (this.tab() === 'register') {
      const active = this.activeOnPage();
      return [
        { label: this.t('warns.stat.total'), value: this.warnTotal(), hint: this.t('warns.stat.totalHint') },
        { label: this.t('warns.stat.activeOnPage'), value: active, hint: this.t('common.currentPage'), tone: active > 0 ? 'warning' : 'default' },
      ];
    }
    const open = this.openOnPage();
    return [
      { label: this.t('warns.stat.escalations'), value: this.escalationTotal(), hint: this.t('warns.stat.escalationsHint') },
      { label: this.t('warns.stat.openOnPage'), value: open, hint: this.t('common.currentPage'), tone: open > 0 ? 'warning' : 'default' },
    ];
  });

  protected readonly columns = computed<readonly DataTableColumn<WarnView>[]>(() => [
    {
      key: 'user',
      label: 'warns.user',
      accessor: (row) => this.displayName(row.user_id, row.username),
    },
    {
      key: 'reason',
      label: 'warns.reason',
      searchable: true,
      accessor: (row) => row.reason,
    },
    {
      key: 'issued_by',
      label: 'warns.issuedBy',
      accessor: (row) => this.displayName(row.issued_by_user_id, row.issued_by_username),
    },
    {
      key: 'created_at',
      label: 'warns.issued',
      sortable: true,
      accessor: (row) => row.created_at,
    },
    {
      key: 'status',
      label: 'warns.status',
      accessor: (row) => (row.revoked_at ? 'revoked' : 'active'),
    },
    {
      key: 'actions',
      label: 'common.actions',
    },
  ]);

  protected readonly escalationColumns: readonly DataTableColumn<WarnEscalationView>[] = [
    {
      key: 'opened_at',
      label: 'warns.opened',
      sortable: true,
      accessor: (row) => row.opened_at,
    },
    {
      key: 'user',
      label: 'warns.user',
      accessor: (row) => this.displayName(row.user_id, row.username),
    },
    {
      key: 'warn_count_at_time',
      label: 'warns.count',
      sortable: true,
      align: 'right',
      accessor: (row) => row.warn_count_at_time,
    },
    {
      key: 'threshold_at_time',
      label: 'warns.threshold',
      sortable: true,
      align: 'right',
      accessor: (row) => row.threshold_at_time,
    },
    {
      key: 'status',
      label: 'warns.status',
      accessor: (row) =>
        row.acknowledged_at ? 'acked' : row.closed_reason ? 'closed' : 'open',
    },
    {
      key: 'actions',
      label: 'common.actions',
    },
  ];

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    // Every query change (tab, search, facets, table page, size or sort) reloads the page.
    effect(() => {
      this.params();
      untracked(() => void this.load());
    });
    this.destroyRef.onDestroy(() => this.clearSearchTimer());
  }

  protected displayName(userId: number, username?: string | null): string {
    return username || `#${userId}`;
  }

  protected severityLabel(severity: WarnSeverity): string {
    if (severity === 'note') {
      return this.t('warns.severity.note');
    }
    if (severity === 'strike') {
      return this.t('warns.severity.strike');
    }
    return this.t('warns.severity.warn');
  }

  protected warnMenu(row: WarnView): MenuItem[] {
    if (!this.canIssue() || row.revoked_at) {
      return [];
    }
    return [{ id: 'revoke', label: this.t('warns.revoke'), danger: true }];
  }

  protected escalationMenu(row: WarnEscalationView): MenuItem[] {
    if (row.acknowledged_at || row.closed_reason) {
      return [];
    }
    return [{ id: 'ack', label: this.t('warns.ack'), disabled: this.ackingId() === row.id }];
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.load();
    }
  }

  protected onWarnAction(row: WarnView, id: string): void {
    if (id === 'revoke') {
      this.askRevoke(row.id);
    }
  }

  protected onEscalationAction(row: WarnEscalationView, id: string): void {
    if (id === 'ack') {
      void this.ack(row.id);
    }
  }

  protected switchTab(tab: string): void {
    if (!isWarnsTab(tab) || this.tab() === tab) {
      return;
    }
    this.clearSearchTimer();
    this.searchDraft.set('');
    this.navigateQuery({
      tab: tab === 'register' ? null : tab,
      page: null,
      sort: null,
      search: null,
      severity: null,
      status: null,
    });
  }

  protected onSearch(value: string): void {
    this.searchDraft.set(value);
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.navigateQuery({ search: value.trim(), page: 1 });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onSeverityFilter(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.navigateQuery({ severity: value || null, page: 1 });
  }

  protected onStatusFilter(id: string): void {
    this.navigateQuery({ status: id === 'all' ? null : id, page: 1 });
  }

  protected clearFilters(): void {
    this.clearSearchTimer();
    this.searchDraft.set('');
    this.navigateQuery({ search: '', severity: null, status: null, page: 1 });
  }

  protected async openIssueForm(): Promise<void> {
    this.showIssueForm.set(true);
    await this.loadMembers();
  }

  protected closeIssueForm(): void {
    this.showIssueForm.set(false);
    this.issueDraft.set(emptyIssueDraft());
  }

  protected updateIssue(field: keyof IssueDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.issueDraft.update((current) => ({ ...current, [field]: value }));
  }

  protected async load(): Promise<void> {
    const requestId = ++this.loadId;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      if (this.tab() === 'register') {
        const data = await firstValueFrom(
          this.api.get<PaginatedData<WarnView>>('api/warns', this.warnParams()),
        );
        if (requestId !== this.loadId) {
          return;
        }
        this.warns.set(data.items);
        this.warnTotal.set(data.total_items);
      } else {
        const data = await firstValueFrom(
          this.api.get<PaginatedData<WarnEscalationView>>(
            'api/warns/escalations',
            this.escalationParams(),
          ),
        );
        if (requestId !== this.loadId) {
          return;
        }
        this.escalations.set(data.items);
        this.escalationTotal.set(data.total_items);
      }
      this.loaded.set(true);
    } catch {
      if (requestId === this.loadId) {
        this.loadFailed.set(true);
      }
    } finally {
      if (requestId === this.loadId) {
        this.loading.set(false);
      }
    }
  }

  private warnParams(): Record<string, string | number | boolean> {
    const query = this.query();
    const params: Record<string, string | number | boolean> = {
      page: query.page,
      limit: query.pageSize,
    };
    const search = query.search.trim();
    if (search) {
      params['search'] = search;
    }
    if (query.sort) {
      params['sort'] = query.sort.columnKey;
      params['order'] = query.sort.direction;
    }
    const severity = this.severityFilter();
    if (severity) {
      params['severity'] = severity;
    }
    const status = this.statusFilter();
    if (status !== 'all') {
      params['revoked'] = status === 'revoked';
    }
    return params;
  }

  private escalationParams(): Record<string, string | number | boolean> {
    const query = this.query();
    const params: Record<string, string | number | boolean> = {
      page: query.page,
      limit: query.pageSize,
    };
    if (query.sort) {
      params['sort'] = query.sort.columnKey;
      params['order'] = query.sort.direction;
    }
    return params;
  }

  private async loadMembers(): Promise<void> {
    try {
      const members = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', { page: 1, limit: 100 }),
      );
      this.members.set(members.items ?? []);
    } catch {
      this.members.set([]);
    }
  }

  protected async onIssueSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const draft = this.issueDraft();
    const userId = Number(draft.userId);
    const reason = draft.reason.trim();
    if (!userId || !reason) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const body: CreateWarnRequest = {
      user_id: userId,
      reason,
      severity: draft.severity,
    };
    if (draft.multiplier.trim() !== '') {
      body.multiplier = Number(draft.multiplier);
    }
    if (draft.expiresAt.trim() !== '') {
      body.multiplier_expires_at = new Date(draft.expiresAt).toISOString();
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post<WarnView>('api/warns', body));
      this.closeIssueForm();
      this.toasts.success(this.t('warns.issueSuccess'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askRevoke(id: number): void {
    this.revokeId.set(id);
  }

  protected async revoke(): Promise<void> {
    const id = this.revokeId();
    this.revokeId.set(null);
    if (id === null || this.revokingId() !== null) {
      return;
    }
    this.revokingId.set(id);
    try {
      await firstValueFrom(this.api.post<WarnView>(`api/warns/${id}/revoke`, null));
      this.toasts.success(this.t('warns.revokeSuccess'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.revokingId.set(null);
    }
  }

  protected async ack(id: number): Promise<void> {
    if (this.ackingId() !== null) {
      return;
    }
    this.ackingId.set(id);
    try {
      await firstValueFrom(
        this.api.post<WarnEscalationView>(`api/warns/escalations/${id}/ack`, null),
      );
      this.toasts.success(this.t('warns.acked'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.ackingId.set(null);
    }
  }

  /** Writes query params (merged) so the URL, and with it the page's data, follows the control. */
  private navigateQuery(queryParams: Params): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
    });
  }

  private clearSearchTimer(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }
}
