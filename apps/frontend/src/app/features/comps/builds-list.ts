import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BuildDetail,
  BuildSummary,
  CreateBuildRequest,
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
import { RoleTag, roleGlyph, roleLabelKey } from '../../shared/components/role-tag/role-tag';
import { WeaponIcon } from '../../shared/components/weapon-icon/weapon-icon';
import {
  weaponFamilyLabelKey,
  weaponFamilyOrder,
  type WeaponFamilyId,
} from '../../shared/data/albion-weapon-families';
import { ownershipListParams, type OwnershipScope } from '../../shared/data/ownership-scope';
import { weaponFamilyOfKey } from '../../shared/data/user-weapons';
import { mainSlotProgress } from './build-loadouts';
import { canChangeAuthored } from './comp-access';
import {
  activeFilterCount,
  buildMatches,
  compareGroups,
  formatListDate,
  groupVersions,
  LIST_FETCH_LIMIT,
  NO_FILTERS,
  type ListFilters,
  type ListSort,
  type ListSortKey,
  type VersionGroup,
} from './comps-list-model';
import { ListArchiveDialog } from './list-archive-dialog';
import { ListFilterBar, type FilterCategory } from './list-filter-bar';
import { LIST_TABLE_STYLES } from './list-table-styles';
import { RowMenu } from './row-menu';

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

/** What a list can group its rows by; "none" is the default and keeps one flat, sortable table. */
type GroupBy = 'none' | 'weapon';

/** One visible row: a weapon heading (only when grouped), a build's newest version, or an older version. */
type BuildRow =
  | { readonly kind: 'group'; readonly key: string; readonly name: string | null; readonly weaponKey: string | null; readonly count: number }
  | { readonly kind: 'build'; readonly build: BuildSummary; readonly group: VersionGroup<BuildSummary>; readonly older: boolean };

/**
 * The builds list (`/builds`).
 *
 * One dense table by default: weapon icon, build name and version, role, category, how much of the
 * main loadout is filled, date and author. A build's older versions fold under its newest one.
 * Grouping by weapon is an option, not the default (most weapons have a single build, so grouping by
 * default produced one card per row). The filters match the compositions list.
 */
