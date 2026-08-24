import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { DatePipe, JsonPipe } from '@angular/common';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';

export interface AuditLog {
  id: number;
  action: string;
  entity_type?: string;
  entity_id?: number;
  user_id?: number;
  details?: any;
  created_at: string;
}

const ROSTER_LOAD_LIMIT = 500;

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
      [trackBy]="trackById"
      [pageSize]="20"
      emptyIcon="activity"
    >
      <ng-template dataTableCell="action" let-row>
        <span style="font-weight: 500">{{ row.action }}</span>
      </ng-template>
      <ng-template dataTableCell="entity" let-row>
        @if (row.entity_type) {
          <span class="chip" style="font-size: 0.8rem; padding: 2px 6px;"
            >{{ row.entity_type }} #{{ row.entity_id }}</span
          >
        } @else {
          <span style="color: var(--color-text-secondary); font-size: 0.8rem;">-</span>
        }
      </ng-template>
      <ng-template dataTableCell="user" let-row>
        @if (row.user_id) {
          <span class="chip chip--info" style="font-size: 0.8rem; padding: 2px 6px;"
            >User #{{ row.user_id }}</span
          >
        } @else {
          <span style="color: var(--color-text-secondary); font-size: 0.8rem;">System</span>
        }
      </ng-template>
      <ng-template dataTableCell="details" let-row>
        @if (row.details) {
          <pre
            style="margin: 0; font-size: 0.75rem; color: var(--color-text-secondary); max-width: 300px; overflow-x: auto; white-space: pre-wrap;"
            >{{ row.details | json }}</pre>
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
  protected readonly loading = signal(false);
  protected readonly trackById = (log: AuditLog): unknown => log.id;

  protected readonly columns: readonly DataTableColumn<AuditLog>[] = [
    {
      key: 'created_at',
      label: 'audit.date',
      sortable: true,
      accessor: (log) => log.created_at,
      comparator: (a, b) => b.created_at.localeCompare(a.created_at),
    },
    {
      key: 'action',
      label: 'audit.action',
      sortable: true,
      searchable: true,
      accessor: (log) => log.action,
      comparator: (a, b) => a.action.localeCompare(b.action),
    },
    {
      key: 'entity',
      label: 'audit.entity',
      sortable: true,
      searchable: true,
      accessor: (log) => log.entity_type || '',
      comparator: (a, b) => (a.entity_type || '').localeCompare(b.entity_type || ''),
    },
    {
      key: 'user',
      label: 'audit.user',
      sortable: true,
      searchable: true,
      accessor: (log) => String(log.user_id || ''),
      comparator: (a, b) => (a.user_id || 0) - (b.user_id || 0),
    },
    {
      key: 'details',
      label: 'audit.details',
      sortable: false,
      searchable: true,
      accessor: (log) => (log.details ? JSON.stringify(log.details) : ''),
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(
        this.api.get<{ items: AuditLog[]; total_items: number }>('api/audit', {
          page: 1,
          limit: ROSTER_LOAD_LIMIT,
        }),
      );
      // Backend already returns sorted by desc, but data table allows resort.
      this.logs.set(data.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
