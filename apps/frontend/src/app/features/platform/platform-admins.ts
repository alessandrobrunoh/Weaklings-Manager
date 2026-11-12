import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PlatformAdminView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/** The explainer lists sit flush with the paragraph, not indented by the browser default. */
const ALLOWS_STYLES = `
  :host .pa-allows ul {
    margin: 0.5rem 0 0;
    padding-inline-start: 1.25rem;
    display: grid;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
`;

/**
 * Platform admins: control-plane SuperAdmin accounts.
 *
 * Grants go through a dialog opened from the page header. Each row has an overflow menu whose
 * remove entry asks for confirmation before the access is revoked. The page ends with a short
 * explanation of what the role can do, because it reaches across every tenant.
 */
@Component({
  selector: 'app-platform-admins',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES, ALLOWS_STYLES],
  imports: [DataTable, DataTableCell, Dialog, Menu, PageHeader, PageStack],
  template: `
    <app-page-header [title]="t('platform.admins.title')" [subtitle]="t('platform.admins.subtitle')">
      <button type="button" class="btn btn--primary" (click)="openAssign()">
        {{ t('platform.admins.assign') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <app-data-table
        [columns]="columns()"
        [rows]="admins()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [emptyLabel]="'platform.admins.empty'"
        emptyIcon="shield"
        [pageSize]="25"
        [ariaLabel]="t('platform.admins.title')"
      >
        <ng-template dataTableCell="discord_id" let-row>
          <span class="num">{{ row.discord_id }}</span>
          @if (row.discord_id === selfId) {
            <span class="chip chip--neutral ml-2">{{ t('platform.admins.you') }}</span>
          }
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex justify-end">
            <app-menu
              [items]="row.discord_id === selfId ? selfMenuItems() : removeMenuItems()"
              [label]="t('platform.admins.rowMenu', { id: row.discord_id })"
              (itemSelect)="onRowMenu(row, $event)"
            />
          </div>
        </ng-template>
      </app-data-table>

      <section class="card p-4 pa-allows" aria-labelledby="platform-admins-allows-title">
        <h2 id="platform-admins-allows-title" class="section-title">
          {{ t('platform.admins.allowsTitle') }}
        </h2>
        <p class="hint">{{ t('platform.admins.allowsLead') }}</p>
        <ul>
          <li>{{ t('platform.admins.allowsTenants') }}</li>
          <li>{{ t('platform.admins.allowsFeatures') }}</li>
          <li>{{ t('platform.admins.allowsRanks') }}</li>
          <li>{{ t('platform.admins.allowsAdmins') }}</li>
        </ul>
        <p class="hint mt-3">{{ t('platform.admins.allowsNote') }}</p>
      </section>
    </app-page-stack>

    @if (assignOpen()) {
      <app-dialog
        [title]="t('platform.admins.assignTitle')"
        [subtitle]="t('platform.admins.assignHint')"
        size="sm"
        (closed)="closeAssign()"
      >
        <form id="assign-admin-form" class="grid gap-4" (submit)="onAssign($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block" for="assign-discord-id">
            <span class="label">
              {{ t('platform.admins.discordId') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              id="assign-discord-id"
              class="input"
              name="discord_id"
              type="text"
              inputmode="numeric"
              pattern="[0-9]+"
              required
              autocomplete="off"
              autofocus
              [value]="newDiscordId()"
              [attr.aria-invalid]="idError() ? 'true' : null"
              [attr.aria-describedby]="idError() ? 'assign-discord-id-hint assign-discord-id-error' : 'assign-discord-id-hint'"
              (input)="onDiscordId($event)"
            />
          </label>
          <p id="assign-discord-id-hint" class="hint">{{ t('platform.admins.discordIdHint') }}</p>
          @if (idError(); as message) {
            <p id="assign-discord-id-error" class="hint" style="color: var(--color-error)">{{ message }}</p>
          }
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeAssign()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="assign-admin-form"
            [disabled]="assigning() || !!idError()"
          >
            {{ assigning() ? t('common.loading') : t('platform.admins.assign') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingRemoval(); as target) {
      <app-dialog
        [title]="t('platform.admins.removeTitle')"
        [subtitle]="t('platform.admins.removeHint', { id: target.discord_id })"
        size="sm"
        (closed)="pendingRemoval.set(null)"
      >
        <p class="text-sm">{{ t('platform.admins.removeBody') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="pendingRemoval.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="busyId() === target.discord_id"
            (click)="confirmRemove(target)"
          >
            {{ t('platform.admins.remove') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class PlatformAdmins {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly selfId = this.auth.profile()?.id ?? '';
  protected readonly admins = signal<PlatformAdminView[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly assignOpen = signal(false);
  protected readonly assigning = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly newDiscordId = signal('');
  protected readonly pendingRemoval = signal<PlatformAdminView | null>(null);

  /** Discord IDs are digits only; the native pattern enforces it, this message says why. */
  protected readonly idError = computed(() => {
    const value = this.newDiscordId();
    return value !== '' && !/^[0-9]+$/.test(value) ? this.t('platform.admins.idInvalid') : null;
  });

  protected readonly columns = computed<readonly DataTableColumn<PlatformAdminView>[]>(() => [
    {
      key: 'discord_id',
      label: 'platform.admins.discordId',
      searchable: true,
      accessor: (row) => row.discord_id,
    },
    {
      key: 'role_name',
      label: 'platform.admins.role',
      searchable: true,
      accessor: (row) => row.role_name,
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly removeMenuItems = computed<readonly MenuItem[]>(() => [
    { id: 'remove', label: this.t('platform.admins.remove'), danger: true },
  ]);

  protected readonly selfMenuItems = computed<readonly MenuItem[]>(() => [
    { id: 'remove', label: this.t('platform.admins.remove'), danger: true, disabled: true },
  ]);

  protected readonly trackById = (row: PlatformAdminView) => row.discord_id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected onDiscordId(event: Event): void {
    this.newDiscordId.set((event.target as HTMLInputElement).value);
  }

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const rows = await firstValueFrom(this.api.get<PlatformAdminView[]>('api/platform/admins'));
      this.admins.set(rows);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected openAssign(): void {
    this.newDiscordId.set('');
    this.assignOpen.set(true);
  }

  protected closeAssign(): void {
    this.assignOpen.set(false);
  }

  protected onRowMenu(row: PlatformAdminView, itemId: string): void {
    if (itemId !== 'remove' || row.discord_id === this.selfId) {
      return;
    }
    this.pendingRemoval.set(row);
  }

  protected async onAssign(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const discordId = this.newDiscordId().trim();
    if (!discordId || this.idError()) {
      return;
    }
    this.assigning.set(true);
    try {
      const view = await firstValueFrom(
        this.api.post<PlatformAdminView>('api/platform/admins', { discord_id: discordId }),
      );
      this.admins.update((list) => {
        if (list.some((row) => row.discord_id === view.discord_id)) {
          return list;
        }
        return [...list, view];
      });
      this.newDiscordId.set('');
      this.assignOpen.set(false);
      this.toasts.success(this.t('platform.admins.assigned'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.assigning.set(false);
    }
  }

  protected async confirmRemove(row: PlatformAdminView): Promise<void> {
    if (row.discord_id === this.selfId) {
      this.toasts.error(this.t('platform.admins.self'));
      this.pendingRemoval.set(null);
      return;
    }
    this.busyId.set(row.discord_id);
    try {
      await firstValueFrom(this.api.delete(`api/platform/admins/${row.discord_id}`));
      this.admins.update((list) => list.filter((item) => item.discord_id !== row.discord_id));
      this.pendingRemoval.set(null);
      this.toasts.success(this.t('platform.admins.revoked'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }
}
