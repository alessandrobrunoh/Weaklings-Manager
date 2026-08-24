import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PermissionMatrix, RolePermissionsView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/** Where each editable setting actually lives, so admins can find it. */
interface SettingsLink {
  readonly path: string;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
}

/**
 * Administration console.
 *
 * The authorization matrix is the substance of this page. Roles themselves are
 * owned by Discord — every login overwrites `users.role` from the member's
 * Discord roles — so the meaningful thing an administrator controls is not who
 * holds a role, but what a role is permitted to do. That mapping is data, by
 * design, and until now it could only be changed with direct SQL.
 *
 * The rest of the guild's settings live next to the features they configure;
 * rather than duplicate them here, this page points to where they are.
 */
@Component({
  selector: 'app-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, Icon, Loading, PageHeader, RouterLink],
  template: `
    <app-page-header [title]="t('admin.title')" [subtitle]="t('admin.subtitle')" />

    @if (loading()) {
      <app-loading />
    } @else if (matrix(); as data) {
      <section class="card mb-6 overflow-x-auto">
        <header class="flex flex-wrap items-center justify-between gap-3 p-4 pb-2">
          <div>
            <h2 class="eyebrow">{{ t('admin.permissions.title') }}</h2>
            <p class="mt-1 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
              {{ t('admin.permissions.hint') }}
            </p>
          </div>
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
                  </span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (permission of data.available_permissions; track permission) {
              <tr>
                <td class="mono text-xs">{{ permission }}</td>
                @for (role of data.roles; track role.role_id) {
                  <td class="text-center p-0">
                    <!-- The checkbox itself stays the usual 16px, but the
                         label wraps the full cell so the actual tap target
                         is the whole square — a bare 16px control in a dense
                         per-role grid is well under any reasonable touch
                         target size. -->
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
          </tbody>
        </table>
      </section>

      <section class="card p-5">
        <h2 class="eyebrow mb-1">{{ t('admin.elsewhere.title') }}</h2>
        <p class="mb-3 text-xs" style="color: var(--color-text-secondary)">
          {{ t('admin.elsewhere.hint') }}
        </p>
        <ul class="flex flex-col gap-1" role="list">
          @for (link of settingsLinks; track link.path) {
            <li>
              <a
                class="flex items-center justify-between rounded-2xl px-3 py-2 no-underline"
                style="color: var(--color-text)"
                [routerLink]="link.path"
              >
                <span>
                  {{ t(link.labelKey) }}
                  <span class="block text-xs" style="color: var(--color-text-secondary)">
                    {{ t(link.hintKey) }}
                  </span>
                </span>
                <app-icon name="chevron-right" size="1rem" />
              </a>
            </li>
          }
        </ul>
      </section>
    } @else {
      <app-empty-state
        icon="alert"
        [message]="t('admin.loadError')"
      />
    }
  `,
})
export class Admin {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(true);
  /** Keys of `(role, permission)` pairs currently being saved. */
  private readonly savingKeys = signal<ReadonlySet<string>>(new Set());
  protected readonly matrix = signal<PermissionMatrix | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly settingsLinks: SettingsLink[] = [
    { path: '/regears', labelKey: 'admin.link.regear', hintKey: 'admin.link.regearHint' },
    { path: '/comps', labelKey: 'admin.link.comps', hintKey: 'admin.link.compsHint' },
    { path: '/users', labelKey: 'admin.link.users', hintKey: 'admin.link.usersHint' },
    { path: '/audit', labelKey: 'admin.link.audit', hintKey: 'admin.link.auditHint' },
  ];

  protected hasPermission(role: RolePermissionsView, permission: string): boolean {
    return role.permissions.includes(permission);
  }

  private cellKey(role: RolePermissionsView, permission: string): string {
    return `${role.role_id}:${permission}`;
  }

  protected isSaving(role: RolePermissionsView, permission: string): boolean {
    return this.savingKeys().has(this.cellKey(role, permission));
  }

  /**
   * Grants or revokes one permission.
   *
   * The whole set is sent rather than a delta, so the result does not depend
   * on what the server happened to hold when the request arrived.
   *
   * Only the cell being changed disables — the previous version gated the
   * *entire* matrix behind one `saving` flag, so toggling a single checkbox
   * froze every other role and permission until the request returned, which
   * on a slow connection read as the whole page being unresponsive.
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
      // Re-read rather than trusting the local guess: a rejected change must
      // not leave the grid showing something the server did not accept.
      await this.load();
    } finally {
      this.savingKeys.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
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

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.matrix.set(await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions')));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
