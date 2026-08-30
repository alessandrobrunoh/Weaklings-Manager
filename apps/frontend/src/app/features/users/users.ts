import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PaginatedData, Role, UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const PAGE_SIZE = 10;

const ROLE_FILTERS: readonly { value: Role; label: string }[] = [
  { value: 'SuperAdmin', label: 'SuperAdmin' },
  { value: 'Admin', label: 'Admin' },
  { value: 'Officer', label: 'Officer' },
  { value: 'Member', label: 'Member' },
];

/**
 * Guild member directory.
 *
 * Server-paged against `GET /api/users`. Search maps to `username`, the role
 * dropdown to `role`, and sortable columns to `sort`/`order`. Row click opens
 * the view-first member page at `/users/:userId`.
 */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, PageStack, DataTable, DataTableCell],
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
      [actions]="false"
    />

    <app-page-stack>
      <app-data-table
        [columns]="columns"
        [rows]="users()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [pageSize]="pageSize"
        [serverMode]="true"
        [totalItems]="totalItems()"
        emptyIcon="users"
        [rowClickable]="true"
        (rowClick)="openMember($event)"
        (pageChange)="onTableChange($event)"
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
    </app-page-stack>
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly users = signal<UserProfile[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly trackById = (user: UserProfile): unknown => user.id;

  private readonly tablePage = signal(1);
  private readonly tablePageSize = signal(PAGE_SIZE);
  private readonly tableSearch = signal('');
  private readonly tableSort = signal<DataTablePageChange['sort']>(null);
  private readonly tableFilters = signal<Readonly<Record<string, string>>>({});

  protected readonly columns: readonly DataTableColumn<UserProfile>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      searchable: true,
      accessor: (user) => user.username,
    },
    {
      key: 'email',
      label: 'common.email',
      accessor: (user) => user.email,
    },
    {
      key: 'role',
      label: 'common.role',
      sortable: true,
      accessor: (user) => user.role,
      filterOptions: ROLE_FILTERS.map((option) => ({ value: option.value, label: option.label })),
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

  protected openMember(row: UserProfile): void {
    void this.router.navigate(['/users', row.id]);
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tablePage.set(event.page);
    this.tablePageSize.set(event.pageSize);
    this.tableSearch.set(event.search);
    this.tableSort.set(event.sort);
    this.tableFilters.set(event.columnFilters);
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const sort = this.tableSort();
      const role = this.tableFilters()['role']?.trim();
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          page: this.tablePage(),
          limit: this.tablePageSize(),
          username: this.tableSearch().trim() || undefined,
          role: role || undefined,
          sort: sort?.columnKey,
          order: sort?.direction,
        }),
      );
      this.users.set(data.items ?? []);
      this.totalItems.set(data.total_items ?? 0);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      this.users.set([]);
      this.totalItems.set(0);
    } finally {
      this.loading.set(false);
    }
  }
}
