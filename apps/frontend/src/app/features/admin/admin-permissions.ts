import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PermissionMatrix, RolePermissionsView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { groupPermissions } from './permission-groups';

/**
 * Role × permission matrix. Each checkbox PUT-s the whole set for that role.
 */
@Component({
  selector: 'app-admin-permissions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorState, Icon, Loading, PageHeader],
  template: `
    <app-page-header [title]="t('admin.permissions.title')" [subtitle]="t('admin.permissions.hint')" />

    @if (loading()) {
      <app-loading />
    } @else if (matrix(); as data) {
      <section class="card overflow-x-auto">
        <header class="flex flex-wrap items-center justify-end gap-3 p-4 pb-2">
          <button type="button" class="btn btn--outline btn--sm" (click)="reload()">
            <app-icon name="activity" size="0.9rem" />
            {{ t('admin.reload') }}
          </button>
        </header>

        <table class="table">
          <thead>
            <tr>
              <th class="min-w-64">{{ t('admin.permissions.permission') }}</th>
              @for (role of data.roles; track role.role_id) {
                <th class="text-center">
                  {{ role.role_name }}
                  <span class="mono block text-[10px]" style="color: var(--color-text-disabled)">
                    {{ t('admin.permissions.priority') }} {{ role.priority }}
                    @if (role.discord_role_id) {
                      <br />{{ role.discord_role_id }}
                    }
                    @if (role.is_default) {
                      · {{ t('admin.roles.default') }}
                    }
                  </span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (group of permissionGroups(); track group.resource) {
              <tr>
                <th class="text-left text-xs uppercase tracking-wider" [attr.colspan]="data.roles.length + 1">
                  {{ group.resource }}
                </th>
              </tr>
              @for (permission of group.keys; track permission) {
                <tr>
                  <td class="mono text-xs">{{ permission }}</td>
                  @for (role of data.roles; track role.role_id) {
                    <td class="text-center p-0">
                      <label class="flex items-center justify-center p-3">
                        <input
                          class="checkbox"
                          type="checkbox"
                          [checked]="hasPermission(role, permission)"
                          [disabled]="isSaving(role, permission)"
                          (change)="toggle(role, permission, $event)"
                          [attr.aria-label]="permission + ' for ' + role.role_name"
                        />
                      </label>
                    </td>
                  }
                </tr>
              }
              <tr>
                <td class="text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.permissions.toggleGroup') }}
                </td>
                @for (role of data.roles; track role.role_id) {
                  <td class="text-center p-2">
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      (click)="toggleGroup(role, group.keys, !groupFullyGranted(role, group.keys))"
                    >
                      {{ groupFullyGranted(role, group.keys) ? t('admin.permissions.clearGroup') : t('admin.permissions.grantGroup') }}
                    </button>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </section>
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
  private readonly savingKeys = signal<ReadonlySet<string>>(new Set());
  protected readonly matrix = signal<PermissionMatrix | null>(null);

  protected readonly permissionGroups = computed(() => {
    const matrix = this.matrix();
    if (!matrix) {
      return [];
    }
    return groupPermissions(matrix.permission_catalog, matrix.available_permissions);
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
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

  /**
   * Grants or revokes one permission.
   *
   * The whole set is sent rather than a delta, so the result does not depend
   * on what the server happened to hold when the request arrived.
   */
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
    try {
      await firstValueFrom(this.api.post<string>('api/admin/permissions/reload'));
      this.toasts.success(this.t('admin.reloaded'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
