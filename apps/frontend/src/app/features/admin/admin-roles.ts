import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateRoleRequest,
  DiscordRoleView,
  PermissionMatrix,
  RolePermissionsView,
  UpdateRoleRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { roleSelectOptions } from '../../shared/discord/discord-options';

/** Editable fields of one role, shared by the create and edit dialog. */
interface RoleDraft {
  name: string;
  priority: number;
  discord_role_id: string;
  is_default: boolean;
  is_staff: boolean;
  grants_staff: boolean;
}

/** How many modules the powers summary names before it collapses the rest into a count. */
const SUMMARY_MODULE_LIMIT = 3;

function emptyDraft(): RoleDraft {
  return {
    name: '',
    priority: 0,
    discord_role_id: '',
    is_default: false,
    is_staff: false,
    grants_staff: false,
  };
}

function draftFromRole(role: RolePermissionsView): RoleDraft {
  return {
    name: role.role_name,
    priority: role.priority,
    discord_role_id: role.discord_role_id ?? '',
    is_default: role.is_default,
    is_staff: role.is_staff,
    grants_staff: role.grants_staff,
  };
}

function moduleLabel(resource: string): string {
  const spaced = resource.replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Gestionale roles: a table of every role with its member link, its powers in one line and its
 * flags. Create and edit share one dialog; delete sits in the row menu behind a confirmation.
 * Detailed grants live on the Permissions page, which the header tabs and the hint link to.
 */
@Component({
  selector: 'app-admin-roles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    Menu,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  template: `
    <app-page-header [title]="t('admin.roles.title')" [subtitle]="t('admin.roles.hint')">
      <app-tabs
        pageTabs
        [options]="sectionTabs()"
        active="roles"
        [ariaLabel]="t('admin.roles.title')"
      />
      @if (matrix()) {
        <button type="button" class="btn btn--primary" (click)="openCreate()">
          {{ t('admin.roles.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      @if (matrix()) {
        <app-summary-band [ariaLabel]="t('admin.roles.title')" [items]="summary()" />
      }

      <section class="card">
        <p class="hint mb-3 flex flex-wrap items-center gap-3">
          <span>{{ t('admin.roles.grantsHint') }}</span>
          <a class="btn btn--outline btn--sm" routerLink="/admin/permissions">
            {{ t('admin.roles.openPermissions') }}
          </a>
        </p>
        <app-data-table
          [columns]="columns"
          [rows]="roles()"
          [loading]="loading()"
          [error]="!loading() && !matrix()"
          (retry)="load()"
          [trackBy]="trackRole"
          [hideSearch]="true"
          [hidePageSize]="true"
          [syncUrl]="false"
          [pageSize]="25"
          [mobileLayout]="'stack'"
          [ariaLabel]="t('admin.roles.title')"
        >
            <ng-template dataTableCell="name" let-row>
              <span class="font-medium">{{ row.role_name }}</span>
              @if (row.is_default) {
                <span class="hint block">{{ t('admin.roles.defaultLocked') }}</span>
              }
            </ng-template>
            <ng-template dataTableCell="powers" let-row>
              <span class="hint">{{ powersSummary(row) }}</span>
            </ng-template>
            <ng-template dataTableCell="discord" let-row>
              @if (row.discord_role_id) {
                {{ discordRoleName(row.discord_role_id) }}
              } @else {
                <span class="hint">{{ t('admin.roles.unlinked') }}</span>
              }
            </ng-template>
            <ng-template dataTableCell="flags" let-row>
              <span class="flex flex-wrap gap-1">
                @if (row.is_default) {
                  <app-status-chip
                    value="default"
                    [label]="t('admin.roles.default')"
                    [toneOverride]="'neutral'"
                    [showDot]="false"
                  />
                }
                @if (row.is_staff) {
                  <app-status-chip
                    value="staff"
                    [label]="t('admin.roles.staff')"
                    [toneOverride]="'neutral'"
                    [showDot]="false"
                  />
                }
                @if (row.grants_staff) {
                  <app-status-chip
                    value="staff_eligible"
                    [label]="t('admin.roles.staffEligible')"
                    [toneOverride]="'neutral'"
                    [showDot]="false"
                  />
                }
              </span>
            </ng-template>
            <ng-template dataTableCell="actions" let-row>
              <app-menu
                [items]="rowMenuFor(row)"
                [label]="t('admin.roles.rowActions', { name: row.role_name })"
                (itemSelect)="onRowAction(row, $event)"
              />
            </ng-template>
        </app-data-table>
      </section>
    </app-page-stack>

    @if (editorOpen()) {
      <app-dialog
        [title]="editing() ? t('admin.roles.edit') : t('admin.roles.create')"
        (closed)="closeEditor()"
      >
        <form id="role-editor-form" class="grid gap-4" (submit)="saveRole($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label>
            <span class="label">
              {{ t('common.name') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="draft().name"
              (input)="updateDraftText('name', $event)"
            />
          </label>
          <label>
            <span class="label">{{ t('admin.roles.priority') }}</span>
            <input
              class="input"
              type="number"
              [value]="draft().priority"
              (input)="updateDraftText('priority', $event)"
            />
          </label>
          <div>
            <span class="label">{{ t('admin.roles.discordId') }}</span>
            <app-searchable-select
              class="mt-1 block"
              [options]="discordLinkOptions()"
              [value]="draft().discord_role_id"
              [emptyLabel]="t('admin.roles.unlinked')"
              [searchPlaceholder]="t('common.search')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('picker.empty')"
              [ariaLabel]="t('admin.roles.discordId')"
              (valueChange)="setDraftDiscordId($event)"
            />
            <span class="hint mt-1 block">{{ t('admin.roles.discordIdHint') }}</span>
          </div>
          <fieldset class="grid gap-3">
            <legend class="label mb-1">{{ t('admin.roles.flags') }}</legend>
            <label class="flex items-start gap-2">
              <input
                class="checkbox mt-0.5"
                type="checkbox"
                [checked]="draft().is_default"
                (change)="updateDraftFlag('is_default', $event)"
              />
              <span>
                <span class="block text-xs">{{ t('admin.roles.default') }}</span>
                <span class="hint block">{{ t('admin.roles.defaultHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input
                class="checkbox mt-0.5"
                type="checkbox"
                [checked]="draft().is_staff"
                [disabled]="!draft().discord_role_id"
                (change)="updateDraftFlag('is_staff', $event)"
              />
              <span>
                <span class="block text-xs">{{ t('admin.roles.staff') }}</span>
                <span class="hint block">{{ t('admin.roles.staffHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input
                class="checkbox mt-0.5"
                type="checkbox"
                [checked]="draft().grants_staff"
                [disabled]="!draft().discord_role_id"
                (change)="updateDraftFlag('grants_staff', $event)"
              />
              <span>
                <span class="block text-xs">{{ t('admin.roles.staffEligible') }}</span>
                <span class="hint block">{{ t('admin.roles.staffEligibleHint') }}</span>
              </span>
            </label>
          </fieldset>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeEditor()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="role-editor-form"
            [disabled]="busy()"
          >
            {{ editing() ? t('common.save') : t('admin.roles.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (deleteTarget(); as role) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteTarget.set(null)">
        <p>{{ t('admin.roles.deleteConfirm') }}</p>
        <p class="mt-2 font-medium">{{ role.role_name }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="deleteTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" [disabled]="busy()" (click)="confirmDelete()">
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
  protected readonly busy = signal(false);

  /** Role being edited, or `null` while the dialog creates a new one. */
  protected readonly editing = signal<RolePermissionsView | null>(null);
  protected readonly editorOpen = signal(false);
  protected readonly draft = signal<RoleDraft>(emptyDraft());
  protected readonly deleteTarget = signal<RolePermissionsView | null>(null);

  protected readonly roles = computed(() => this.matrix()?.roles ?? []);

  protected readonly summary = computed<SummaryItem[]>(() => {
    const roles = this.roles();
    return [
      { label: this.t('nav.admin.roles'), value: roles.length },
      { label: this.t('admin.roles.summaryLinked'), value: roles.filter((r) => r.discord_role_id).length },
      { label: this.t('admin.roles.staffEligible'), value: roles.filter((r) => r.grants_staff).length },
    ];
  });

  protected readonly sectionTabs = computed<TabOption[]>(() => [
    { id: 'roles', label: this.t('nav.admin.roles'), link: ['/admin', 'roles'] },
    { id: 'permissions', label: this.t('nav.admin.permissions'), link: ['/admin', 'permissions'] },
  ]);

  /** Stable menu arrays, so the row menus do not get new inputs on every change check. */
  private readonly editOnlyItems = computed<MenuItem[]>(() => [
    { id: 'edit', label: this.t('common.edit') },
    { id: 'delete', label: this.t('common.delete'), danger: true, separatorBefore: true },
  ]);
  private readonly lockedItems = computed<MenuItem[]>(() =>
    this.editOnlyItems().map((item) =>
      item.id === 'delete' ? { ...item, disabled: true } : item,
    ),
  );

  protected readonly columns: readonly DataTableColumn<RolePermissionsView>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (role) => role.role_name,
      comparator: (a, b) => a.role_name.localeCompare(b.role_name),
    },
    {
      key: 'priority',
      label: 'admin.roles.priority',
      sortable: true,
      align: 'right',
      accessor: (role) => role.priority,
      comparator: (a, b) => a.priority - b.priority,
    },
    { key: 'powers', label: 'admin.roles.powers' },
    { key: 'discord', label: 'admin.roles.discordId' },
    { key: 'flags', label: 'admin.roles.flags' },
    { key: 'actions', label: '', align: 'right' },
  ];

  protected readonly trackRole = (role: RolePermissionsView): unknown => role.role_id;

  /** Discord roles already linked to another gestionale role are hidden from the picker. */
  protected readonly discordLinkOptions = computed(() => {
    const draftId = this.draft().discord_role_id;
    const editingId = this.editing()?.role_id ?? null;
    const linked = new Set(
      this.roles()
        .filter((role) => role.role_id !== editingId)
        .map((role) => role.discord_role_id)
        .filter((id): id is string => Boolean(id)),
    );
    const options = this.discordRoles().filter(
      (discordRole) => discordRole.id === draftId || !linked.has(discordRole.id),
    );

    // Keep a saved link visible even when Discord no longer returns that role
    // (for example, after a guild/token mismatch or a deleted role).
    if (draftId && !options.some((discordRole) => discordRole.id === draftId)) {
      options.unshift({
        id: draftId,
        name: this.t('admin.roles.linkedUnknown', { id: draftId }),
        position: 0,
        managed: false,
      });
    }

    return roleSelectOptions(options, draftId);
  });

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
    void this.loadDiscordRoles();
  }

  /** One line for the powers column: how many permissions, and which modules they cover. */
  protected powersSummary(role: RolePermissionsView): string {
    if (role.permissions.length === 0) {
      return this.t('admin.roles.powersNone');
    }
    const modules = [...new Set(role.permissions.map((key) => key.split('.')[0]))];
    const shown = modules.slice(0, SUMMARY_MODULE_LIMIT).map(moduleLabel).join(', ');
    const more = modules.length - SUMMARY_MODULE_LIMIT;
    const modulesText =
      more > 0 ? `${shown}, ${this.t('admin.roles.powersMore', { count: more })}` : shown;
    return this.t('admin.roles.powersSummary', {
      count: role.permissions.length,
      modules: modulesText,
    });
  }

  protected discordRoleName(id: string): string {
    return (
      this.discordRoles().find((discordRole) => discordRole.id === id)?.name ??
      this.t('admin.roles.linkedUnknown', { id })
    );
  }

  protected rowMenuFor(role: RolePermissionsView): readonly MenuItem[] {
    return role.is_default ? this.lockedItems() : this.editOnlyItems();
  }

  protected onRowAction(role: RolePermissionsView, id: string): void {
    if (id === 'edit') {
      this.openEdit(role);
    } else if (id === 'delete') {
      this.deleteTarget.set(role);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const matrix = await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions'));
      this.matrix.set(matrix);
    } catch {
      this.toasts.error(this.t('admin.loadError'));
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

  protected openCreate(): void {
    this.editing.set(null);
    this.draft.set(emptyDraft());
    this.editorOpen.set(true);
  }

  protected openEdit(role: RolePermissionsView): void {
    this.editing.set(role);
    this.draft.set(draftFromRole(role));
    this.editorOpen.set(true);
  }

  protected closeEditor(): void {
    this.editorOpen.set(false);
  }

  protected updateDraftText(field: 'name' | 'priority', event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => ({
      ...draft,
      [field]: field === 'priority' ? Number(raw) : raw,
    }));
  }

  protected updateDraftFlag(field: 'is_default' | 'is_staff' | 'grants_staff', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draft.update((draft) => ({ ...draft, [field]: checked }));
  }

  /** Staff flags only mean something for a linked Discord role, so unlinking clears them. */
  protected setDraftDiscordId(discordRoleId: string): void {
    this.draft.update((draft) => ({
      ...draft,
      discord_role_id: discordRoleId,
      is_staff: discordRoleId ? draft.is_staff : false,
      grants_staff: discordRoleId ? draft.grants_staff : false,
    }));
  }

  protected async saveRole(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const draft = this.draft();
    const role = this.editing();
    const linked = Boolean(draft.discord_role_id.trim());
    const flags = {
      is_default: draft.is_default,
      is_staff: linked && draft.is_staff,
      grants_staff: linked && draft.grants_staff,
    };

    this.busy.set(true);
    try {
      let matrix: PermissionMatrix;
      if (role) {
        const body: UpdateRoleRequest = {
          name: draft.name.trim(),
          priority: draft.priority,
          discord_role_id: draft.discord_role_id,
          ...flags,
        };
        matrix = await firstValueFrom(
          this.api.patch<PermissionMatrix>(`api/admin/roles/${encodeURIComponent(role.role_id)}`, body),
        );
      } else {
        const body: CreateRoleRequest = {
          name: draft.name.trim(),
          priority: draft.priority,
          discord_role_id: draft.discord_role_id.trim() || null,
          ...flags,
        };
        matrix = await firstValueFrom(this.api.post<PermissionMatrix>('api/admin/roles', body));
      }
      this.matrix.set(matrix);
      this.editorOpen.set(false);
      this.toasts.success(this.t(role ? 'admin.roles.saved' : 'admin.roles.created'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmDelete(): Promise<void> {
    const role = this.deleteTarget();
    this.deleteTarget.set(null);
    if (!role) {
      return;
    }
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<PermissionMatrix>(`api/admin/roles/${encodeURIComponent(role.role_id)}`),
      );
      if (updated) {
        this.matrix.set(updated);
      }
      this.toasts.success(this.t('admin.roles.deleted'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }
}
