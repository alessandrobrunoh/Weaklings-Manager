import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  CreateRoleRequest,
  DiscordRoleView,
  PermissionMatrix,
  RolePermissionsView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { roleSelectOptions } from '../../shared/discord/discord-options';

interface RoleDraft {
  name: string;
  priority: number;
  discord_role_id: string;
  is_default: boolean;
  is_staff: boolean;
  grants_staff: boolean;
}

interface NewRoleDraft {
  name: string;
  priority: number;
  discord_role_id: string;
}

/**
 * CRUD for gestionale roles and their Discord snowflake links.
 */
@Component({
  selector: 'app-admin-roles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, ErrorState, Loading, PageHeader, PageStack, SearchableSelect],
  template: `
    <app-page-header [title]="t('admin.roles.title')" [subtitle]="t('admin.roles.hint')">
      @if (matrix()) {
        <button type="button" class="btn btn--primary" (click)="openCreate()">
          {{ t('admin.roles.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading />
      } @else if (matrix(); as data) {
        <section class="card p-5">
          @if (data.roles.length === 0) {
            <app-empty-state [message]="t('common.empty')" />
          } @else {
            <ul class="flex flex-col gap-2" role="list">
              @for (role of data.roles; track role.role_id) {
                <li
                  class="flex flex-col gap-2 rounded-2xl px-3 py-3 sm:flex-row sm:items-end"
                  style="background: var(--color-surface-2); border: 1px solid var(--color-border)"
                >
                  <label class="flex-1">
                    <span class="block text-xs" style="color: var(--color-text-secondary)">
                      {{ t('common.name') }}
                    </span>
                    <input
                      class="input mt-1 w-full"
                      [value]="roleDrafts()[role.role_id]?.name ?? role.role_name"
                      (input)="updateRoleDraft(role, 'name', $event)"
                    />
                  </label>
                  <label class="w-28">
                    <span class="block text-xs" style="color: var(--color-text-secondary)">
                      {{ t('admin.permissions.priority') }}
                    </span>
                    <input
                      class="input mt-1 w-full"
                      type="number"
                      [value]="roleDrafts()[role.role_id]?.priority ?? role.priority"
                      (input)="updateRoleDraft(role, 'priority', $event)"
                    />
                  </label>
                  <label class="flex-[2]">
                    <span class="block text-xs" style="color: var(--color-text-secondary)">
                      {{ t('admin.roles.discordId') }}
                    </span>
                    <app-searchable-select
                      class="mt-1 block"
                      [options]="roleLinkOptions(role)"
                      [value]="roleDiscordRoleId(role)"
                      [emptyLabel]="t('admin.roles.unlinked')"
                      [searchPlaceholder]="t('common.search')"
                      [noMatchesLabel]="t('picker.noMatches')"
                      [emptyOptionsLabel]="t('picker.empty')"
                      [ariaLabel]="t('admin.roles.discordId')"
                      (valueChange)="setRoleDiscordId(role, $event)"
                    />
                  </label>
                  <div class="flex flex-col gap-2 pb-1 sm:min-w-48">
                    <label class="flex items-start gap-2">
                      <input
                        class="checkbox mt-0.5"
                        type="checkbox"
                        [checked]="roleDrafts()[role.role_id]?.is_default ?? role.is_default"
                        (change)="updateRoleDraftFlag(role, 'is_default', $event)"
                      />
                      <span>
                        <span class="text-xs">{{ t('admin.roles.default') }}</span>
                        <span class="mt-0.5 block text-[11px]" style="color: var(--color-text-secondary)">
                          {{ t('admin.roles.defaultHint') }}
                        </span>
                      </span>
                    </label>
                    <label class="flex items-start gap-2">
                      <input
                        class="checkbox mt-0.5"
                        type="checkbox"
                        [checked]="roleDrafts()[role.role_id]?.is_staff ?? role.is_staff"
                        [disabled]="!roleDiscordRoleId(role)"
                        (change)="updateRoleDraftFlag(role, 'is_staff', $event)"
                      />
                      <span>
                        <span class="text-xs">{{ t('admin.roles.staff') }}</span>
                        <span class="mt-0.5 block text-[11px]" style="color: var(--color-text-secondary)">
                          {{ t('admin.roles.staffHint') }}
                        </span>
                      </span>
                    </label>
                    <label class="flex items-start gap-2">
                      <input
                        class="checkbox mt-0.5"
                        type="checkbox"
                        [checked]="roleDrafts()[role.role_id]?.grants_staff ?? role.grants_staff"
                        [disabled]="!roleDiscordRoleId(role)"
                        (change)="updateRoleDraftFlag(role, 'grants_staff', $event)"
                      />
                      <span>
                        <span class="text-xs">{{ t('admin.roles.staffEligible') }}</span>
                        <span class="mt-0.5 block text-[11px]" style="color: var(--color-text-secondary)">
                          {{ t('admin.roles.staffEligibleHint') }}
                        </span>
                      </span>
                    </label>
                  </div>
                  <div class="flex gap-2 pb-1">
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      [disabled]="roleSavingId() === role.role_id"
                      (click)="saveRole(role)"
                    >
                      {{ t('common.save') }}
                    </button>
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      [disabled]="role.is_default || roleSavingId() === role.role_id"
                      (click)="askDelete(role)"
                    >
                      {{ t('common.delete') }}
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      } @else {
        <app-error-state
          [message]="t('admin.loadError')"
          [retryLabel]="t('common.retry')"
          (retry)="load()"
        />
      }
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('admin.roles.create')" (closed)="closeCreate()">
        <form id="create-role-form" class="grid gap-4" (submit)="createRole($event)">
          <label>
            <span class="label">{{ t('admin.roles.newName') }}</span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="newRole().name"
              (input)="updateNewRole('name', $event)"
            />
          </label>
          <label>
            <span class="label">{{ t('admin.permissions.priority') }}</span>
            <input
              class="input"
              type="number"
              [value]="newRole().priority"
              (input)="updateNewRole('priority', $event)"
            />
          </label>
          <label>
            <span class="label">{{ t('admin.roles.discordId') }}</span>
            <app-searchable-select
              [options]="roleLinkOptions(null)"
              [value]="newRole().discord_role_id"
              [emptyLabel]="t('admin.roles.unlinked')"
              [searchPlaceholder]="t('common.search')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('picker.empty')"
              [ariaLabel]="t('admin.roles.discordId')"
              (valueChange)="setNewRoleDiscordId($event)"
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
            form="create-role-form"
            [disabled]="roleCreating()"
          >
            {{ t('admin.roles.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (deleteTarget(); as role) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteTarget.set(null)">
        <p>{{ t('admin.roles.deleteConfirm') }}</p>
        <p class="mt-2 font-medium">{{ role.role_name }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="deleteTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="confirmDelete()">
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class AdminRoles {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(true);
  protected readonly matrix = signal<PermissionMatrix | null>(null);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly roleDrafts = signal<Record<string, RoleDraft>>({});
  protected readonly roleSavingId = signal<string | null>(null);
  protected readonly roleCreating = signal(false);
  protected readonly createOpen = signal(false);
  protected readonly deleteTarget = signal<RolePermissionsView | null>(null);
  protected readonly newRole = signal<NewRoleDraft>({
    name: '',
    priority: 0,
    discord_role_id: '',
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  private draftFromRole(role: RolePermissionsView): RoleDraft {
    return {
      name: role.role_name,
      priority: role.priority,
      discord_role_id: role.discord_role_id ?? '',
      is_default: role.is_default,
      is_staff: role.is_staff,
      grants_staff: role.grants_staff,
    };
  }

  private draftFor(
    role: RolePermissionsView,
    drafts: Record<string, RoleDraft> = this.roleDrafts(),
  ): RoleDraft {
    return drafts[role.role_id] ?? this.draftFromRole(role);
  }

  constructor() {
    void this.load();
    void this.loadDiscordRoles();
  }

  protected roleDiscordRoleId(role: RolePermissionsView): string {
    return this.roleDrafts()[role.role_id]?.discord_role_id ?? role.discord_role_id ?? '';
  }

  protected roleLinkOptions(role: RolePermissionsView | null) {
    const currentId = role ? this.roleDiscordRoleId(role) : this.newRole().discord_role_id;
    return roleSelectOptions(this.discordRoleOptions(role), currentId);
  }

  protected setRoleDiscordId(role: RolePermissionsView, discordRoleId: string): void {
    this.roleDrafts.update((drafts) => {
      const current = this.draftFor(role, drafts);
      const linked = Boolean(discordRoleId);
      return {
        ...drafts,
        [role.role_id]: {
          ...current,
          discord_role_id: discordRoleId,
          is_staff: linked ? current.is_staff : false,
          grants_staff: linked ? current.grants_staff : false,
        },
      };
    });
  }

  protected setNewRoleDiscordId(discordRoleId: string): void {
    this.newRole.update((draft) => ({ ...draft, discord_role_id: discordRoleId }));
  }

  protected discordRoleOptions(role: RolePermissionsView | null): DiscordRoleView[] {
    const currentId = role ? this.roleDiscordRoleId(role) : this.newRole().discord_role_id;
    const linked = new Set(
      (this.matrix()?.roles ?? [])
        .map((item) => item.discord_role_id)
        .filter((id): id is string => Boolean(id)),
    );
    const options = this.discordRoles().filter((discordRole) =>
      discordRole.id === currentId || !linked.has(discordRole.id),
    );

    // Keep a saved link visible even when Discord no longer returns that role
    // (for example, after a guild/token mismatch or a deleted role).
    if (currentId && !options.some((discordRole) => discordRole.id === currentId)) {
      options.unshift({
        id: currentId,
        name: `Linked role (${currentId})`,
        position: 0,
        managed: false,
      });
    }

    return options;
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const matrix = await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions'));
      this.matrix.set(matrix);
      this.syncRoleDrafts(matrix);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadDiscordRoles(): Promise<void> {
    try {
      // Use the same assignable-role endpoint as the AutoRole page. The old
      // endpoint requires a separate permission and made valid links appear
      // as "Not linked" when only autorole.manage was available.
      const roles = await firstValueFrom(
        this.api.get<DiscordRoleView[]>('api/admin/discord/roles'),
      );
      this.discordRoles.set(roles);
    } catch {
      try {
        const roles = await firstValueFrom(
          this.api.get<DiscordRoleView[]>('api/admin/autorole/roles'),
        );
        this.discordRoles.set(roles);
      } catch {
        this.toasts.error(this.t('picker.empty'));
      }
    }
  }

  private syncRoleDrafts(matrix: PermissionMatrix): void {
    const drafts: Record<string, RoleDraft> = {};
    for (const role of matrix.roles) {
      drafts[role.role_id] = this.draftFromRole(role);
    }
    this.roleDrafts.set(drafts);
  }

  protected updateRoleDraft(
    role: RolePermissionsView,
    field: 'name' | 'priority' | 'discord_role_id',
    event: Event,
  ): void {
    const raw = (event.target as HTMLInputElement).value;
    this.roleDrafts.update((drafts) => {
      const current = this.draftFor(role, drafts);
      return {
        ...drafts,
        [role.role_id]: {
          ...current,
          [field]: field === 'priority' ? Number(raw) : raw,
        },
      };
    });
  }

  protected updateRoleDraftFlag(
    role: RolePermissionsView,
    field: 'is_default' | 'is_staff' | 'grants_staff',
    event: Event,
  ): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.roleDrafts.update((drafts) => {
      const current = this.draftFor(role, drafts);
      return { ...drafts, [role.role_id]: { ...current, [field]: checked } };
    });
  }

  protected updateNewRole(field: 'name' | 'priority' | 'discord_role_id', event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.newRole.update((draft) => ({
      ...draft,
      [field]: field === 'priority' ? Number(raw) : raw,
    }));
  }

  protected openCreate(): void {
    this.newRole.set({ name: '', priority: 0, discord_role_id: '' });
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  protected async saveRole(role: RolePermissionsView): Promise<void> {
    const draft = this.roleDrafts()[role.role_id];
    if (!draft) {
      return;
    }
    this.roleSavingId.set(role.role_id);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PermissionMatrix>(`api/admin/roles/${encodeURIComponent(role.role_id)}`, {
          name: draft.name,
          priority: draft.priority,
          discord_role_id: draft.discord_role_id,
          is_default: draft.is_default,
          is_staff: draft.is_staff,
          grants_staff: draft.grants_staff,
        }),
      );
      this.matrix.set(updated);
      this.syncRoleDrafts(updated);
      this.toasts.success(this.t('admin.roles.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.roleSavingId.set(null);
    }
  }

  protected askDelete(role: RolePermissionsView): void {
    this.deleteTarget.set(role);
  }

  protected async confirmDelete(): Promise<void> {
    const role = this.deleteTarget();
    this.deleteTarget.set(null);
    if (!role) {
      return;
    }
    this.roleSavingId.set(role.role_id);
    try {
      const updated = await firstValueFrom(
        this.api.delete<PermissionMatrix>(`api/admin/roles/${encodeURIComponent(role.role_id)}`),
      );
      if (updated) {
        this.matrix.set(updated);
        this.syncRoleDrafts(updated);
      }
      this.toasts.success(this.t('admin.roles.deleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.roleSavingId.set(null);
    }
  }

  protected async createRole(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const draft = this.newRole();
    const body: CreateRoleRequest = {
      name: draft.name.trim(),
      priority: draft.priority,
      discord_role_id: draft.discord_role_id.trim() || null,
    };
    this.roleCreating.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<PermissionMatrix>('api/admin/roles', body),
      );
      this.matrix.set(updated);
      this.syncRoleDrafts(updated);
      this.newRole.set({ name: '', priority: 0, discord_role_id: '' });
      this.closeCreate();
      this.toasts.success(this.t('admin.roles.created'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.roleCreating.set(false);
    }
  }
}