@Component({
  selector: 'app-builds-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    EmptyState,
    ErrorState,
    Icon,
    ListArchiveDialog,
    ListFilterBar,
    RoleTag,
    RowMenu,
    WeaponIcon,
  ],
  styles: [LIST_TABLE_STYLES],
  template: `
    <app-list-filter-bar
      [searchLabel]="t('buildsList.searchLabel')"
      [searchPlaceholder]="t('buildsList.searchPlaceholder')"
      [query]="filters().query"
      [scope]="scope()"
      [categories]="categories()"
      [categoryId]="filters().categoryId"
      [showRole]="true"
      [role]="filters().role"
      [canShowArchived]="canArchiveAny()"
      [showArchived]="showArchived()"
      [activeCount]="panelFilterCount()"
      (queryChange)="patchFilters({ query: $event })"
      (scopeChange)="setScope($event)"
      (categoryIdChange)="patchFilters({ categoryId: $event })"
      (roleChange)="patchFilters({ role: $event })"
      (showArchivedChange)="setShowArchived($event)"
      (clear)="clearFilters()"
    >
      <label style="display: grid; gap: 0.25rem">
        <span style="font-size: 0.75rem; color: var(--color-text-secondary)">{{
          t('buildsList.family.label')
        }}</span>
        <select class="select select--sm" [value]="filters().family ?? ''" (change)="onFamily($event)">
          <option value="">{{ t('buildsList.family.all') }}</option>
          @for (family of families(); track family) {
            <option [value]="family">{{ t(familyKey(family)) }}</option>
          }
        </select>
      </label>
      <label style="display: grid; gap: 0.25rem">
        <span style="font-size: 0.75rem; color: var(--color-text-secondary)">{{
          t('buildsList.group.label')
        }}</span>
        <select class="select select--sm" [value]="groupBy()" (change)="onGroupBy($event)">
          <option value="none">{{ t('buildsList.group.none') }}</option>
          <option value="weapon">{{ t('buildsList.group.weapon') }}</option>
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
          [message]="t('buildsList.error.load')"
          [retryLabel]="t('common.retry')"
          (retry)="reload()"
        />
      } @else if (!loading() && rows().length === 0) {
        @if (builds().length === 0) {
          <app-empty-state
            icon="package"
            [message]="showArchived() ? t('buildsList.empty.noArchived') : t('buildsList.empty.none')"
            [hint]="
              showArchived()
                ? undefined
                : scope() === 'mine'
                  ? t('comps.scope.emptyMine')
                  : t('buildsList.empty.noneHint')
            "
          >
            @if (canCreate() && !showArchived()) {
              <button type="button" class="btn btn--primary btn--sm" (click)="createRequested.emit()">
                <app-icon name="plus" size="0.875rem" />
                {{ t('comps.createBuild') }}
              </button>
            }
          </app-empty-state>
        } @else {
          <app-empty-state
            icon="search"
            [message]="t('buildsList.empty.noMatch')"
            [hint]="t('compsList.empty.noMatchHint')"
          >
            <button type="button" class="btn btn--outline btn--sm" (click)="clearFilters()">
              {{ t('compsList.filters.clear') }}
            </button>
          </app-empty-state>
        }
      } @else {
        <div class="lt" [attr.aria-busy]="loading()">
          <table class="lt-table" role="table" [attr.aria-label]="t('comps.builds')">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" [attr.aria-sort]="ariaSort('name')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'name', label: t('buildsList.col.build') }"
                  />
                </th>
                <th role="columnheader" [attr.aria-sort]="ariaSort('role')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'role', label: t('common.role') }"
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
                    [ngTemplateOutletContext]="{ $implicit: 'size', label: t('buildsList.col.slots') }"
                  />
                </th>
                <th role="columnheader" [attr.aria-sort]="ariaSort('updated')">
                  <ng-container
                    [ngTemplateOutlet]="sortHeader"
                    [ngTemplateOutletContext]="{ $implicit: 'updated', label: t('buildsList.col.updated') }"
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
                    <td class="lt-c-name" role="cell">
                      <span class="lt-name">
                        <span class="lt-skel lt-skel--icon"></span>
                        <span class="lt-skel" style="width: 8rem; margin-top: 0.5rem"></span>
                      </span>
                    </td>
                    <td role="cell"><span class="lt-skel" style="width: 4.5rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 5rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 2rem"></span></td>
                    <td class="lt-c-updated" role="cell"><span class="lt-skel" style="width: 4.5rem"></span></td>
                    <td role="cell"><span class="lt-skel" style="width: 4rem"></span></td>
                    <td class="lt-actions" role="cell"></td>
                  </tr>
                }
              } @else {
                @for (row of rows(); track trackRow(row)) {
                  @if (row.kind === 'group') {
                    <tr class="lt-group" role="row">
                      <td colspan="7" role="cell">
                        <span class="lt-group__title">
                          @if (row.weaponKey) {
                            <app-weapon-icon size="sm" [weaponKey]="row.weaponKey" fallback="W" />
                            {{ row.name }}
                          } @else {
                            {{ t('comps.noWeapon') }}
                          }
                          <span class="lt-muted" style="font-weight: 400">{{ row.count }}</span>
                        </span>
                      </td>
                    </tr>
                  } @else {
                    @let b = row.build;
                    <tr class="lt-row" [class.lt-row--older]="row.older" role="row">
                      <td class="lt-c-name" role="cell">
                        <div class="lt-name">
                          <app-weapon-icon size="sm" [weaponKey]="b.weapon_key" [fallback]="glyph(b.role)" />
                          <div class="lt-name__text">
                            <a class="lt-link" [routerLink]="['/builds', b.id]">{{ b.name }}</a>
                            <span class="lt-version">{{ versionLabel(row) }}</span>
                            @if (b.archived_at) {
                              <span class="chip chip--neutral text-xs ms-1">{{ t('comps.archived') }}</span>
                            }
                            <div class="lt-sub">
                              <span>{{ b.weapon_name || t('comps.noWeapon') }}</span>
                              @if (!row.older && row.group.older.length > 0) {
                                <button
                                  type="button"
                                  class="lt-versions lt-above"
                                  [attr.aria-expanded]="isExpanded(row.group.key)"
                                  [attr.aria-label]="t('compsList.versions.toggle', { name: b.name })"
                                  (click)="toggleVersions(row.group)"
                                >
                                  <span class="lt-versions__chevron" aria-hidden="true">
                                    <app-icon name="chevron-right" size="0.75rem" />
                                  </span>
                                  {{ olderLabel(row.group.older.length) }}
                                </button>
                              }
                            </div>
                          </div>
                        </div>
                      </td>
                      <td role="cell"><app-role-tag [role]="b.role" /></td>
                      <td role="cell">
                        @if (b.category_name) {
                          {{ b.category_name }}
                        } @else {
                          <span class="lt-empty-cell">{{ t('comps.noCategory') }}</span>
                        }
                      </td>
                      <td class="lt-num" role="cell">
                        @let slots = progress(b);
                        <span class="lt-mobile-label">{{ t('buildsList.col.slots') }}</span>
                        <span class="lt-mono" aria-hidden="true">{{ slots.filled }}/{{ slots.total }}</span>
                        <span class="sr-only">{{
                          t('buildsList.slotsAria', { filled: slots.filled, total: slots.total })
                        }}</span>
                      </td>
                      <td class="lt-c-updated lt-muted" role="cell">{{ date(b.updated_at) }}</td>
                      <td class="lt-muted" role="cell">{{ b.created_by_username }}</td>
                      <td class="lt-actions" role="cell">
                        <app-row-menu
                          [items]="menuItems(b)"
                          [label]="t('compsList.menu.label', { name: b.name })"
                          (select)="onMenu($event, b)"
                        />
                      </td>
                    </tr>
                  }
                }
              }
            </tbody>
          </table>
        </div>

        @if (!loading()) {
          <div class="lt-footer">
            <span>{{ t('comps.showingCount', { shown: builds().length, total: total() }) }}</span>
            @if (builds().length < total()) {
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
export class BuildsList {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Build categories, for the category facet. */
  readonly categories = input<readonly FilterCategory[]>([]);
  /** The empty state's action: the officer wants to create a build. */
  readonly createRequested = output<void>();

  protected readonly skeleton = SKELETON_ROWS;
  protected readonly glyph = roleGlyph;
  protected readonly familyKey = (family: WeaponFamilyId) => weaponFamilyLabelKey(family) as TranslationKey;

  protected readonly builds = signal<readonly BuildSummary[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly failed = signal(false);
  protected readonly saving = signal(false);
  protected readonly scope = signal<OwnershipScope>('mine');
  protected readonly showArchived = signal(false);
  protected readonly filters = signal<ListFilters>(NO_FILTERS);
  protected readonly groupBy = signal<GroupBy>('none');
  protected readonly sort = signal<ListSort>({ key: 'name', direction: 'asc' });
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly pendingArchive = signal<{ id: number; name: string } | null>(null);

  private loadedPage = 1;
  private generation = 0;

  protected readonly canCreate = computed(() => this.auth.hasPermission('comps.builds.create'));
  protected readonly canArchiveAny = computed(
    () =>
      this.auth.hasPermission('comps.builds.delete') ||
      this.auth.hasPermission('comps.builds.manage'),
  );

  /** Weapon families present in the loaded builds, in display order. */
  protected readonly families = computed<WeaponFamilyId[]>(() => {
    const present = new Set<WeaponFamilyId>();
    for (const build of this.builds()) {
      if (build.weapon_key) {
        present.add(weaponFamilyOfKey(build.weapon_key));
      }
    }
    return weaponFamilyOrder().filter((family) => present.has(family));
  });

  protected readonly groups = computed<VersionGroup<BuildSummary>[]>(() => {
    const filters = this.filters();
    const matching = this.builds().filter((build) => buildMatches(build, filters));
    return groupVersions(matching).sort(
      compareGroups(
        this.sort(),
        (build: BuildSummary) => mainSlotProgress(build).filled,
        (build: BuildSummary) => build.updated_at,
        this.translate.locale(),
        (build: BuildSummary) => this.t(roleLabelKey(build.role)),
      ),
    );
  });

  protected readonly rows = computed<BuildRow[]>(() => {
    const open = this.expanded();
    const flat = (groups: readonly VersionGroup<BuildSummary>[]): BuildRow[] =>
      groups.flatMap((group) => [
        { kind: 'build' as const, build: group.latest, group, older: false },
        ...(open.has(group.key)
          ? group.older.map((build) => ({ kind: 'build' as const, build, group, older: true }))
          : []),
      ]);
    const groups = this.groups();
    if (this.groupBy() !== 'weapon') {
      return flat(groups);
    }
    const byWeapon = new Map<string, { name: string | null; weaponKey: string | null; groups: VersionGroup<BuildSummary>[] }>();
    for (const group of groups) {
      const weaponKey = group.latest.weapon_key;
      const key = weaponKey ?? '';
      const bucket = byWeapon.get(key);
      if (bucket) {
        bucket.groups.push(group);
      } else {
        byWeapon.set(key, {
          name: weaponKey ? (group.latest.weapon_name ?? weaponKey) : null,
          weaponKey,
          groups: [group],
        });
      }
    }
    const locale = this.translate.locale();
    return [...byWeapon.entries()]
      .sort(([leftKey, left], [rightKey, right]) =>
        leftKey === '' ? 1 : rightKey === '' ? -1 : (left.name ?? '').localeCompare(right.name ?? '', locale),
      )
      .flatMap(([key, bucket]) => [
        { kind: 'group' as const, key, name: bucket.name, weaponKey: bucket.weaponKey, count: bucket.groups.length },
        ...flat(bucket.groups),
      ]);
  });

  protected readonly panelFilterCount = computed(
    () =>
      activeFilterCount(this.filters()) +
      (this.showArchived() ? 1 : 0) +
      (this.groupBy() !== 'none' ? 1 : 0),
  );

  protected readonly resultSummary = computed(() =>
    this.loading() ? '' : this.t('buildsList.resultCount', { count: this.groups().length }),
  );

  constructor() {
    void this.load();
  }

  /** Reloads the first page; keeps the filters and the scope. */
  async reload(): Promise<void> {
    await this.load();
  }

  protected trackRow(row: BuildRow): string {
    return row.kind === 'group' ? `g:${row.key}` : `b:${row.build.id}`;
  }

  protected patchFilters(patch: Partial<ListFilters>): void {
    this.filters.update((current) => ({ ...current, ...patch }));
  }

  protected clearFilters(): void {
    this.filters.set(NO_FILTERS);
    this.groupBy.set('none');
    if (this.showArchived()) {
      this.setShowArchived(false);
    }
  }

  protected onFamily(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.patchFilters({ family: value ? (value as WeaponFamilyId) : null });
  }

  protected onGroupBy(event: Event): void {
    this.groupBy.set((event.target as HTMLSelectElement).value === 'weapon' ? 'weapon' : 'none');
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

  protected toggleVersions(group: VersionGroup<BuildSummary>): void {
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

  protected versionLabel(row: Extract<BuildRow, { kind: 'build' }>): string {
    const version = `v${row.build.version}`;
    return !row.older && row.group.older.length > 0
      ? `${version} · ${this.t('compsList.versions.latest')}`
      : version;
  }

  protected olderLabel(count: number): string {
    return this.t(count === 1 ? 'compsList.versions.olderOne' : 'compsList.versions.olderMany', { count });
  }

  protected progress(build: BuildSummary): { filled: number; total: number } {
    return mainSlotProgress(build);
  }

  protected date(value: string): string {
    return formatListDate(value, this.translate.locale());
  }

  protected menuItems(build: BuildSummary): EntityMenuItem[] {
    const busy = this.saving();
    const items: EntityMenuItem[] = [];
    if (this.canCreate()) {
      items.push({ id: 'clone', label: this.t('common.clone'), disabled: busy });
    }
    if (this.canArchive(build)) {
      items.push(
        build.archived_at
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

  protected onMenu(id: string, build: BuildSummary): void {
    switch (id) {
      case 'clone':
        void this.clone(build);
        break;
      case 'archive':
        this.pendingArchive.set({ id: build.id, name: build.name });
        break;
      case 'unarchive':
        void this.post(build.id, 'unarchive', this.t('comps.unarchiveSuccess'));
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
    if (this.loadingMore() || this.builds().length >= this.total()) {
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
      this.builds.update((current) => [...current, ...data.items]);
      this.total.set(data.total_items);
    } catch {
      this.toasts.error(this.t('buildsList.error.load'));
    } finally {
      this.loadingMore.set(false);
    }
  }

  private canArchive(build: BuildSummary): boolean {
    return canChangeAuthored(
      build,
      this.auth.profile()?.user_id,
      this.auth.hasPermission('comps.builds.delete'),
      this.auth.hasPermission('comps.builds.manage'),
    );
  }

  private fetch(page: number): Promise<PaginatedData<BuildSummary>> {
    return firstValueFrom(
      this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
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
      this.builds.set(data.items);
      this.total.set(data.total_items);
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

  private async post(id: number, action: 'archive' | 'unarchive', success: string): Promise<boolean> {
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/builds/${id}/${action}`, {}));
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

  /** Clone copies the whole build, main and swap, under a "(copy)" name in the same category. */
  private async clone(build: BuildSummary): Promise<void> {
    this.saving.set(true);
    try {
      const detail = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${build.id}`));
      const request: CreateBuildRequest = {
        name: this.t('compDetail.cloneName', { name: build.name }),
        category_id: build.category_id,
        role: build.role,
        items: detail.items,
      };
      if (build.description) {
        request.description = build.description;
      }
      await firstValueFrom(this.api.post<BuildDetail>('api/comps/builds', request));
      await this.load();
      this.toasts.success(this.t('comps.cloneSuccess'));
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
