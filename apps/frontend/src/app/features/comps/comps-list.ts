import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompDetail,
  CompPerformanceView,
  CompSummary,
  CreateCompRequest,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import type { EntityMenuItem } from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { roleLabelKey } from '../../shared/components/role-tag/role-tag';
import { ownershipListParams, type OwnershipScope } from '../../shared/data/ownership-scope';
import { canChangeAuthored } from './comp-access';
import { roleMixText } from './comp-create-model';
import {
  activeFilterCount,
  compareGroups,
  compMatches,
  formatListDate,
  groupVersions,
  LIST_FETCH_LIMIT,
  NO_FILTERS,
  partyCount,
  roleMixOf,
  winRateOf,
  type CompTypeFilter,
  type ListFilters,
  type ListSort,
  type ListSortKey,
  type RoleCount,
  type VersionGroup,
} from './comps-list-model';
import { ListArchiveDialog } from './list-archive-dialog';
import { ListFilterBar, type FilterCategory } from './list-filter-bar';
import { LIST_TABLE_STYLES } from './list-table-styles';
import { RowMenu } from './row-menu';

/** Simultaneous per-row requests (win rate and role mix); keeps a long list from flooding the API. */
const ENRICH_CONCURRENCY = 6;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

/** One visible table row: the newest version of a composition, or an older version revealed under it. */
interface CompRow {
  readonly comp: CompSummary;
  readonly group: VersionGroup<CompSummary>;
  readonly older: boolean;
}

/**
 * The compositions list (`/comps`).
 *
 * A dense table with one row per composition: the newest version up front with its version, older
 * versions one click away, variants marked "Variant of X", and the facts an officer scans for
 * (category, players, role mix, win rate, date, author). Rows are real links; Clone, New variant and
 * Archive live in the row menu.
 *
 * Win rate and role mix are not in the list payload, so they are fetched per visible composition
 * (two requests each, six at a time) and fill in as they arrive. A backend field on the list would
 * remove both.
 */
