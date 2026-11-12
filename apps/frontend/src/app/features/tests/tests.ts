import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateScenarioRequest,
  ScenarioDetail,
  ScenarioSummary,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type ViewFilter = 'active' | 'archived';

/**
 * Saved combat test scenarios: abstract unit groups and a declared cast timeline, run through the
 * same no-geometry engine as `POST /api/combat/simulate`. See `combat::scenario`'s docs on the
 * backend for exactly what is exact and what a caller must declare.
 */
@Component({
  selector: 'app-tests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, PageStack, FilterBar, Tabs, DataTable, DataTableCell, Dialog, Icon, StatusChip],
  styles: [`
    :host { display: block; color: var(--color-text); }
    :host ::ng-deep .rounded-xl, :host ::ng-deep .rounded-2xl,
    :host ::ng-deep .rounded-lg, :host ::ng-deep .rounded-md,
    :host ::ng-deep .shadow-lg, :host ::ng-deep .shadow-xl {
      border-radius: var(--radius-cards);
      box-shadow: none;
    }
  `],
  template: `
    <app-page-header [title]="t('tests.title')" [subtitle]="t('tests.subtitle')">
      <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
        <app-icon name="plus" size="0.875rem" />
        {{ t('tests.new') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <app-filter-bar
        [searchLabel]="t('tests.searchLabel')"
        [searchPlaceholder]="t('tests.searchPlaceholder')"
        [query]="query()"
        [activeCount]="query() ? 1 : 0"
        (queryChange)="query.set($event)"
        (clear)="query.set('')"
      >
        <app-tabs
          filterPrimary
          variant="segmented"
          [ariaLabel]="t('tests.statusFilter')"
          [options]="tabOptions()"
          [active]="filter()"
          (activeChange)="switchFilter($event)"
        />
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="visibleScenarios()"
        [loading]="loading()"
        [error]="loadFailed()"
        [hideSearch]="true"
        [trackBy]="trackScenario"
        [rowClickable]="true"
        [ariaLabel]="t('tests.tableLabel')"
        emptyIcon="activity"
        [emptyTitle]="emptyTitle()"
        (rowClick)="openRow($event)"
        (retry)="load()"
      >
        <ng-template dataTableCell="name" let-row>
          <span class="font-medium">{{ row.name }}</span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          <app-status-chip
            [value]="row.archived_at ? 'archived' : 'active'"
            [label]="row.archived_at ? t('tests.archived') : t('tests.statusActive')"
          />
        </ng-template>

        <ng-template dataTableCell="version" let-row>
          <span class="num text-sm">v{{ row.version }}</span>
        </ng-template>

        <ng-template dataTableCell="run_count" let-row>
          <span class="num text-sm">{{ row.run_count }}</span>
        </ng-template>

        <ng-template dataTableCell="created_by_username" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ row.created_by_username }}</span>
        </ng-template>

        <ng-template dataTableCell="updated_at" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ formatDate(row.updated_at) }}</span>
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            (click)="toggleArchive(row); $event.stopPropagation()"
          >
            {{ row.archived_at ? t('tests.unarchive') : t('tests.archive') }}
          </button>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('tests.createTitle')" size="sm" (closed)="closeCreate()">
        <form id="test-create-form" class="grid gap-4" (submit)="onCreateSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              autofocus
              [value]="draftName()"
              (input)="draftName.set($any($event.target).value)"
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
            [attr.form]="'test-create-form'"
            [disabled]="saving() || !draftName().trim()"
          >
            {{ t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Tests {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly filter = signal<ViewFilter>('active');
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly scenarios = signal<ScenarioSummary[]>([]);
  protected readonly createOpen = signal(false);
  protected readonly draftName = signal('');
  protected readonly saving = signal(false);

  protected readonly tabOptions = computed<TabOption[]>(() => [
    { id: 'active', label: this.t('tests.statusActive') },
    { id: 'archived', label: this.t('tests.archived') },
  ]);

  /** Search is client-side over the loaded page of scenarios: name and creator. */
  protected readonly visibleScenarios = computed<ScenarioSummary[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const all = this.scenarios();
    if (!needle) return all;
    return all.filter(
      (scenario) =>
        scenario.name.toLowerCase().includes(needle) ||
        scenario.created_by_username.toLowerCase().includes(needle),
    );
  });

  protected readonly emptyTitle = computed(() => {
    if (this.query().trim()) return this.t('ui.table.noMatches');
    return this.t(this.filter() === 'archived' ? 'tests.emptyArchived' : 'tests.emptyActive');
  });

  protected readonly columns = computed<readonly DataTableColumn<ScenarioSummary>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      accessor: (row) => row.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'status',
      label: 'tests.status',
      sortable: true,
      accessor: (row) => (row.archived_at ? 'archived' : 'active'),
      comparator: (a, b) => Number(!!a.archived_at) - Number(!!b.archived_at),
    },
    {
      key: 'version',
      label: 'tests.version',
      sortable: true,
      accessor: (row) => row.version,
      comparator: (a, b) => a.version - b.version,
      align: 'right',
    },
    {
      key: 'run_count',
      label: 'tests.pastRuns',
      sortable: true,
      accessor: (row) => row.run_count,
      comparator: (a, b) => a.run_count - b.run_count,
      align: 'right',
    },
    {
      key: 'created_by_username',
      label: 'tests.createdBy',
      sortable: true,
      accessor: (row) => row.created_by_username,
      comparator: (a, b) => a.created_by_username.localeCompare(b.created_by_username),
    },
    {
      key: 'updated_at',
      label: 'tests.updated',
      sortable: true,
      accessor: (row) => row.updated_at,
      comparator: (a, b) => a.updated_at.localeCompare(b.updated_at),
    },
    { key: 'actions', label: '' },
  ]);

  protected readonly trackScenario = (scenario: ScenarioSummary): unknown => scenario.id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    this.load();
  }

  protected switchFilter(filter: string): void {
    if (filter !== 'active' && filter !== 'archived') return;
    if (this.filter() === filter) return;
    this.filter.set(filter);
    this.load();
  }

  protected openRow(row: ScenarioSummary): void {
    void this.router.navigate(['/tests', row.id]);
  }

  protected openCreate(): void {
    this.draftName.set('');
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  protected async onCreateSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.draftName().trim();
    if (!name) return;
    this.saving.set(true);
    try {
      const request: CreateScenarioRequest = { name };
      const created = await firstValueFrom(this.api.post<ScenarioDetail>('api/combat/tests', request));
      this.createOpen.set(false);
      void this.router.navigate(['/tests', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async toggleArchive(row: ScenarioSummary): Promise<void> {
    try {
      const action = row.archived_at ? 'unarchive' : 'archive';
      await firstValueFrom(this.api.post(`api/combat/tests/${row.id}/${action}`));
      this.toasts.success(row.archived_at ? this.t('tests.unarchiveSuccess') : this.t('tests.archiveSuccess'));
      this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const includeArchived = this.filter() === 'archived';
      const all = await firstValueFrom(
        this.api.get<ScenarioSummary[]>('api/combat/tests', { include_archived: includeArchived }),
      );
      this.scenarios.set(
        includeArchived ? all.filter((scenario) => scenario.archived_at) : all,
      );
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
