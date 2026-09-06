import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Control-plane tenant list: register, suspend, and resume Discord guilds.
 */
@Component({
  selector: 'app-platform-tenants',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, Icon, PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header [title]="t('platform.tenants.title')" [subtitle]="t('platform.tenants.subtitle')">
      <button
        type="button"
        class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
        (click)="createOpen.set(true)"
      >
        <app-icon name="plus" size="0.875rem" />
        {{ t('platform.tenants.create') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <app-data-table
        [columns]="columns()"
        [rows]="tenants()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [emptyLabel]="'platform.tenants.empty'"
        emptyIcon="users"
        [pageSize]="25"
      >
        <ng-template dataTableCell="name" let-row>
          <a
            class="font-medium text-(--color-text) no-underline hover:underline"
            [routerLink]="['/platform/tenants', row.id]"
          >
            {{ row.name }}
          </a>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <span class="chip">{{ statusLabel(row.status) }}</span>
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end gap-2">
            @if (row.status === 'active') {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="busyId() === row.id"
                (click)="setStatus(row, 'suspended')"
              >
                {{ t('platform.tenants.suspend') }}
              </button>
            } @else if (row.status === 'suspended') {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="busyId() === row.id"
                (click)="setStatus(row, 'active')"
              >
                {{ t('platform.tenants.resume') }}
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog
        [title]="t('platform.tenants.createTitle')"
        [subtitle]="t('platform.tenants.createHint')"
        size="sm"
        (closed)="createOpen.set(false)"
      >
        <form id="create-tenant-form" class="grid gap-4" (submit)="onCreate($event)">
          <label class="block" for="tenant-id">
            <span class="label">{{ t('platform.tenants.id') }}</span>
            <input
              id="tenant-id"
              class="input"
              name="id"
              type="text"
              inputmode="numeric"
              pattern="[0-9]+"
              required
              autocomplete="off"
              [value]="newId()"
              (input)="onText(newId, $event)"
            />
          </label>
          <label class="block" for="tenant-name">
            <span class="label">{{ t('platform.tenants.name') }}</span>
            <input
              id="tenant-name"
              class="input"
              name="name"
              type="text"
              required
              autocomplete="off"
              [value]="newName()"
              (input)="onText(newName, $event)"
            />
          </label>
          <label class="block" for="tenant-slug">
            <span class="label">{{ t('platform.tenants.slug') }} ({{ t('common.optional') }})</span>
            <input
              id="tenant-slug"
              class="input"
              name="slug"
              type="text"
              autocomplete="off"
              [value]="newSlug()"
              (input)="onText(newSlug, $event)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="createOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-tenant-form"
            [disabled]="creating()"
          >
            {{ creating() ? t('common.loading') : t('platform.tenants.create') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class PlatformTenants {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tenants = signal<PlatformTenant[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly newId = signal('');
  protected readonly newName = signal('');
  protected readonly newSlug = signal('');

  protected readonly columns = computed<readonly DataTableColumn<PlatformTenant>[]>(() => [
    { key: 'name', label: 'platform.tenants.name', searchable: true, accessor: (row) => row.name },
    { key: 'id', label: 'platform.tenants.id', searchable: true, accessor: (row) => row.id },
    { key: 'status', label: 'platform.tenants.status' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly trackById = (row: PlatformTenant) => row.id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  constructor() {
    void this.load();
  }

  protected statusLabel(status: string): string {
    if (status === 'active') {
      return this.t('platform.tenants.status.active');
    }
    if (status === 'suspended') {
      return this.t('platform.tenants.status.suspended');
    }
    if (status === 'provisioning') {
      return this.t('platform.tenants.status.provisioning');
    }
    return status;
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const rows = await firstValueFrom(this.api.get<PlatformTenant[]>('api/platform/tenants'));
      this.tenants.set(rows);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async setStatus(row: PlatformTenant, status: 'active' | 'suspended'): Promise<void> {
    this.busyId.set(row.id);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${row.id}`, { status }),
      );
      this.tenants.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async onCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = this.newId().trim();
    const name = this.newName().trim();
    const slug = this.newSlug().trim();
    if (!id || !name) {
      return;
    }
    this.creating.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<PlatformTenant>('api/platform/tenants', {
          id,
          name,
          slug: slug || undefined,
        }),
      );
      this.tenants.update((list) => [...list, created]);
      this.createOpen.set(false);
      this.newId.set('');
      this.newName.set('');
      this.newSlug.set('');
      this.toasts.success(this.t('platform.tenants.createdToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }
}
