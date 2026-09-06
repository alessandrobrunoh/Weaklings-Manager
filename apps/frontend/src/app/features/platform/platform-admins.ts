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
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Assign and revoke control-plane SuperAdmin.
 */
@Component({
  selector: 'app-platform-admins',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, PageHeader, PageStack],
  template: `
    <app-page-header [title]="t('platform.admins.title')" [subtitle]="t('platform.admins.subtitle')" />

    <app-page-stack>
      <form class="card p-4 flex flex-wrap items-end gap-3" (submit)="onAssign($event)">
        <label class="block min-w-[16rem] flex-1" for="assign-discord-id">
          <span class="label">{{ t('platform.admins.discordId') }}</span>
          <input
            id="assign-discord-id"
            class="input"
            name="discord_id"
            type="text"
            inputmode="numeric"
            pattern="[0-9]+"
            required
            autocomplete="off"
            [value]="newDiscordId()"
            (input)="onDiscordId($event)"
          />
        </label>
        <button type="submit" class="btn btn--primary" [disabled]="assigning()">
          {{ assigning() ? t('common.loading') : t('platform.admins.assign') }}
        </button>
      </form>

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
      >
        <ng-template dataTableCell="actions" let-row>
          <div class="flex justify-end">
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="busyId() === row.discord_id || row.discord_id === selfId"
              (click)="revoke(row)"
            >
              {{ t('platform.admins.revoke') }}
            </button>
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>
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
  protected readonly assigning = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly newDiscordId = signal('');

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

  protected readonly trackById = (row: PlatformAdminView) => row.discord_id;

  protected t = (key: TranslationKey) => this.translate.t(key);

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

  protected async onAssign(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const discordId = this.newDiscordId().trim();
    if (!discordId) {
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
      this.toasts.success(this.t('platform.admins.assigned'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.assigning.set(false);
    }
  }

  protected async revoke(row: PlatformAdminView): Promise<void> {
    if (row.discord_id === this.selfId) {
      this.toasts.error(this.t('platform.admins.self'));
      return;
    }
    this.busyId.set(row.discord_id);
    try {
      await firstValueFrom(this.api.delete(`api/platform/admins/${row.discord_id}`));
      this.admins.update((list) => list.filter((item) => item.discord_id !== row.discord_id));
      this.toasts.success(this.t('platform.admins.revoked'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }
}
