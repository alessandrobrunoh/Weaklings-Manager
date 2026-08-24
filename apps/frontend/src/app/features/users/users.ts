import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { Role, UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';

/** Page size requested when bulk-loading the roster for client-side filtering. */
const ROSTER_LOAD_LIMIT = 1000;

/**
 * Guild member directory.
 *
 * Drives the participant picker used elsewhere (splits, events), but exposed
 * here as a browsable list. Loads the whole roster once and delegates search,
 * sort, filter and pagination to `DataTable`, keeping round-trips off the
 * critical path for the common typing-in-the-search-box interaction.
 */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, DataTable],
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
      [actions]="false"
    />

    <app-data-table
      [columns]="columns"
      [rows]="users()"
      [loading]="loading()"
      [error]="loadFailed()"
      (retry)="load()"
      [trackBy]="trackById"
      [pageSize]="10"
      emptyIcon="users"
    >
      <ng-template dataTableCell="username" let-row>
        <span style="font-weight: 500">{{ row.username }}</span>
      </ng-template>
      <ng-template dataTableCell="email" let-row>
        <span style="color: var(--color-text-secondary)">{{ row.email }}</span>
      </ng-template>
      <ng-template dataTableCell="role" let-row>
        <span class="chip" [class]="roleChip(row.role)">{{ row.role }}</span>
      </ng-template>
    </app-data-table>
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly users = signal<UserProfile[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly trackById = (user: UserProfile): unknown => user.id;

  protected readonly columns: readonly DataTableColumn<UserProfile>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      searchable: true,
      accessor: (user) => user.username,
      comparator: (a, b) => a.username.localeCompare(b.username),
    },
    {
      key: 'email',
      label: 'common.email',
      sortable: true,
      searchable: true,
      accessor: (user) => user.email,
      comparator: (a, b) => a.email.localeCompare(b.email),
    },
    {
      key: 'role',
      label: 'common.role',
      sortable: true,
      accessor: (user) => user.role,
      comparator: (a, b) => a.role.localeCompare(b.role),
      filterOptions: [
        { value: 'SuperAdmin', label: 'SuperAdmin' },
        { value: 'Admin', label: 'Admin' },
        { value: 'Officer', label: 'Officer' },
        { value: 'Member', label: 'Member' },
      ],
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected roleChip(role: Role): string {
    if (role === 'SuperAdmin') {
      return 'chip chip--error';
    }
    if (role === 'Admin') {
      return 'chip chip--warning';
    }
    if (role === 'Officer') {
      return 'chip chip--success';
    }
    return 'chip';
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.api.get<{ items: UserProfile[]; total_items: number }>('api/users', {
          page: 1,
          limit: ROSTER_LOAD_LIMIT,
        }),
      );
      this.users.set(data.items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
