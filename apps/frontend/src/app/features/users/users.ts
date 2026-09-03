import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PaginatedData, Role, UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';

import { TooltipDirective } from '../../shared/directives/tooltip.directive';

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
  imports: [Avatar, PageHeader, PageStack, DataTable, DataTableCell, Icon, TooltipDirective],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .role-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.2rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .role-pill--superadmin {
      background: var(--color-error-container);
      color: var(--color-error);
      border: 1px solid color-mix(in srgb, var(--color-error) 30%, transparent);
    }
    .role-pill--admin {
      background: var(--color-error-container);
      color: var(--color-error);
      border: 1px solid color-mix(in srgb, var(--color-error) 30%, transparent);
    }
    .role-pill--officer {
      background: var(--color-warning-container);
      color: var(--color-warning);
      border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
    }
    .role-pill--member {
      background: var(--color-success-container);
      color: var(--color-success);
      border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
    }
  `,
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Members summary">
        <!-- Card 1: Total -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('users.stat.total') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-[var(--color-text)] mt-1">
                {{ totalItems() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                {{ t('common.totalResults') }}
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-primary-container)] text-[var(--color-info)] border border-[var(--color-border)]">
              <app-icon name="users" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 2: Admins -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('users.stat.admins') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-error mt-1">
                {{ adminCount() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                System administrators
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-error-container)] text-error border border-[var(--color-border)]">
              <app-icon name="shield" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 3: Officers -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('users.stat.officers') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-warning mt-1">
                {{ officerCount() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                Guild officers
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-border)]">
              <app-icon name="sparkles" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 4: Members -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('users.stat.members') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-success mt-1">
                {{ memberCount() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                Active roster members
              </p>
            </div>
            <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-border)]">
              <app-icon name="users" size="1.25rem" />
            </div>
          </div>
        </article>
      </section>

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
          <div class="flex items-center gap-2.5">
            <app-avatar [userId]="row.id" [username]="row.username" size="sm" />
            <span class="font-medium text-[var(--color-text)] hover:underline cursor-pointer">{{ row.username }}</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="email" let-row>
          <span class="text-xs text-[var(--color-text-secondary)] font-mono">{{ row.email }}</span>
        </ng-template>

        <ng-template dataTableCell="role" let-row>
          @switch (row.role) {
            @case ('SuperAdmin') {
              <span class="role-pill role-pill--superadmin">
                <app-icon name="sparkles" size="0.75rem" />
                {{ row.role }}
              </span>
            }
            @case ('Admin') {
              <span class="role-pill role-pill--admin">
                <app-icon name="shield" size="0.75rem" />
                {{ row.role }}
              </span>
            }
            @case ('Officer') {
              <span class="role-pill role-pill--officer">
                <app-icon name="sparkles" size="0.75rem" />
                {{ row.role }}
              </span>
            }
            @default {
              <span class="role-pill role-pill--member">
                <app-icon name="users" size="0.75rem" />
                {{ row.role }}
              </span>
            }
          }
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

  protected readonly adminCount = computed(
    () => this.users().filter((u) => u.role === 'SuperAdmin' || u.role === 'Admin').length,
  );
  protected readonly officerCount = computed(
    () => this.users().filter((u) => u.role === 'Officer').length,
  );
  protected readonly memberCount = computed(
    () => this.users().filter((u) => u.role === 'Member').length,
  );

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

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
