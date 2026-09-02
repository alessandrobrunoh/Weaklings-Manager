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
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { groupPermissions, type PermissionGroup } from './permission-groups';

/**
 * Role × permission matrix with search, module filtering, role visibility toggles,
 * and collapsible accordion groups.
 */
@Component({
  selector: 'app-admin-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Icon, Loading, PageHeader, PageStack, TooltipDirective],
  styles: `
    :host {
      display: block;
    }

    .matrix-container {
      position: relative;
      max-height: calc(100vh - 16rem);
      overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background-color: var(--color-surface);
    }

    .matrix-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
    }

    .matrix-table thead th {
      position: sticky;
      top: 0;
      z-index: 20;
      background-color: var(--color-surface-2);
      border-bottom: 1px solid var(--color-border);
      padding: 0.75rem 1rem;
      white-space: nowrap;
    }

    .matrix-table thead th.sticky-corner {
      position: sticky;
      left: 0;
      top: 0;
      z-index: 30;
      background-color: var(--color-surface-2);
      border-right: 1px solid var(--color-border);
    }

    .matrix-table tbody td.sticky-col {
      position: sticky;
      left: 0;
      z-index: 10;
      background-color: var(--color-surface);
      border-right: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
    }

    .matrix-table tbody tr.row--granted td.sticky-col {
      background-color: var(--color-surface);
    }

    .matrix-table tbody td.matrix-cell {
      border-bottom: 1px solid var(--color-border);
      border-right: 1px solid var(--color-border);
      padding: 0;
      transition: background-color 150ms ease;
    }

    .matrix-table tbody td.matrix-cell--granted {
      background-color: var(--color-surface-hover);
    }

    .matrix-table tbody tr.group-row td {
      position: sticky;
      top: 4.25rem;
      z-index: 15;
      background-color: var(--color-surface-2);
      border-bottom: 1px solid var(--color-border);
      border-top: 1px solid var(--color-border);
    }

    .matrix-table tbody tr.group-footer-row td {
      background-color: var(--color-surface-1);
      border-bottom: 2px solid var(--color-border);
    }
  `,
  template: `
    <app-page-header
      [title]="t('admin.permissions.title')"
      [subtitle]="t('admin.permissions.hint')"
    />

    @if (loading()) {
      <app-loading />
    } @else if (matrix(); as data) {
      <app-page-stack>
      <!-- Filter & Search Toolbar -->
      <section class="card p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <!-- Left filters -->
          <div class="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
            <!-- Search input -->
            <div class="relative flex-1 min-w-[180px] max-w-[280px] flex items-center">
              <app-icon
                name="search"
                size="0.875rem"
                class="absolute left-3 text-[var(--color-text-secondary)] pointer-events-none"
              />
              <input
                type="search"
                class="w-full pl-8.5 pr-7 py-1.5 text-xs bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-inputs)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-text-secondary)] transition-colors"
                [placeholder]="t('admin.permissions.searchPlaceholder')"
                [value]="searchQuery()"
                (input)="onSearchInput($event)"
              />
              @if (searchQuery().length > 0) {
                <button
                  type="button"
                  class="absolute right-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] cursor-pointer"
                  (click)="clearSearch()"
                  aria-label="Clear search"
                >
                  <app-icon name="close" size="0.75rem" />
                </button>
              }
            </div>

            <!-- Module dropdown -->
            <select
              class="select select--sm text-xs min-w-[130px]"
              [value]="selectedModule()"
              (change)="onModuleChange($event)"
            >
              <option value="all">{{ t('admin.permissions.allModules') }}</option>
              @for (mod of allModules(); track mod) {
                <option [value]="mod">{{ mod }}</option>
              }
            </select>

            <!-- Role visibility filter -->
            <div class="relative">
              <button
                type="button"
                class="btn btn--outline btn--sm text-xs flex items-center gap-1.5"
                (click)="toggleRoleFilterOpen()"
              >
                <app-icon name="users" size="0.875rem" />
                <span>{{ t('admin.permissions.roles') }} ({{ visibleRoles().length }}/{{ data.roles.length }})</span>
                <app-icon [name]="roleFilterOpen() ? 'chevron-up' : 'chevron-down'" size="0.75rem" />
              </button>

              @if (roleFilterOpen()) {
                <div
                  class="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-2xl"
                >
                  <div class="flex items-center justify-between pb-2 mb-2 border-b border-[var(--color-border)] px-1">
                    <span class="text-[11px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                      {{ t('admin.permissions.roles') }}
                    </span>
                    <button
                      type="button"
                      class="text-xs text-[var(--color-primary)] hover:underline font-medium cursor-pointer"
                      (click)="selectAllRoles()"
                    >
                      {{ t('admin.permissions.selectAllRoles') }}
                    </button>
                  </div>
                  <div class="max-h-52 overflow-y-auto flex flex-col gap-1 scrollbar-thin">
                    @for (role of data.roles; track role.role_id) {
                      <label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--color-surface-hover)] cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          class="checkbox"
                          [checked]="isRoleVisible(role.role_id)"
                          (change)="toggleRoleVisibility(role.role_id)"
                        />
                        <span class="truncate font-medium text-[var(--color-text)]">{{ role.role_name }}</span>
                        <span class="ml-auto text-[10px] text-[var(--color-text-disabled)] font-mono">P{{ role.priority }}</span>
                      </label>
                    }
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- Right quick actions -->
          <div class="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              class="btn btn--ghost btn--sm text-xs flex items-center gap-1.5"
              (click)="expandAll()"
              [appTooltip]="t('admin.permissions.expandAll')"
              tooltipPosition="top"
            >
              <app-icon name="chevron-down" size="0.875rem" />
              <span class="hidden sm:inline">{{ t('admin.permissions.expandAll') }}</span>
            </button>

            <button
              type="button"
              class="btn btn--ghost btn--sm text-xs flex items-center gap-1.5"
              (click)="collapseAll()"
              [appTooltip]="t('admin.permissions.collapseAll')"
              tooltipPosition="top"
            >
              <app-icon name="chevron-right" size="0.875rem" />
              <span class="hidden sm:inline">{{ t('admin.permissions.collapseAll') }}</span>
            </button>

            <button
              type="button"
              class="btn btn--outline btn--sm text-xs flex items-center gap-1.5"
              [disabled]="reloading()"
              (click)="reload()"
            >
              <app-icon name="refresh" size="0.875rem" [class.animate-spin]="reloading()" />
              <span>{{ t('admin.permissions.reloadDefinitions') }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Matrix Table / Empty State -->
      @if (filteredGroups().length === 0) {
        <div class="card p-8 flex flex-col items-center justify-center">
          <app-empty-state
            [message]="t('admin.permissions.emptyMatch')"
            icon="shield"
          />
          @if (searchQuery().length > 0 || selectedModule() !== 'all') {
            <button
              type="button"
              class="btn btn--outline btn--sm mt-4"
              (click)="clearFilters()"
            >
              {{ t('common.clearFilters') }}
            </button>
          }
        </div>
      } @else {
        <div class="matrix-container scrollbar-thin">
          <table class="matrix-table">
            <thead>
              <tr>
                <th class="sticky-corner min-w-64 text-left">
                  <span class="font-medium text-xs text-[var(--color-text)]">
                    {{ t('admin.permissions.permission') }}
                  </span>
                  <span class="text-[11px] text-[var(--color-text-secondary)] font-normal block mt-0.5">
                    {{ totalPermissionsCount() }} {{ t('admin.permissions.permission').toLowerCase() }}
                  </span>
                </th>
                @for (role of visibleRoles(); track role.role_id) {
                  <th class="text-center min-w-32">
                    <div class="font-semibold text-xs text-[var(--color-text)]">
                      {{ role.role_name }}
                    </div>
                    <div class="mono text-[10px] text-[var(--color-text-secondary)] mt-0.5 flex items-center justify-center gap-1">
                      <span>{{ t('admin.permissions.priority') }} {{ role.priority }}</span>
                      @if (role.is_default) {
                        <span class="text-[var(--color-primary)] font-bold">· Default</span>
                      }
                    </div>
                    @if (role.discord_role_id) {
                      <div class="mono text-[9px] text-[var(--color-text-disabled)] mt-0.5 truncate max-w-[120px] mx-auto">
                        {{ role.discord_role_id }}
                      </div>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (group of filteredGroups(); track group.resource) {
                <!-- Accordion Group Header -->
                <tr class="group-row">
                  <td [attr.colspan]="visibleRoles().length + 1" class="p-0">
                    <div class="flex items-center justify-between px-4 py-2.5 bg-[var(--color-surface-2)]">
                      <button
                        type="button"
                        class="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors cursor-pointer text-left"
                        (click)="toggleGroupCollapse(group.resource)"
                      >
                        <app-icon
                          [name]="isGroupCollapsed(group.resource) ? 'chevron-right' : 'chevron-down'"
                          size="0.875rem"
                          class="text-[var(--color-text-secondary)]"
                        />
                        <span class="font-mono text-sm tracking-normal capitalize">{{ group.resource }}</span>
                        <span class="inline-flex items-center px-2 py-0.2 rounded-full text-[10px] font-medium bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                          {{ group.keys.length }}
                        </span>
                      </button>

                      <button
                        type="button"
                        class="btn btn--ghost btn--sm text-[11px] py-0.5 px-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] cursor-pointer"
                        (click)="toggleGroupCollapse(group.resource)"
                      >
                        {{ isGroupCollapsed(group.resource) ? t('admin.permissions.expand') : t('admin.permissions.collapse') }}
                      </button>
                    </div>
                  </td>
                </tr>

                <!-- Group Permission Rows (when expanded) -->
                @if (!isGroupCollapsed(group.resource)) {
                  @for (permission of group.keys; track permission) {
                    <tr>
                      <td class="sticky-col mono text-xs font-medium px-4 py-2.5">
                        {{ permission }}
                      </td>
                      @for (role of visibleRoles(); track role.role_id) {
                        @let granted = hasPermission(role, permission);
                        @let saving = isSaving(role, permission);
                        <td
                          class="matrix-cell text-center"
                          [class.matrix-cell--granted]="granted"
                        >
                          <label
                            class="flex items-center justify-center p-2.5 cursor-pointer w-full h-full"
                            [attr.aria-label]="permission + ' for ' + role.role_name"
                          >
                            <input
                              class="checkbox"
                              type="checkbox"
                              [checked]="granted"
                              [disabled]="saving"
                              (change)="toggle(role, permission, $event)"
                            />
                          </label>
                        </td>
                      }
                    </tr>
                  }

                  <!-- Group Action Footer Row -->
                  <tr class="group-footer-row">
                    <td class="sticky-col text-xs px-4 py-2 font-medium text-[var(--color-text-secondary)]">
                      {{ t('admin.permissions.toggleGroup') }}
                    </td>
                    @for (role of visibleRoles(); track role.role_id) {
                      @let allGranted = groupFullyGranted(role, group.keys);
                      <td class="matrix-cell text-center px-2 py-1.5">
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-[10px] py-0.5 px-2 w-full"
                          [class.btn--primary]="!allGranted"
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
  protected readonly reloading = signal(false);
  private readonly savingKeys = signal<ReadonlySet<string>>(new Set());
  protected readonly matrix = signal<PermissionMatrix | null>(null);

  protected readonly searchQuery = signal('');
  protected readonly selectedModule = signal<string>('all');
  protected readonly selectedRoleIds = signal<ReadonlySet<string>>(new Set());
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());
  protected readonly roleFilterOpen = signal(false);

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

  protected readonly totalPermissionsCount = computed<number>(() => {
    return this.filteredGroups().reduce((acc, group) => acc + group.keys.length, 0);
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    effect(() => {
      const data = this.matrix();
      if (data && this.selectedRoleIds().size === 0) {
        this.selectedRoleIds.set(new Set(data.roles.map((r) => r.role_id)));
      }
    });

    void this.load();
  }

  protected onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  protected clearSearch(): void {
    this.searchQuery.set('');
  }

  protected onModuleChange(event: Event): void {
    this.selectedModule.set((event.target as HTMLSelectElement).value);
  }

  protected toggleRoleFilterOpen(): void {
    this.roleFilterOpen.update((open) => !open);
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
  }

  protected hasPermission(role: RolePermissionsView, permission: string): boolean {
    return role.permissions.includes(permission);
  }

  protected groupFullyGranted(role: RolePermissionsView, keys: readonly string[]): boolean {
    return keys.every((key) => role.permissions.includes(key));
  }

  private cellKey(role: RolePermissionsView, permission: string): string {
    return `${role.role_id}:${permission}`;
  }

  protected isSaving(role: RolePermissionsView, permission: string): boolean {
    return this.savingKeys().has(this.cellKey(role, permission));
  }

  protected async toggleGroup(
    role: RolePermissionsView,
    keys: readonly string[],
    grant: boolean,
  ): Promise<void> {
    const next = grant
      ? [...new Set([...role.permissions, ...keys])]
      : role.permissions.filter((permission) => !keys.includes(permission));
    try {
      const updated = await firstValueFrom(
        this.api.put<PermissionMatrix>(
          `api/admin/roles/${encodeURIComponent(role.role_id)}/permissions`,
          { permissions: next },
        ),
      );
      this.matrix.set(updated);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      await this.load();
    }
  }

  protected async toggle(
    role: RolePermissionsView,
    permission: string,
    event: Event,
  ): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    const next = checked
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission);

    const key = this.cellKey(role, permission);
    this.savingKeys.update((keys) => new Set(keys).add(key));
    try {
      const updated = await firstValueFrom(
        this.api.put<PermissionMatrix>(
          `api/admin/roles/${encodeURIComponent(role.role_id)}/permissions`,
          { permissions: next },
        ),
      );
      this.matrix.set(updated);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      await this.load();
    } finally {
      this.savingKeys.update((keys) => {
        const nextKeys = new Set(keys);
        nextKeys.delete(key);
        return nextKeys;
      });
    }
  }

  protected async reload(): Promise<void> {
    this.reloading.set(true);
    try {
      await firstValueFrom(this.api.post<string>('api/admin/permissions/reload'));
      this.toasts.success(this.t('admin.reloaded'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.reloading.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const matrix = await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions'));
      this.matrix.set(matrix);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
