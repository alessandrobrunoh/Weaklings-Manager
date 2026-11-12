import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PermissionMatrix, RolePermissionsView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import type { MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { groupPermissions, permissionParts, type PermissionGroup } from './permission-groups';

/** Save feedback shown above the matrix. */
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Verb words of the permission keys, translated for the row titles. */
const VERB_KEYS: Readonly<Record<string, TranslationKey>> = {
  view: 'admin.permissions.verb.view',
  view_others: 'admin.permissions.verb.viewOthers',
  create: 'admin.permissions.verb.create',
  edit: 'admin.permissions.verb.edit',
  delete: 'admin.permissions.verb.delete',
  manage: 'admin.permissions.verb.manage',
  use: 'admin.permissions.verb.use',
  request: 'admin.permissions.verb.request',
  adjudicate: 'admin.permissions.verb.adjudicate',
  ingest: 'admin.permissions.verb.ingest',
  issue: 'admin.permissions.verb.issue',
  adjust: 'admin.permissions.verb.adjust',
  submit: 'admin.permissions.verb.submit',
  broadcast: 'admin.permissions.verb.broadcast',
  share: 'admin.permissions.verb.share',
  leave: 'admin.permissions.verb.leave',
  accept: 'admin.permissions.verb.accept',
  reload: 'admin.permissions.verb.reload',
};

/**
 * Role x permission matrix. Each box grants one permission to one role and
 * saves on its own. Rows are grouped by area and say in words who holds them.
 */
@Component({
  selector: 'app-admin-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, FilterBar, Icon, Loading, PageHeader, PageStack, SummaryBand],
  styles: [COMPACT_FEATURE_STYLES, `
    :host {
      display: block;
    }

    .save-state {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      min-height: 1.5rem;
      font-size: var(--ui-text-sm);
      color: var(--color-text-secondary);
    }

    .save-state--saved {
      color: var(--color-success);
    }

    .save-state--error {
      color: var(--color-error);
    }

    .save-state__spin {
      animation: permissions-spin 900ms linear infinite;
    }

    @keyframes permissions-spin {
      to {
        transform: rotate(360deg);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .save-state__spin {
        animation: none;
      }
    }

    .matrix-scroll {
      position: relative;
      max-height: min(70vh, 40rem);
      overflow: auto;
      overscroll-behavior: contain;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background-color: var(--color-surface);
    }

    .matrix-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--ui-text-sm);
    }

    .matrix-table th,
    .matrix-table td {
      text-align: center;
      vertical-align: middle;
    }

    .matrix-table thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background-color: var(--color-surface-2);
      border-bottom: 1px solid var(--color-border);
      padding: 0.625rem 0.75rem;
      min-width: 7.5rem;
      vertical-align: top;
    }

    .matrix-table .sticky-col {
      position: sticky;
      left: 0;
      z-index: 1;
      text-align: left;
      min-width: 13rem;
      max-width: 18rem;
      background-color: var(--color-surface);
      border-right: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      padding: 0.625rem 0.75rem;
    }

    .matrix-table thead th.sticky-col {
      z-index: 3;
      background-color: var(--color-surface-2);
      border-bottom: 1px solid var(--color-border);
    }

    .role-name {
      font-weight: 600;
      color: var(--color-text);
    }

    .role-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 0.25rem 0.375rem;
      margin-top: 0.25rem;
      font-size: var(--ui-text-xs);
      font-weight: 400;
      color: var(--color-text-secondary);
    }

    .role-discord {
      margin-top: 0.25rem;
      font-size: var(--ui-text-xs);
      color: var(--color-text-disabled);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 9rem;
      margin-inline: auto;
    }

    .perm-title {
      font-weight: 600;
      color: var(--color-text);
    }

    .perm-key {
      margin-top: 0.125rem;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }

    .grant-text {
      margin-top: 0.25rem;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .matrix-table tbody td.matrix-cell {
      border-bottom: 1px solid var(--color-border);
      border-right: 1px solid var(--color-border);
      padding: 0;
    }

    .matrix-table tbody td.matrix-cell--granted {
      background-color: var(--color-surface-hover);
    }

    .cell-hit {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 2.75rem;
      cursor: pointer;
    }

    .matrix-table tbody tr.group-row th {
      position: static;
      background-color: var(--color-surface-2);
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      padding: 0;
      text-align: left;
    }

    .group-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.5rem 0.75rem;
      font-weight: 600;
      color: var(--color-text);
      cursor: pointer;
      text-align: left;
    }

    .group-toggle:hover {
      color: var(--color-primary);
    }

    .matrix-table tbody tr.group-footer-row th,
    .matrix-table tbody tr.group-footer-row td {
      background-color: var(--color-surface-1);
      border-bottom: 2px solid var(--color-border);
      font-weight: 400;
    }

    .group-footer-row td {
      padding: 0.375rem;
    }
  `],
  template: `
    <app-page-header
      [title]="t('admin.permissions.title')"
      [subtitle]="t('admin.permissions.hint')"
      [menuItems]="menuItems()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onMenu($event)"
    />

    @if (loading()) {
      <app-loading variant="table" />
    } @else if (matrix(); as data) {
      <app-page-stack>
        <app-summary-band [ariaLabel]="t('admin.permissions.title')" [items]="summaryItems()" />

        <app-filter-bar
          [searchLabel]="t('admin.permissions.searchPlaceholder')"
          [searchPlaceholder]="t('admin.permissions.searchPlaceholder')"
          [query]="searchQuery()"
          [activeCount]="activeFilterCount()"
          (queryChange)="searchQuery.set($event)"
          (clear)="clearFilters()"
        >
          <label filterPrimary class="filter-field">
            <span class="filter-field__label">{{ t('admin.permissions.area') }}</span>
            <select class="select select--sm" [value]="selectedModule()" (change)="onModuleChange($event)">
              <option value="all">{{ t('admin.permissions.allModules') }}</option>
              @for (mod of allModules(); track mod) {
                <option [value]="mod">{{ mod }}</option>
              }
            </select>
          </label>

          <fieldset class="filter-field">
            <legend class="filter-field__label">{{ t('admin.permissions.showRoles') }}</legend>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              @for (role of data.roles; track role.role_id) {
                <label class="filter-check">
                  <input
                    type="checkbox"
                    [checked]="isRoleVisible(role.role_id)"
                    [disabled]="isOnlyVisibleRole(role.role_id)"
                    (change)="toggleRoleVisibility(role.role_id)"
                  />
                  {{ role.role_name }}
                </label>
              }
            </div>
          </fieldset>
        </app-filter-bar>

        <div class="save-state" role="status" aria-live="polite">
          @switch (saveState()) {
            @case ('saving') {
              <app-icon name="refresh" size="0.875rem" class="save-state__spin" />
              <span>{{ t('admin.permissions.saving') }}</span>
            }
            @case ('saved') {
              <app-icon name="check" size="0.875rem" />
              <span>{{ t('admin.permissions.saved') }}</span>
            }
            @case ('error') {
              <app-icon name="alert" size="0.875rem" />
              <span>{{ t('admin.permissions.saveError') }}</span>
            }
            @default {
              <span>{{ t('admin.permissions.saveIdle') }}</span>
            }
          }
          <span class="sm:hidden">{{ t('admin.permissions.scrollHint') }}</span>
        </div>

        @if (filteredGroups().length === 0) {
          <app-empty-state [message]="t('admin.permissions.emptyMatch')" icon="shield">
            @if (activeFilterCount() > 0) {
              <button type="button" class="btn btn--outline btn--sm" (click)="clearFilters()">
                {{ t('common.clearFilters') }}
              </button>
            }
          </app-empty-state>
        } @else {
          <div class="matrix-scroll" role="region" tabindex="0" [attr.aria-label]="t('admin.permissions.matrixLabel')">
            <table class="matrix-table">
              <caption class="sr-only">{{ t('admin.permissions.matrixLabel') }}</caption>
              <thead>
                <tr>
                  <th scope="col" class="sticky-col">
                    <span class="font-semibold text-[var(--color-text)]">{{ t('admin.permissions.permission') }}</span>
                  </th>
                  @for (role of visibleRoles(); track role.role_id) {
                    <th scope="col">
                      <div class="role-name">{{ role.role_name }}</div>
                      <div class="role-meta">
                        <span>{{ t('admin.permissions.priority') }} {{ role.priority }}</span>
                        @if (role.is_default) {
                          <span class="chip chip--neutral">{{ t('admin.permissions.isDefault') }}</span>
                        }
                        @if (role.is_staff) {
                          <span class="chip chip--neutral">{{ t('admin.permissions.isStaff') }}</span>
                        }
                        @if (role.grants_staff && !role.is_staff) {
                          <span class="chip chip--neutral">{{ t('admin.permissions.grantsStaff') }}</span>
                        }
                      </div>
                      <div class="role-meta">{{ t('admin.permissions.grantedCount', { count: role.permissions.length }) }}</div>
                      @if (role.discord_role_id) {
                        <div class="mono role-discord">{{ role.discord_role_id }}</div>
                      }
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (group of filteredGroups(); track group.resource) {
                  <tr class="group-row">
                    <th scope="colgroup" [attr.colspan]="visibleRoles().length + 1">
                      <button
                        type="button"
                        class="group-toggle"
                        [attr.aria-expanded]="!isGroupCollapsed(group.resource)"
                        (click)="toggleGroupCollapse(group.resource)"
                      >
                        <app-icon
                          [name]="isGroupCollapsed(group.resource) ? 'chevron-right' : 'chevron-down'"
                          size="0.875rem"
                        />
                        <span class="mono">{{ group.resource }}</span>
                        <span class="chip chip--neutral">{{ group.keys.length }}</span>
                      </button>
                    </th>
                  </tr>

                  @if (!isGroupCollapsed(group.resource)) {
                    @for (permission of group.keys; track permission) {
                      @let granters = grantedRoleNames(permission);
                      <tr>
                        <th scope="row" class="sticky-col">
                          <div class="perm-title">{{ permissionTitle(permission, group.resource) }}</div>
                          <div class="mono perm-key">{{ permission }}</div>
                          <div class="grant-text">
                            {{ granters.length > 0 ? t('admin.permissions.grantedTo', { roles: granters.join(', ') }) : t('admin.permissions.grantedToNone') }}
                          </div>
                        </th>
                        @for (role of visibleRoles(); track role.role_id) {
                          <td class="matrix-cell" [class.matrix-cell--granted]="hasPermission(role, permission)">
                            <label class="cell-hit">
                              <input
                                class="checkbox"
                                type="checkbox"
                                [attr.aria-label]="t('admin.permissions.cellLabel', { permission: permission, role: role.role_name })"
                                [checked]="hasPermission(role, permission)"
                                (change)="toggle(role, permission, $event)"
                              />
                            </label>
                          </td>
                        }
                      </tr>
                    }

                    <tr class="group-footer-row">
                      <th scope="row" class="sticky-col">{{ t('admin.permissions.toggleGroup') }}</th>
                      @for (role of visibleRoles(); track role.role_id) {
                        @let allGranted = groupFullyGranted(role, group.keys);
                        <td class="matrix-cell">
                          <button
                            type="button"
                            class="btn btn--outline btn--sm w-full text-xs"
                            [attr.aria-label]="t('admin.permissions.groupCellLabel', { action: allGranted ? t('admin.permissions.clearGroup') : t('admin.permissions.grantGroup'), area: group.resource, role: role.role_name })"
                            (click)="toggleGroup(role, group.keys, !allGranted)"
                          >
                            {{ allGranted ? t('admin.permissions.clearGroup') : t('admin.permissions.grantGroup') }}
                          </button>
                        </td>
                      }
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </app-page-stack>
    } @else {
      <app-error-state
        [message]="t('admin.loadError')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    }
  `,
})
export class AdminPermissions {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(true);
  protected readonly matrix = signal<PermissionMatrix | null>(null);

  /** Saves in flight; the matrix stays editable while they run. */
  private readonly pendingSaves = signal(0);
  /** Outcome of the most recent save, shown until the next one starts. */
  private readonly saveOutcome = signal<'saved' | 'error' | null>(null);
  /** Saves are queued per role so each one starts from the matrix the last one left. */
  private readonly saveQueues = new Map<string, Promise<void>>();

  protected readonly searchQuery = signal('');
  protected readonly selectedModule = signal<string>('all');
  protected readonly selectedRoleIds = signal<ReadonlySet<string>>(new Set());
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  protected readonly saveState = computed<SaveState>(() =>
    this.pendingSaves() > 0 ? 'saving' : (this.saveOutcome() ?? 'idle'),
  );

  protected readonly permissionGroups = computed(() => {
    const matrix = this.matrix();
    if (!matrix) {
      return [];
    }
    return groupPermissions(matrix.permission_catalog, matrix.available_permissions);
  });

  protected readonly allModules = computed<string[]>(() => {
    const groups = this.permissionGroups();
    return [...new Set(groups.map((g) => g.resource))].sort();
  });

  /** Role names per permission key, across all roles (not only the visible columns). */
  private readonly grantedByKey = computed(() => {
    const map = new Map<string, string[]>();
    for (const role of this.matrix()?.roles ?? []) {
      for (const permission of role.permissions) {
        const names = map.get(permission) ?? [];
        names.push(role.role_name);
        map.set(permission, names);
      }
    }
    return map;
  });

  protected readonly visibleRoles = computed<RolePermissionsView[]>(() => {
    const matrix = this.matrix();
    if (!matrix) {
      return [];
    }
    const selected = this.selectedRoleIds();
    if (selected.size === 0) {
      return matrix.roles;
    }
    return matrix.roles.filter((role) => selected.has(role.role_id));
  });

  protected readonly filteredGroups = computed<PermissionGroup[]>(() => {
    const groups = this.permissionGroups();
    const query = this.searchQuery().trim().toLowerCase();
    const mod = this.selectedModule();

    return groups
      .filter((group) => mod === 'all' || group.resource === mod)
      .map((group) => {
        if (!query) {
          return group;
        }
        return {
          ...group,
          keys: group.keys.filter((key) => key.toLowerCase().includes(query)),
        };
      })
      .filter((group) => group.keys.length > 0);
  });

  protected readonly activeFilterCount = computed<number>(() => {
    const roles = this.matrix()?.roles.length ?? 0;
    return (
      (this.searchQuery().trim() ? 1 : 0) +
      (this.selectedModule() !== 'all' ? 1 : 0) +
      (this.visibleRoles().length < roles ? 1 : 0)
    );
  });

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const matrix = this.matrix();
    if (!matrix) {
      return [];
    }
    const keys = this.permissionGroups().flatMap((group) => group.keys);
    const ungranted = keys.filter((key) => !this.grantedByKey().has(key)).length;
    const areas = this.permissionGroups().length;
    return [
      {
        label: this.t('admin.permissions.roles'),
        value: matrix.roles.length,
        hint: this.t('admin.permissions.summaryRolesHint'),
      },
      {
        label: this.t('admin.permissions.summaryPermissions'),
        value: keys.length,
        hint: this.t('admin.permissions.summaryPermissionsHint', { areas }),
      },
      {
        label: this.t('admin.permissions.summaryUngranted'),
        value: ungranted,
        hint: this.t('admin.permissions.summaryUngrantedHint'),
      },
    ];
  });

  protected readonly menuItems = computed<MenuItem[]>(() => [
    { id: 'expand', label: this.t('admin.permissions.expandAll'), icon: 'chevron-down' },
    { id: 'collapse', label: this.t('admin.permissions.collapseAll'), icon: 'chevron-right' },
    { id: 'reload', label: this.t('admin.permissions.reloadDefinitions'), icon: 'refresh', separatorBefore: true },
  ]);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    effect(() => {
      const data = this.matrix();
      // Guard on `data.roles.length` too: with zero roles the "select all"
      // set built below would itself be empty, so `selectedRoleIds().size`
      // would stay 0 and this effect — which both reads and writes that
      // same signal — would set a new (still-empty) Set forever.
      if (data && data.roles.length > 0 && this.selectedRoleIds().size === 0) {
        this.selectedRoleIds.set(new Set(data.roles.map((r) => r.role_id)));
      }
    });

    void this.load();
  }

  /** Row title in plain words: "Edit builds", "Manage applications". */
  protected permissionTitle(permission: string, resource: string): string {
    const { verb, object } = permissionParts(permission);
    if (!verb) {
      return permission;
    }
    const verbKey = VERB_KEYS[verb];
    return this.t('admin.permissions.actionTitle', {
      verb: verbKey ? this.t(verbKey) : verb,
      object: object || resource,
    });
  }

  protected grantedRoleNames(permission: string): string[] {
    return this.grantedByKey().get(permission) ?? [];
  }

  protected onMenu(id: string): void {
    if (id === 'expand') {
      this.expandAll();
    } else if (id === 'collapse') {
      this.collapseAll();
    } else if (id === 'reload') {
      void this.reload();
    }
  }

  protected onModuleChange(event: Event): void {
    this.selectedModule.set((event.target as HTMLSelectElement).value);
  }

  protected toggleRoleVisibility(roleId: string): void {
    this.selectedRoleIds.update((set) => {
      const next = new Set(set);
      if (next.has(roleId)) {
        if (next.size > 1) {
          next.delete(roleId);
        }
      } else {
        next.add(roleId);
      }
      return next;
    });
  }

  protected selectAllRoles(): void {
    const matrix = this.matrix();
    if (matrix) {
      this.selectedRoleIds.set(new Set(matrix.roles.map((r) => r.role_id)));
    }
  }

  protected isRoleVisible(roleId: string): boolean {
    return this.selectedRoleIds().has(roleId);
  }

  /** The last visible role cannot be hidden, so its box is locked on. */
  protected isOnlyVisibleRole(roleId: string): boolean {
    return this.visibleRoles().length === 1 && this.isRoleVisible(roleId);
  }

  protected isGroupCollapsed(resource: string): boolean {
    return this.collapsedGroups().has(resource);
  }

  protected toggleGroupCollapse(resource: string): void {
    this.collapsedGroups.update((set) => {
      const next = new Set(set);
      if (next.has(resource)) {
        next.delete(resource);
      } else {
        next.add(resource);
      }
      return next;
    });
  }

  protected expandAll(): void {
    this.collapsedGroups.set(new Set());
  }

  protected collapseAll(): void {
    const all = this.permissionGroups().map((g) => g.resource);
    this.collapsedGroups.set(new Set(all));
  }

  protected clearFilters(): void {
    this.searchQuery.set('');
    this.selectedModule.set('all');
    this.selectAllRoles();
  }

  protected hasPermission(role: RolePermissionsView, permission: string): boolean {
    return role.permissions.includes(permission);
  }

  protected groupFullyGranted(role: RolePermissionsView, keys: readonly string[]): boolean {
    return keys.every((key) => role.permissions.includes(key));
  }

  protected toggle(role: RolePermissionsView, permission: string, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    return this.enqueueSave(role.role_id, (current) =>
      checked
        ? [...new Set([...current, permission])]
        : current.filter((p) => p !== permission),
    );
  }

  protected toggleGroup(role: RolePermissionsView, keys: readonly string[], grant: boolean): Promise<void> {
    return this.enqueueSave(role.role_id, (current) =>
      grant
        ? [...new Set([...current, ...keys])]
        : current.filter((permission) => !keys.includes(permission)),
    );
  }

  /**
   * Saves one role's permissions. The change is applied to the permissions
   * the role holds when its turn in the queue comes, so two quick clicks on
   * the same role cannot overwrite each other.
   */
  private enqueueSave(roleId: string, mutate: (current: readonly string[]) => string[]): Promise<void> {
    this.pendingSaves.update((n) => n + 1);
    this.saveOutcome.set(null);
    const previous = this.saveQueues.get(roleId) ?? Promise.resolve();
    const run = previous
      .then(() => this.persist(roleId, mutate))
      .finally(() => {
        this.pendingSaves.update((n) => n - 1);
        if (this.saveQueues.get(roleId) === run) {
          this.saveQueues.delete(roleId);
        }
      });
    this.saveQueues.set(roleId, run);
    return run;
  }

  private async persist(roleId: string, mutate: (current: readonly string[]) => string[]): Promise<void> {
    const role = this.matrix()?.roles.find((r) => r.role_id === roleId);
    if (!role) {
      return;
    }
    try {
      const updated = await firstValueFrom(
        this.api.put<PermissionMatrix>(
          `api/admin/roles/${encodeURIComponent(roleId)}/permissions`,
          { permissions: mutate(role.permissions) },
        ),
      );
      this.matrix.set(updated);
      this.saveOutcome.set('saved');
    } catch {
      this.saveOutcome.set('error');
      this.toasts.error(this.t('admin.permissions.saveError'));
      await this.load();
    }
  }

  protected async reload(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<string>('api/admin/permissions/reload'));
      this.toasts.success(this.t('admin.reloaded'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    }
  }

  /** The first load shows a skeleton; later reloads refresh the matrix in place. */
  protected async load(): Promise<void> {
    if (!this.matrix()) {
      this.loading.set(true);
    }
    try {
      const matrix = await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions'));
      this.matrix.set(matrix);
    } catch {
      this.toasts.error(this.t('admin.loadError'));
    } finally {
      this.loading.set(false);
    }
  }
}