@Component({
  selector: 'app-comps-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    EmptyState,
    ErrorState,
    Icon,
    ListArchiveDialog,
    ListFilterBar,
    RowMenu,
  ],
  styles: [LIST_TABLE_STYLES],
  template: `
    <app-list-filter-bar
      [searchLabel]="t('compsList.searchLabel')"
      [searchPlaceholder]="t('compsList.searchPlaceholder')"
      [query]="filters().query"
      [scope]="scope()"
      [categories]="categories()"
      [categoryId]="filters().categoryId"
      [canShowArchived]="canArchiveAny()"
      [showArchived]="showArchived()"
      [activeCount]="panelFilterCount()"
      (queryChange)="patchFilters({ query: $event })"
      (scopeChange)="setScope($event)"
      (categoryIdChange)="patchFilters({ categoryId: $event })"
      (showArchivedChange)="setShowArchived($event)"
      (clear)="clearFilters()"
    >
      <label class="lf-field" style="display: grid; gap: 0.25rem">
        <span style="font-size: 0.75rem; color: var(--color-text-secondary)">{{
          t('compsList.type.label')
        }}</span>
        <select class="select select--sm" [value]="filters().type" (change)="onType($event)">
          <option value="all">{{ t('compsList.type.all') }}</option>
          <option value="base">{{ t('compsList.type.base') }}</option>
          <option value="variants">{{ t('compsList.type.variants') }}</option>
        </select>
      </label>
    </app-list-filter-bar>

    <p class="sr-only" role="status" aria-live="polite">{{ resultSummary() }}</p>

    <ng-template #sortHeader let-key let-label="label">
      <button
        type="button"
        class="lt-sort"
        [attr.data-active]="sort().key === key"
        (click)="sortBy(key)"
      >
        {{ label }}
        <span class="lt-sort__arrow" aria-hidden="true">{{ arrow(key) }}</span>
      </button>
    </ng-template>

    <div class="mt-3">
      @if (failed()) {
        <app-error-state
          [message]="t('compsList.error.load')"
          [retryLabel]="t('common.retry')"
          (retry)="reload()"
        />
      } @else if (!loading() && rows().length === 0) {
        @if (comps().length === 0) {
          <app-empty-state
            icon="package"
            [message]="showArchived() ? t('compsList.empty.noArchived') : t('compsList.empty.none')"
            [hint]="
              showArchived()
                ? undefined
                : scope() === 'mine'
                  ? t('comps.scope.emptyMine')
                  : t('compsList.empty.noneHint')
            "
          >
            @if (canCreate() && !showArchived()) {
              <button type="button" class="btn btn--primary btn--sm" (click)="createRequested.emit()">
                <app-icon name="plus" size="0.875rem" />
                {{ t('comps.createComp') }}
              </button>
            }
          </app-empty-state>
        } @else {
          <app-empty-state
            icon="search"
            [message]="t('compsList.empty.noMatch')"
            [hint]="t('compsList.empty.noMatchHint')"
          >
            <button type="button" class="btn btn--outline btn--sm" (click)="clearFilters()">
              {{ t('compsList.filters.clear') }}
            </button>
          </app-empty-state>
        }
      } @else {
        <div class="lt" [attr.aria-busy]="loading()">
          <table class="lt-table" role="table" [attr.aria-label]="t('comps.title')">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" [attr.aria-sort]="ariaSort('name')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'name', label: t('compsList.col.name') }"
                  />
                </th>
                <th role="columnheader" [attr.aria-sort]="ariaSort('category')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'category', label: t('common.category') }"
                  />
                </th>
                <th role="columnheader" class="lt-num" [attr.aria-sort]="ariaSort('size')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'size', label: t('compsList.col.players') }"
                  />
                </th>
                <th role="columnheader">{{ t('compsList.col.roles') }}</th>
                <th role="columnheader" class="lt-num">{{ t('compsList.col.winRate') }}</th>
                <th role="columnheader" [attr.aria-sort]="ariaSort('updated')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'updated', label: t('compsList.col.created') }"
                  />
                </th>
                <th role="columnheader" [attr.aria-sort]="ariaSort('author')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'author', label: t('compsList.col.author') }"
                  />
                </th>
                <th role="columnheader" class="lt-actions"><span class="sr-only">{{ t('common.actions') }}</span></th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              @if (loading()) {
                @for (n of skeleton; track n) {
                  <tr class="lt-row lt-row--skeleton" role="row" aria-hidden="true">
                    <td class="lt-c-name" role="cell"><span class="lt-skel" style="width: 60%"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 5rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 3rem"></span></td>
                    <td class="lt-c-roles" role="cell"><span class="lt-skel" style="width: 8rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 2.5rem"></span></td>
                    <td class="lt-c-updated" role="cell"><span class="lt-skel" style="width: 4.5rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 4rem"></span></td>
                    <td class="lt-actions" role="cell"></td>
                  </tr>
                }
              } @else {
                @for (row of rows(); track row.comp.id) {
                  @let c = row.comp;
                  <tr class="lt-row" [class.lt-row--older]="row.older" role="row">
                    <td class="lt-c-name" role="cell">
                      <div class="lt-name__text">
                        <a class="lt-link" [routerLink]="['/comps', c.id]">{{ c.name }}</a>
                        <span class="lt-version">{{ versionLabel(row) }}</span>
                        @if (c.archived_at) {
                          <span class="chip chip--neutral text-xs ms-1">{{ t('comps.archived') }}</span>
                        }
                        @if (!row.older || c.parent_id !== null) {
                          <div class="lt-sub">
                            @if (!row.older && row.group.older.length > 0) {
                              <button
                                type="button"
                                class="lt-versions lt-above"
                                [attr.aria-expanded]="isExpanded(row.group.key)"
                                [attr.aria-label]="t('compsList.versions.toggle', { name: c.name })"
                                (click)="toggleVersions(row.group)"
                              >
                                <span class="lt-versions__chevron" aria-hidden="true">
                                  <app-icon name="chevron-right" size="0.75rem" />
                                </span>
                                {{ olderLabel(row.group.older.length) }}
                              </button>
                            }
                            @if (c.parent_id !== null) {
                              <span>
                                @if (parentOf(c); as parent) {
                                  {{ t('compsList.variantOfPrefix') }}
                                  <a class="lt-above" [routerLink]="['/comps', parent.id]">{{ parent.name }}</a>
                                } @else {
                                  {{ t('compsList.variant') }}
                                }
                              </span>
                            }
                          </div>
                        }
                      </div>
                    </td>
                    <td role="cell">
                      @if (c.category_name) {
                        {{ c.category_name }}
                      } @else {
                        <span class="lt-empty-cell">{{ t('comps.noCategory') }}</span>
                      }
                    </td>
                    <td class="lt-num" role="cell">
                      <span>{{ t('compsList.playersCount', { count: c.total_quantity }) }}</span>
                      <span class="lt-muted lt-stack">
                        {{ sizeSub(c) }}
                      </span>
                    </td>
                    <td class="lt-c-roles" role="cell">
                      @let mix = mixFor(c.id);
                      @if (mix === 'pending') {
                        <span class="lt-skel" style="width: 9rem" aria-hidden="true"></span>
                        <span class="sr-only">{{ t('common.loading') }}</span>
                      } @else if (mix === 'error') {
                        <span class="lt-empty-cell" [attr.title]="t('compsList.roles.unavailable')">—</span>
                      } @else if (mix.length === 0) {
                        <span class="lt-empty-cell">{{ t('compsList.roles.none') }}</span>
                      } @else {
                        {{ mixText(mix) }}
                      }
                    </td>
                    <td class="lt-num" role="cell">
                      @let perf = perfFor(c.id);
                      @if (perf === 'pending') {
                        <span class="lt-skel" style="width: 2.5rem; margin-inline-start: auto" aria-hidden="true"></span>
                        <span class="sr-only">{{ t('common.loading') }}</span>
                      } @else if (perf === 'error') {
                        <span class="lt-empty-cell" [attr.title]="t('compsList.winRate.unavailable')">—</span>
                      } @else if (winRate(perf); as win) {
                        <span class="lt-mobile-label">{{ t('compsList.col.winRate') }}</span>
                        <strong style="font-weight: 600">{{ formatRate(win.rate) }}</strong>
                        <span class="lt-muted lt-stack">
                          {{ t('compsList.winRate.battles', { count: win.battles }) }}
                        </span>
                      } @else {
                        <span class="lt-muted">{{ t('compsList.winRate.none') }}</span>
                      }
                    </td>
                    <td class="lt-c-updated lt-muted" role="cell">{{ date(c.created_at) }}</td>
                    <td class="lt-muted" role="cell">{{ c.created_by_username }}</td>
                    <td class="lt-actions" role="cell">
                      <app-row-menu
                        [items]="menuItems(c)"
                        [label]="t('compsList.menu.label', { name: c.name })"
                        (select)="onMenu($event, c)"
                      />
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>

        @if (!loading()) {
          <div class="lt-footer">
            <span>{{ t('comps.showingCount', { shown: comps().length, total: total() }) }}</span>
            @if (comps().length < total()) {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="loadingMore()"
                (click)="loadMore()"
              >
                {{ t('comps.loadMore') }}
              </button>
            }
          </div>
        }
      }
    </div>

    @if (pendingArchive(); as pending) {
      <app-list-archive-dialog
        [name]="pending.name"
        [saving]="saving()"
        (confirm)="confirmArchive()"
        (closed)="pendingArchive.set(null)"
      />
    }
  `,
})
export class CompsList {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Composition categories, for the category facet. */
  readonly categories = input<readonly FilterCategory[]>([]);
  /** The empty state's action: the officer wants to create a composition. */
  readonly createRequested = output<void>();
  /** A row's "New variant": the officer wants to create a variant of this composition. */
  readonly variantRequested = output<CompSummary>();

