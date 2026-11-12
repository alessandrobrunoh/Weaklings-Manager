import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  DiscordMemberView,
  PaginatedData,
  Role,
  UserProfile,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
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
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { searchAlbionPlayers } from '../../shared/albion/albion-player-search';

import { BlockUserDialog } from './block-user-dialog';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

const ROLE_FILTERS: readonly { value: Role; label: string }[] = [
  { value: 'SuperAdmin', label: 'SuperAdmin' },
  { value: 'Admin', label: 'Admin' },
  { value: 'Officer', label: 'Officer' },
  { value: 'Member', label: 'Member' },
];

/**
 * Guild member directory.
 *
 * Server-paged against `GET /api/users`. The table owns page, page size and sort, mirrored to the
 * URL. Search (`search`), the role facet (`role`) and the status facet (`status`) are also URL
 * params, so a shared link restores the same list. Row click and the name link open the
 * view-first member page at `/users/:userId`; blocking is in the row's "more actions" menu.
 */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    BlockUserDialog,
    Dialog,
    FilterBar,
    Icon,
    Menu,
    PageHeader,
    PageStack,
    DataTable,
    DataTableCell,
    RouterLink,
    SearchableSelect,
    StatusChip,
    SummaryBand,
  ],
  styles: `
    .workbench-page {
      min-width: 0;
      overflow: hidden;
    }
    .workbench-page > section,
    .workbench-page > app-data-table,
    .workbench-page > app-filter-bar,
    .workbench-page > app-summary-band {
      min-width: 0;
    }
  `,
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
      [menuItems]="headerMenuItems()"
      (menuSelect)="onHeaderAction($event)"
    >
      @if (canCreate()) {
        <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('users.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack class="workbench-page">
      @if (!loading() && !loadFailed()) {
        <app-summary-band [ariaLabel]="t('users.summaryLabel')" [items]="summaryItems()" />
      }

      <app-filter-bar
        [searchLabel]="t('users.searchLabel')"
        [searchPlaceholder]="t('users.searchPlaceholder')"
        [query]="searchText()"
        [activeCount]="activeCount()"
        (queryChange)="onSearchText($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('common.role') }}</span>
          <select class="select select--sm" [value]="roleFilter()" (change)="onRoleFilter($event)">
            <option value="">{{ t('common.all') }}</option>
            @for (option of roleFilters; track option.value) {
              <option [value]="option.value">{{ option.label }}</option>
            }
          </select>
        </label>
        @if (canBlock()) {
          <label class="filter-field">
            <span class="filter-field__label">{{ t('users.status') }}</span>
            <select class="select select--sm" [value]="statusFilter()" (change)="onStatusFilter($event)">
              <option value="">{{ t('common.all') }}</option>
              <option value="active">{{ t('users.status.active') }}</option>
              <option value="blocked">{{ t('users.status.blocked') }}</option>
            </select>
          </label>
        }
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="users()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [pageSize]="pageSize"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [hideSearch]="true"
        mobileLayout="stack"
        [ariaLabel]="t('users.title')"
        emptyIcon="users"
        [rowClickable]="true"
        (rowClick)="openMember($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="username" let-row>
          <div class="flex min-w-0 items-center gap-2.5">
            <app-avatar [userId]="row.id" [username]="row.username" size="sm" />
            <a
              class="min-w-0 truncate font-medium text-[var(--color-text)] underline-offset-2 hover:underline"
              [routerLink]="['/users', row.id]"
            >
              {{ row.username }}
            </a>
          </div>
        </ng-template>

        <ng-template dataTableCell="email" let-row>
          <span class="font-mono text-xs text-[var(--color-text-secondary)]">{{ row.email ?? '' }}</span>
        </ng-template>

        <ng-template dataTableCell="role" let-row>
          <app-status-chip [value]="row.role" [label]="row.role" toneOverride="neutral" [showDot]="false" />
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          @if (row.blocked) {
            <app-status-chip value="blocked" toneOverride="error" [label]="t('users.status.blocked')" />
          } @else {
            <app-status-chip value="active" toneOverride="success" [label]="t('users.status.active')" />
          }
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <app-menu
            [items]="rowMenuItems(row)"
            [label]="t('users.rowActions', { name: row.username })"
            (itemSelect)="onRowAction(row, $event)"
          />
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (blockTarget(); as target) {
      <app-block-user-dialog
        [member]="target.member"
        [mode]="target.mode"
        (updated)="onBlockUpdated()"
        (closed)="blockTarget.set(null)"
      />
    }

    @if (createOpen()) {
      <app-dialog
        [title]="t('users.create')"
        [subtitle]="t('users.create.hint')"
        icon="users"
        (closed)="closeCreate()"
      >
        <form id="create-member-form" class="grid gap-3" (submit)="createMember($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('validation.requiredLegend') }}</p>
          <label>
            <span class="label">{{ t('users.create.discord') }} <span class="text-[var(--color-error)]" aria-hidden="true">*</span></span>
            <app-searchable-select
              [options]="discordOptions()"
              [value]="selectedDiscordId()"
              [allowEmpty]="false"
              [loading]="discordLoading()"
              [searchPlaceholder]="t('users.create.discordPlaceholder')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('users.create.discordEmpty')"
              [ariaLabel]="t('users.create.discord')"
              [required]="true"
              (valueChange)="selectedDiscordId.set($event)"
            />
          </label>
          <label>
            <span class="label">{{ t('users.create.albion') }} <span class="text-[var(--color-error)]" aria-hidden="true">*</span></span>
            <app-searchable-select
              [options]="albionOptions()"
              [value]="selectedAlbionId()"
              [allowEmpty]="false"
              [loading]="albionLoading()"
              [searchPlaceholder]="t('users.create.albionPlaceholder')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('users.create.albionEmpty')"
              [ariaLabel]="t('users.create.albion')"
              [required]="true"
              [remote]="true"
              (searchChange)="onAlbionSearch($event)"
              (valueChange)="selectedAlbionId.set($event)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-member-form"
            [disabled]="creating()"
          >
            {{ t('users.create.submit') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly canCreate = computed(() => this.auth.hasPermission('users.create'));
  /** Blocking is gated by `roles.manage`, the same permission as role assignment. */
  protected readonly canBlock = computed(() => this.auth.hasPermission('roles.manage'));
  protected readonly ownUserId = computed(() => this.auth.profile()?.user_id ?? null);
  /** The member the block/unblock dialog is open for. */
  protected readonly blockTarget = signal<{
    member: UserProfile;
    mode: 'block' | 'unblock';
  } | null>(null);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly roleFilters = ROLE_FILTERS;
  protected readonly users = signal<UserProfile[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);

  protected readonly adminCount = computed(
    () => this.users().filter((u) => u.role === 'SuperAdmin' || u.role === 'Admin').length,
  );
  protected readonly officerCount = computed(
    () => this.users().filter((u) => u.role === 'Officer').length,
  );
  protected readonly memberCount = computed(
    () => this.users().filter((u) => u.role === 'Member').length,
  );

  protected readonly trackById = (user: UserProfile): unknown => user.id;

  private readonly initialQuery = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: PAGE_SIZE,
    filterKeys: ['role', 'status'],
  });
  private readonly tablePage = signal(this.initialQuery.page);
  private readonly tablePageSize = signal(this.initialQuery.pageSize);
  private readonly tableSearch = signal(this.initialQuery.search);
  private readonly tableSort = signal<DataTablePageChange['sort']>(this.initialQuery.sort);
  private loadRequest = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Facet and search state the filter bar shows; mirrored to the URL. */
  protected readonly searchText = signal(this.initialQuery.search);
  protected readonly roleFilter = signal(this.initialQuery.columnFilters['role'] ?? '');
  protected readonly statusFilter = signal(this.initialQuery.columnFilters['status'] ?? '');
  /** Filters in force, for the filter bar badge and clear button. Status only counts for `roles.manage`. */
  protected readonly activeCount = computed(
    () =>
      (this.searchText().trim() ? 1 : 0) +
      (this.roleFilter() ? 1 : 0) +
      (this.canBlock() && this.statusFilter() ? 1 : 0),
  );

  private readonly emailColumn: DataTableColumn<UserProfile> = {
    key: 'email',
    label: 'common.email',
    accessor: (user) => user.email ?? '',
  };

  private readonly baseColumns: readonly DataTableColumn<UserProfile>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      searchable: true,
      accessor: (user) => user.username,
    },
    {
      key: 'role',
      label: 'common.role',
      sortable: true,
      accessor: (user) => user.role,
    },
    {
      key: 'actions',
      label: 'common.actions',
      accessor: () => '',
    },
  ];

  /** Blocked state is only reported to `roles.manage` holders, so only they get the column. */
  private readonly statusColumn = computed<DataTableColumn<UserProfile>>(() => ({
    key: 'status',
    label: 'users.status',
    accessor: (user) => (user.blocked ? 'blocked' : 'active'),
  }));

  /**
   * Emails are only returned to `users.create`/`roles.manage` holders (plus a member's own row), so
   * the column is hidden for everyone else instead of rendering a column of blanks.
   */
  protected readonly columns = computed<readonly DataTableColumn<UserProfile>[]>(() => {
    const [username, role, actions] = this.baseColumns;
    const showEmail =
      this.auth.hasPermission('users.create') || this.auth.hasPermission('roles.manage');
    return [
      username,
      ...(showEmail ? [this.emailColumn] : []),
      role,
      ...(this.canBlock() ? [this.statusColumn()] : []),
      actions,
    ];
  });

  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => [
    { label: this.t('users.stat.total'), value: this.totalItems(), hint: this.t('common.totalResults') },
    { label: this.t('users.stat.admins'), value: this.adminCount(), hint: this.t('common.currentPage') },
    { label: this.t('users.stat.officers'), value: this.officerCount(), hint: this.t('common.currentPage') },
    { label: this.t('users.stat.members'), value: this.memberCount(), hint: this.t('common.currentPage') },
  ]);

  protected readonly headerMenuItems = computed<readonly MenuItem[]>(() => [
    { id: 'refresh', label: this.t('common.refreshNow'), icon: 'sparkles', disabled: this.loading() },
  ]);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly discordLoading = signal(false);
  protected readonly albionLoading = signal(false);
  protected readonly discordMembers = signal<DiscordMemberView[]>([]);
  /** The guild roster, shown while the search box is empty. */
  protected readonly albionMembers = signal<AlbionGuildMember[]>([]);
  /** Matches from the all-players search; `null` while the box is empty. */
  private readonly albionMatches = signal<AlbionGuildMember[] | null>(null);
  /** Every character seen in this dialog, so the chosen one keeps its name when the list changes. */
  private readonly albionNames = new Map<string, string>();
  private albionSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private albionSearchRequest = 0;
  protected readonly selectedDiscordId = signal('');
  protected readonly selectedAlbionId = signal('');

  protected readonly discordOptions = computed(() =>
    this.discordMembers().map((member) => ({
      id: member.id,
      label: member.display_name,
      hint: member.display_name === member.username ? undefined : member.username,
    })),
  );

  protected readonly albionOptions = computed(() => {
    const shown = this.albionMatches() ?? this.albionMembers();
    const selected = this.selectedAlbionId();
    const options = shown.map((member) => ({
      id: member.id,
      label: member.name,
      hint: member.guild_name ? member.guild_name : undefined,
    }));
    const name = selected ? this.albionNames.get(selected) : undefined;
    if (selected && name && !options.some((option) => option.id === selected)) {
      options.unshift({ id: selected, label: name, hint: undefined });
    }
    return options;
  });

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.searchTimer));
    void this.load();
  }

  protected openMember(row: UserProfile): void {
    void this.router.navigate(['/users', row.id]);
  }

  /** Row actions: block or unblock, never on the caller's own row. */
  protected rowMenuItems(row: UserProfile): readonly MenuItem[] {
    if (!this.canBlock() || row.id === this.ownUserId()) {
      return [];
    }
    return row.blocked
      ? [{ id: 'unblock', label: this.t('users.unblock.action'), icon: 'check' }]
      : [{ id: 'block', label: this.t('users.block.action'), icon: 'user-x', danger: true }];
  }

  protected onRowAction(row: UserProfile, id: string): void {
    if (id === 'block' || id === 'unblock') {
      this.blockTarget.set({ member: row, mode: id });
    }
  }

  protected onHeaderAction(id: string): void {
    if (id === 'refresh') {
      void this.load();
    }
  }

  protected onBlockUpdated(): void {
    void this.load();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tablePage.set(event.page);
    this.tablePageSize.set(event.pageSize);
    this.tableSearch.set(event.search);
    this.tableSort.set(event.sort);
    void this.load();
  }

  /** Typing updates the box at once; the URL (and so the table) follows after a short pause. */
  protected onSearchText(text: string): void {
    this.searchText.set(text);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.writeFilterQuery({ search: text.trim() || null });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onRoleFilter(event: Event): void {
    this.roleFilter.set((event.target as HTMLSelectElement).value);
    this.applyFacets();
  }

  protected onStatusFilter(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
    this.applyFacets();
  }

  protected clearFilters(): void {
    clearTimeout(this.searchTimer);
    this.searchText.set('');
    this.roleFilter.set('');
    this.statusFilter.set('');
    this.tableSearch.set('');
    this.tablePage.set(1);
    this.writeFilterQuery({ search: null, role: null, status: null });
    void this.load();
  }

  private applyFacets(): void {
    this.tablePage.set(1);
    this.writeFilterQuery({
      role: this.roleFilter() || null,
      status: this.canBlock() ? this.statusFilter() || null : null,
    });
    void this.load();
  }

  /** Writes the search and facet params and restarts paging, so a shared link restores the list. */
  private writeFilterQuery(params: Record<string, string | null>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...params, page: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected openCreate(): void {
    this.createOpen.set(true);
    this.selectedDiscordId.set('');
    this.selectedAlbionId.set('');
    this.albionMatches.set(null);
    void this.loadCreateOptions();
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
    this.creating.set(false);
    clearTimeout(this.albionSearchTimer);
  }

  /**
   * Searches every Albion player, not just the guild roster, so a recruit who has not joined the
   * guild yet can still be provisioned. The roster stays as the list for an empty box.
   */
  protected onAlbionSearch(text: string): void {
    clearTimeout(this.albionSearchTimer);
    const query = text.trim();
    const request = ++this.albionSearchRequest;
    if (!query) {
      this.albionMatches.set(null);
      this.albionLoading.set(false);
      return;
    }
    this.albionSearchTimer = setTimeout(() => {
      this.albionLoading.set(true);
      void searchAlbionPlayers(this.api, query)
        .then((players) => {
          if (request !== this.albionSearchRequest) {
            return;
          }
          for (const player of players) {
            this.albionNames.set(player.id, player.name);
          }
          this.albionMatches.set(
            players.map((player) => ({
              id: player.id,
              name: player.name,
              guild_name: player.guild_name,
            })),
          );
        })
        .catch((error: unknown) => {
          if (request === this.albionSearchRequest) {
            this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
          }
        })
        .finally(() => {
          if (request === this.albionSearchRequest) {
            this.albionLoading.set(false);
          }
        });
    }, 250);
  }

  protected async createMember(event: Event): Promise<void> {
    event.preventDefault();
    const discordId = this.selectedDiscordId();
    const albionId = this.selectedAlbionId();
    if (this.creating()) {
      return;
    }
    if (!discordId || !albionId) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const albionName =
      this.albionNames.get(albionId) ??
      this.albionMembers().find((member) => member.id === albionId)?.name;
    this.creating.set(true);
    try {
      await firstValueFrom(
        this.api.post<UserProfile>('api/users', {
          discord_id: discordId,
          albion_player_id: albionId,
          albion_player_name: albionName,
        }),
      );
      this.toasts.success(this.t('users.create.success', { name: albionName ?? albionId }));
      this.closeCreate();
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }

  private async loadCreateOptions(): Promise<void> {
    this.discordLoading.set(true);
    this.albionLoading.set(true);
    try {
      const [discord, roster] = await Promise.all([
        firstValueFrom(this.api.get<DiscordMemberView[]>('api/admin/discord/members')),
        firstValueFrom(
          this.api.get<PaginatedData<AlbionGuildMember> | AlbionGuildMember[]>('api/albion/guild/roster', {
            // The roster endpoint defaults to ten rows. Load the largest
            // supported page so this picker can search the complete tenant
            // roster locally.
            limit: 1000,
          }),
        ),
      ]);
      this.discordMembers.set(discord ?? []);
      const members = Array.isArray(roster) ? roster : (roster.items ?? []);
      for (const member of members) {
        this.albionNames.set(member.id, member.name);
      }
      this.albionMembers.set(members);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      this.discordMembers.set([]);
      this.albionMembers.set([]);
    } finally {
      this.discordLoading.set(false);
      this.albionLoading.set(false);
    }
  }

  protected async load(): Promise<void> {
    const request = ++this.loadRequest;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const sort = this.tableSort();
      const role = this.roleFilter().trim();
      const status = this.canBlock() ? this.statusFilter().trim() : undefined;
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          page: this.tablePage(),
          limit: this.tablePageSize(),
          username: this.tableSearch().trim() || undefined,
          role: role || undefined,
          blocked: status === 'blocked' ? true : status === 'active' ? false : undefined,
          sort: sort?.columnKey,
          order: sort?.direction,
        }),
      );
      if (request !== this.loadRequest) {
        return;
      }
      this.users.set(data.items ?? []);
      this.totalItems.set(data.total_items ?? 0);
    } catch (error) {
      if (request !== this.loadRequest) {
        return;
      }
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      this.users.set([]);
      this.totalItems.set(0);
    } finally {
      if (request === this.loadRequest) {
        this.loading.set(false);
      }
    }
  }
}
