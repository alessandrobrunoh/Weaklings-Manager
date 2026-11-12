import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { ReportEnemyRow, ScoutedCompSummary } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import type { ScoutListParams } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { IntelFormat } from './intel-format';

const SCOUT_PAGE_LIMIT = 25;

/**
 * The scouted enemy compositions: threat score, weapon coverage and, for officers, our record
 * against each one. Server-paged; a row opens the scout's dossier.
 */
@Component({
  selector: 'app-scout-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, StatusChip],
  template: `
    <app-data-table
      [columns]="columns()"
      [rows]="scouts()"
      [loading]="loading()"
      [error]="failed()"
      (retry)="load()"
      [trackBy]="trackScout"
      [pageSize]="SCOUT_PAGE_LIMIT"
      [serverMode]="true"
      [totalItems]="total()"
      emptyIcon="search"
      [emptyLabel]="'intel.empty'"
      [rowClickable]="true"
      (rowClick)="open($event)"
      (pageChange)="onPageChange($event)"
    >
      <ng-template dataTableCell="opponent" let-row>
        <span class="font-medium">{{ row.opponent_guild_name }}</span>
      </ng-template>
      <ng-template dataTableCell="name" let-row>
        <span class="text-sm" style="color: var(--color-text-secondary)">{{ row.name }}</span>
      </ng-template>
      <ng-template dataTableCell="category" let-row>
        <app-status-chip [value]="row.category" />
      </ng-template>
      <ng-template dataTableCell="avg_ip" let-row>
        <span class="mono">{{ fmt.int(row.avg_ip) }}</span>
      </ng-template>
      <ng-template dataTableCell="threat" let-row>
        <span class="mono font-medium">{{ row.threat_score }}</span>
      </ng-template>
      <ng-template dataTableCell="battles" let-row>
        <span class="mono">{{ row.source_battle_count }}</span>
      </ng-template>
      <ng-template dataTableCell="record" let-row>
        @let record = enemyRecord(row.id);
        @if (record) {
          <span class="mono text-sm">{{ record.wins }} / {{ record.losses }}</span>
        } @else {
          <span class="text-sm" style="color: var(--color-text-secondary)">—</span>
        }
      </ng-template>
      <ng-template dataTableCell="saved_at" let-row>
        <span class="text-sm" style="color: var(--color-text-secondary)">{{ fmt.date(row.saved_at) }}</span>
      </ng-template>
      <ng-template dataTableCell="coverage" let-row>
        @if (!row.full_weapon_coverage) {
          <span class="chip chip--warning text-xs" [title]="t('intel.partialCoverageHint')">
            {{ row.weapon_sample_size }}/{{ row.player_count }}
          </span>
        }
      </ng-template>
    </app-data-table>
  `,
})
export class ScoutLibrary {
  private readonly intel = inject(IntelService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);

  protected readonly SCOUT_PAGE_LIMIT = SCOUT_PAGE_LIMIT;
  protected readonly scouts = signal<ScoutedCompSummary[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private readonly records = signal<readonly ReportEnemyRow[]>([]);

  private params: DataTablePageChange = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: SCOUT_PAGE_LIMIT,
    filterKeys: ['category'],
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly columns = computed<readonly DataTableColumn<ScoutedCompSummary>[]>(() => [
    { key: 'opponent', label: 'intel.enemy', searchable: true, accessor: (r) => r.opponent_guild_name },
    { key: 'name', label: 'common.name', searchable: true, accessor: (r) => r.name },
    {
      key: 'category',
      label: 'common.category',
      accessor: (r) => r.category,
      filterOptions: [
        { value: 'gank', label: this.t('intel.category.gank') },
        { value: 'small_scale', label: this.t('intel.category.smallScale') },
        { value: 'zvz', label: this.t('intel.category.zvz') },
      ],
    },
    { key: 'players', label: 'intel.players', accessor: (r) => r.player_count, align: 'right' },
    { key: 'avg_ip', label: 'intel.avgIp', accessor: (r) => r.avg_ip, align: 'right' },
    { key: 'threat', label: 'intel.threat', sortable: true, accessor: (r) => r.threat_score, align: 'right' },
    { key: 'battles', label: 'intel.fights', sortable: true, accessor: (r) => r.source_battle_count, align: 'right' },
    {
      key: 'record',
      label: 'intel.recordVsUs',
      accessor: (r) => {
        const record = this.enemyRecord(r.id);
        return record ? record.wins - record.losses : 0;
      },
      align: 'right',
    },
    { key: 'saved_at', label: 'intel.detail.lastSeen', sortable: true, accessor: (r) => r.saved_at },
    { key: 'coverage', label: '' },
  ]);

  protected readonly trackScout = (scout: ScoutedCompSummary): unknown => scout.id;

  constructor() {
    void this.load();
    void this.loadRecords();
  }

  protected enemyRecord(scoutId: number): ReportEnemyRow | null {
    return this.records().find((row) => row.scouted_comp_id === scoutId) ?? null;
  }

  protected open(scout: ScoutedCompSummary): void {
    void this.router.navigate(['/intel/opponents/scouts', scout.id]);
  }

  protected onPageChange(event: DataTablePageChange): void {
    this.params = event;
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const library = await firstValueFrom(this.intel.listScouts(this.toParams()));
      this.scouts.set(library.items);
      this.total.set(library.total_items);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Our record per scout comes from the officer-only guild report; members just see no record. */
  private async loadRecords(): Promise<void> {
    if (!this.auth.hasPermission('intel.report.view')) {
      return;
    }
    try {
      const report = await firstValueFrom(this.intel.report());
      this.records.set(report.enemies);
    } catch {
      this.records.set([]);
    }
  }

  private toParams(): ScoutListParams {
    const event = this.params;
    const sortKey = event.sort?.columnKey;
    const sort: ScoutListParams['sort'] =
      sortKey === 'saved_at' ? 'saved_at' : sortKey === 'battles' ? 'battles' : 'threat';
    return {
      q: event.search.trim() || undefined,
      category: event.columnFilters['category'] || undefined,
      sort,
      page: event.page,
      limit: event.pageSize,
    };
  }
}