  protected readonly skeleton = SKELETON_ROWS;

  protected readonly comps = signal<readonly CompSummary[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly failed = signal(false);
  protected readonly saving = signal(false);
  /** Mine is the default; Everyone is an explicit second section. */
  protected readonly scope = signal<OwnershipScope>('mine');
  protected readonly showArchived = signal(false);
  protected readonly filters = signal<ListFilters>(NO_FILTERS);
  protected readonly sort = signal<ListSort>({ key: 'name', direction: 'asc' });
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly pendingArchive = signal<{ id: number; name: string } | null>(null);

  private readonly perf = signal<Readonly<Record<number, CompPerformanceView | 'error'>>>({});
  private readonly mix = signal<Readonly<Record<number, readonly RoleCount[] | 'error'>>>({});
  private readonly requested = new Set<number>();
  private loadedPage = 1;
  /** Bumped on every reload so answers to superseded requests are dropped. */
  private generation = 0;

  protected readonly canCreate = computed(() => this.auth.hasPermission('comps.comps.create'));
  protected readonly canArchiveAny = computed(
    () =>
      this.auth.hasPermission('comps.comps.delete') ||
      this.auth.hasPermission('comps.comps.manage'),
  );

  private readonly byId = computed(() => new Map(this.comps().map((comp) => [comp.id, comp])));

  protected readonly groups = computed<VersionGroup<CompSummary>[]>(() => {
    const filters = this.filters();
    const matching = this.comps().filter((comp) => compMatches(comp, filters));
    return groupVersions(matching).sort(
      compareGroups(
        this.sort(),
        (comp: CompSummary) => comp.total_quantity,
        (comp: CompSummary) => comp.created_at,
        this.translate.locale(),
      ),
    );
  });

  protected readonly rows = computed<CompRow[]>(() => {
    const open = this.expanded();
    return this.groups().flatMap((group) => [
      { comp: group.latest, group, older: false },
      ...(open.has(group.key) ? group.older.map((comp) => ({ comp, group, older: true })) : []),
    ]);
  });

  /** Filters inside the collapsible panel (everything but the always-visible search). */
  protected readonly panelFilterCount = computed(
    () => activeFilterCount(this.filters()) + (this.showArchived() ? 1 : 0),
  );

  protected readonly resultSummary = computed(() =>
    this.loading() ? '' : this.t('compsList.resultCount', { count: this.groups().length }),
  );

  constructor() {
    void this.load();
    // Fill in win rate and role mix for the rows on screen, top first.
    effect(() => {
      const ids = this.rows().map((row) => row.comp.id);
      untracked(() => void this.enrich(ids));
    });
  }

  /** Reloads the first page; keeps the filters and the scope. */
  async reload(): Promise<void> {
    await this.load();
  }

  protected patchFilters(patch: Partial<ListFilters>): void {
    this.filters.update((current) => ({ ...current, ...patch }));
  }

  protected clearFilters(): void {
    this.filters.set(NO_FILTERS);
    if (this.showArchived()) {
      this.setShowArchived(false);
    }
  }

  protected onType(event: Event): void {
    this.patchFilters({ type: (event.target as HTMLSelectElement).value as CompTypeFilter });
  }

  protected setScope(scope: OwnershipScope): void {
    if (scope === this.scope()) {
      return;
    }
    this.scope.set(scope);
    void this.load();
  }

  protected setShowArchived(value: boolean): void {
    this.showArchived.set(value);
    void this.load();
  }

  protected sortBy(key: ListSortKey): void {
    this.sort.update((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  }

  protected arrow(key: ListSortKey): string {
    const sort = this.sort();
    return sort.key !== key ? '' : sort.direction === 'asc' ? '▲' : '▼';
  }

  protected ariaSort(key: ListSortKey): 'ascending' | 'descending' | 'none' {
    const sort = this.sort();
    return sort.key !== key ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  protected toggleVersions(group: VersionGroup<CompSummary>): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (next.has(group.key)) {
        next.delete(group.key);
      } else {
        next.add(group.key);
      }
      return next;
    });
  }

  protected versionLabel(row: CompRow): string {
    const version = `v${row.comp.version}`;
    return !row.older && row.group.older.length > 0
      ? `${version} · ${this.t('compsList.versions.latest')}`
      : version;
  }

  protected olderLabel(count: number): string {
    return this.t(count === 1 ? 'compsList.versions.olderOne' : 'compsList.versions.olderMany', { count });
  }

  protected parentOf(comp: CompSummary): CompSummary | null {
    return comp.parent_id === null ? null : (this.byId().get(comp.parent_id) ?? null);
  }

  protected sizeSub(comp: CompSummary): string {
    const builds = this.t(comp.build_count === 1 ? 'compsList.buildsOne' : 'compsList.buildsMany', {
      count: comp.build_count,
    });
    const parties = partyCount(comp.total_quantity);
    return parties === 0
      ? builds
      : `${builds} · ${this.t(parties === 1 ? 'compsList.partiesOne' : 'compsList.partiesMany', { count: parties })}`;
  }

  protected mixFor(id: number): readonly RoleCount[] | 'pending' | 'error' {
    return this.mix()[id] ?? 'pending';
  }

  protected mixText(mix: readonly RoleCount[]): string {
    return roleMixText(mix, (role) => this.t(roleLabelKey(role)));
  }

  protected perfFor(id: number): CompPerformanceView | 'pending' | 'error' {
    return this.perf()[id] ?? 'pending';
  }

  protected winRate(
    perf: CompPerformanceView | 'pending' | 'error',
  ): { rate: number; battles: number } | null {
    return typeof perf === 'string' ? null : winRateOf(perf);
  }

  protected formatRate(rate: number): string {
    return `${new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 1 }).format(rate)}%`;
  }

  protected date(value: string): string {
    return formatListDate(value, this.translate.locale());
  }

  protected menuItems(comp: CompSummary): EntityMenuItem[] {
    const busy = this.saving();
    const items: EntityMenuItem[] = [];
    if (this.canCreate()) {
      items.push({ id: 'clone', label: this.t('common.clone'), disabled: busy });
      items.push({ id: 'variant', label: this.t('compsList.menu.newVariant'), disabled: busy });
    }
    if (this.canArchive(comp)) {
      items.push(
        comp.archived_at
          ? { id: 'unarchive', label: this.t('comps.unarchive'), disabled: busy, separatorBefore: items.length > 0 }
          : {
              id: 'archive',
              label: this.t('comps.archive'),
              disabled: busy,
              danger: true,
              separatorBefore: items.length > 0,
            },
      );
    }
    return items;
  }

  protected onMenu(id: string, comp: CompSummary): void {
    switch (id) {
      case 'clone':
        void this.clone(comp);
        break;
      case 'variant':
        this.variantRequested.emit(comp);
        break;
      case 'archive':
        this.pendingArchive.set({ id: comp.id, name: comp.name });
        break;
      case 'unarchive':
        void this.post(comp.id, 'unarchive', this.t('comps.unarchiveSuccess'));
        break;
    }
  }

  protected async confirmArchive(): Promise<void> {
    const pending = this.pendingArchive();
    if (!pending) {
      return;
    }
    if (await this.post(pending.id, 'archive', this.t('comps.archiveSuccess'))) {
      this.pendingArchive.set(null);
    }
  }

  protected async loadMore(): Promise<void> {
    if (this.loadingMore() || this.comps().length >= this.total()) {
      return;
    }
    this.loadingMore.set(true);
    const generation = this.generation;
    const page = this.loadedPage + 1;
    try {
      const data = await this.fetch(page);
      if (generation !== this.generation) {
        return;
      }
      this.loadedPage = page;
      this.comps.update((current) => [...current, ...data.items]);
      this.total.set(data.total_items);
    } catch {
      this.toasts.error(this.t('compsList.error.load'));
    } finally {
      this.loadingMore.set(false);
    }
  }

  private canArchive(comp: CompSummary): boolean {
    return canChangeAuthored(
      comp,
      this.auth.profile()?.user_id,
      this.auth.hasPermission('comps.comps.delete'),
      this.auth.hasPermission('comps.comps.manage'),
    );
  }

  private fetch(page: number): Promise<PaginatedData<CompSummary>> {
    return firstValueFrom(
      this.api.get<PaginatedData<CompSummary>>('api/comps', {
        page,
        limit: LIST_FETCH_LIMIT,
        sort: 'name',
        order: 'asc',
        ...ownershipListParams(this.scope()),
        ...(this.showArchived() ? { archived: 'true' } : {}),
      }),
    );
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const data = await this.fetch(1);
      if (generation !== this.generation) {
        return;
      }
      this.loadedPage = 1;
      this.comps.set(data.items);
      this.total.set(data.total_items);
      this.perf.set({});
      this.mix.set({});
      this.requested.clear();
      this.expanded.set(new Set());
    } catch {
      if (generation === this.generation) {
        this.failed.set(true);
      }
    } finally {
      if (generation === this.generation) {
        this.loading.set(false);
      }
    }
  }

