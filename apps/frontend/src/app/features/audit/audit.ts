import { DatePipe, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PaginatedData } from '../../core/models/api.models';
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

export interface AuditLog {
  id: number;
  action: string;
  entity_type?: string;
  entity_id?: number;
  user_id?: number;
  details?: unknown;
  created_at: string;
}

const ACTION_FILTERS = [
  'WITHDRAW_REQUESTED',
  'WITHDRAW_ACCEPTED',
  'WITHDRAW_REJECTED',
  'TRANSACTION_CREATED',
  'EVENT_CREATED',
  'REGEAR_REQUESTED',
  'REGEAR_ACCEPTED',
  'REGEAR_REJECTED',
  'REGEAR_EXTRACTED',
  'REGEAR_SETTINGS_SET',
  'WARN_ISSUE',
  'WARN_REVOKE',
  'WARN_ESCALATION_ACK',
  'WARN_ESCALATION_OPEN',
  'PROGRESSION_SETTINGS_SET',
  'PROGRESSION_SEASON_CREATE',
  'PROGRESSION_SEASON_UPDATE',
  'PROGRESSION_SEASON_ACTIVATE',
  'PROGRESSION_ADJUST',
  'GUILD_SETTINGS_SET',
  'AUTOROLE_SET',
  'ROLE_CREATE',
  'ROLE_UPDATE',
  'ROLE_DELETE',
] as const;

const ENTITY_FILTERS = [
  'TRANSACTION',
  'EVENT',
  'REGEAR_DEATH',
  'REGEAR_SETTINGS',
  'PROGRESSION_SETTINGS',
  'PROGRESSION_SEASON',
  'PROGRESSION_ACCOUNT',
  'USER_WARN',
  'WARN_ESCALATION',
  'GUILD_SETTINGS',
  'ROLE',
] as const;

function emptyPageChange(): DataTablePageChange {
  return { page: 1, pageSize: 20, search: '', sort: null, columnFilters: {} };
}

@Component({
  selector: 'app-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, DataTable, DataTableCell, DatePipe, JsonPipe],
  template: `
    <app-page-header
      [title]="t('audit.title')"
      [subtitle]="t('audit.subtitle')"
      [actions]="false"
    />

    <app-data-table
      [columns]="columns"
      [rows]="logs()"
      [loading]="loading()"
      [error]="loadFailed()"
      (retry)="load()"
      [trackBy]="trackById"
      [serverMode]="true"
      [totalItems]="totalItems()"
      [pageSize]="20"
      emptyIcon="activity"
      (pageChange)="onTableChange($event)"
    >
      <ng-template dataTableCell="action" let-row>
        <span style="font-weight: 500">{{ row.action }}</span>
      </ng-template>
      <ng-template dataTableCell="entity" let-row>
        @if (row.entity_type) {
          <span class="chip" style="font-size: 0.8rem; padding: 2px 6px"
            >{{ row.entity_type }} #{{ row.entity_id }}</span
          >
        } @else {
          <span style="color: var(--color-text-secondary); font-size: 0.8rem;">-</span>
        }
      </ng-template>
      <ng-template dataTableCell="user" let-row>
        @if (row.user_id) {
          <span class="chip chip--info" style="font-size: 0.8rem; padding: 2px 6px"
            >User #{{ row.user_id }}</span
          >
        } @else {
          <span style="color: var(--color-text-secondary); font-size: 0.8rem;">{{
            t('audit.system')
          }}</span>
        }
      </ng-template>
      <ng-template dataTableCell="details" let-row>
        @if (row.details) {
          <pre
            style="margin: 0; font-size: 0.75rem; color: var(--color-text-secondary); max-width: 300px; overflow-x: auto; white-space: pre-wrap;"
            >{{ row.details | json }}</pre
          >
        }
      </ng-template>
      <ng-template dataTableCell="created_at" let-row>
        <span style="color: var(--color-text-secondary); font-size: 0.85rem;">{{
          row.created_at | date: 'short'
        }}</span>
      </ng-template>
    </app-data-table>
  `,
})
export class Audit {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly logs = signal<AuditLog[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly trackById = (log: AuditLog): unknown => log.id;

  private readonly tableQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly columns: readonly DataTableColumn<AuditLog>[] = [
    {
      key: 'created_at',
      label: 'audit.date',
      sortable: true,
      accessor: (log) => log.created_at,
    },
    {
      key: 'action',
      label: 'audit.action',
      sortable: true,
      searchable: true,
      accessor: (log) => log.action,
      filterOptions: ACTION_FILTERS.map((value) => ({ value, label: value })),
    },
    {
      key: 'entity',
      label: 'audit.entity',
      sortable: true,
      accessor: (log) => log.entity_type || '',
      filterOptions: ENTITY_FILTERS.map((value) => ({ value, label: value })),
    },
    {
      key: 'user',
      label: 'audit.user',
      sortable: true,
      accessor: (log) => String(log.user_id || ''),
    },
    {
      key: 'details',
      label: 'audit.details',
      sortable: false,
      accessor: (log) => (log.details ? JSON.stringify(log.details) : ''),
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(this.logs().length === 0);
    this.loadFailed.set(false);
    try {
      const query = this.tableQuery();
      const params: Record<string, string | number | boolean> = {
        page: query.page,
        limit: query.pageSize,
      };
      if (query.search.trim()) {
        params['search'] = query.search.trim();
      }
      if (query.sort) {
        const sortKey =
          query.sort.columnKey === 'entity'
            ? 'entity_type'
            : query.sort.columnKey === 'user'
              ? 'user_id'
              : query.sort.columnKey;
        params['sort'] = sortKey;
        params['order'] = query.sort.direction;
      }
      const action = query.columnFilters['action'];
      if (action) {
        params['action'] = action;
      }
      const entityType = query.columnFilters['entity'];
      if (entityType) {
        params['entity_type'] = entityType;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<AuditLog>>('api/audit', params),
      );
      this.logs.set(data.items);
      this.totalItems.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