  /** Posts an archive/unarchive and reloads; returns whether it worked. */
  private async post(id: number, action: 'archive' | 'unarchive', success: string): Promise<boolean> {
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/${id}/${action}`, {}));
      await this.load();
      this.toasts.success(success);
      return true;
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  private async clone(comp: CompSummary): Promise<void> {
    this.saving.set(true);
    try {
      const detail = await firstValueFrom(this.api.get<CompDetail>(`api/comps/${comp.id}`));
      const request: CreateCompRequest = {
        name: this.t('compDetail.cloneName', { name: comp.name }),
        category_id: comp.category_id,
        builds: detail.builds.map((entry) => ({ build_id: entry.build_id, quantity: entry.quantity })),
      };
      if (comp.description) {
        request.description = comp.description;
      }
      await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      await this.load();
      this.toasts.success(this.t('comps.cloneSuccess'));
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Fetches win rate and role mix for compositions not asked about yet, a few at a time. */
  private async enrich(ids: readonly number[]): Promise<void> {
    const generation = this.generation;
    const queue = ids.filter((id) => !this.requested.has(id));
    for (const id of queue) {
      this.requested.add(id);
    }
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (generation !== this.generation) {
          return;
        }
        await this.enrichOne(id, generation);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, queue.length) }, worker));
  }

  private async enrichOne(id: number, generation: number): Promise<void> {
    const [performance, detail] = await Promise.all([
      firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${id}/performance`)).catch(
        () => 'error' as const,
      ),
      firstValueFrom(this.api.get<CompDetail>(`api/comps/${id}`)).catch(() => null),
    ]);
    if (generation !== this.generation) {
      return;
    }
    this.perf.update((current) => ({ ...current, [id]: performance }));
    this.mix.update((current) => ({
      ...current,
      [id]: detail ? roleMixOf(detail.builds) : 'error',
    }));
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
