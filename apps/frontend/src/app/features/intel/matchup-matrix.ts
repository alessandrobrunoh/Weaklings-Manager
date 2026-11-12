import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { MatchupReport, MatchupRow } from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { IntelFormat } from './intel-format';

/**
 * Our comps against scouted enemy compositions: every pairing we have actually fought.
 *
 * Names for the scouted side come from the scout library, so a pairing whose scout is outside
 * the first library page falls back to its id rather than hiding the row.
 */
@Component({
  selector: 'app-matchup-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, RouterLink],
  template: `
    <p class="mb-2 text-xs" style="color: var(--color-text-secondary)">{{ coverageText() }}</p>
    <app-data-table
      [columns]="columns()"
      [rows]="rows()"
      [loading]="loading()"
      [error]="failed()"
      (retry)="load()"
      [trackBy]="trackRow"
      [pageSize]="25"
      emptyIcon="swords"
      [emptyLabel]="'intel.noMatchups'"
    >
      <ng-template dataTableCell="our_comp" let-row>
        <a class="font-medium no-underline hover:underline" style="color: var(--color-text)" [routerLink]="['/comps', row.our_comp_id]">
          {{ row.our_comp_name }}
        </a>
      </ng-template>
      <ng-template dataTableCell="enemy" let-row>
        <a
          class="text-sm no-underline hover:underline"
          style="color: var(--color-text-secondary)"
          [routerLink]="['/intel/opponents/scouts', row.scouted_comp_id]"
        >
          {{ scoutName(row.scouted_comp_id) }}
        </a>
      </ng-template>
      <ng-template dataTableCell="fights" let-row>
        <span class="mono">{{ row.wins + row.losses }}</span>
      </ng-template>
      <ng-template dataTableCell="record" let-row>
        <span class="mono">{{ row.wins }} / {{ row.losses }}</span>
      </ng-template>
      <ng-template dataTableCell="win_rate" let-row>
        <span class="mono">{{ fmt.pct(winRate(row)) }}</span>
      </ng-template>
    </app-data-table>
  `,
})
export class MatchupMatrix {
  private readonly intel = inject(IntelService);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);

  protected readonly report = signal<MatchupReport | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private readonly names = signal<Readonly<Record<number, string>>>({});

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly rows = computed<MatchupRow[]>(() => this.report()?.rows ?? []);

  protected readonly columns = computed<readonly DataTableColumn<MatchupRow>[]>(() => [
    { key: 'our_comp', label: 'intel.ourComp', searchable: true, accessor: (r) => r.our_comp_name },
    { key: 'enemy', label: 'intel.enemy', searchable: true, accessor: (r) => this.scoutName(r.scouted_comp_id) },
    { key: 'fights', label: 'intel.fights', sortable: true, accessor: (r) => r.wins + r.losses, align: 'right' },
    { key: 'record', label: 'intel.record', accessor: (r) => r.wins - r.losses, align: 'right' },
    { key: 'win_rate', label: 'intel.winRate', sortable: true, accessor: (r) => this.winRate(r) ?? -1, align: 'right' },
  ]);

  protected readonly coverageText = computed(() => {
    const coverage = this.report()?.coverage;
    if (!coverage || coverage.total_battles === 0) {
      return this.t('intel.coverageNoteHint');
    }
    const pct = this.fmt.pct((coverage.battles_with_comp / coverage.total_battles) * 100);
    return this.translate.t('intel.opponents.coverage', {
      with: coverage.battles_with_comp,
      total: coverage.total_battles,
      pct,
    });
  });

  protected readonly trackRow = (row: MatchupRow): unknown => `${row.our_comp_id}:${row.scouted_comp_id}`;

  constructor() {
    void this.load();
  }

  protected scoutName(id: number): string {
    return this.names()[id] ?? `#${id}`;
  }

  /** Wins over decided fights; null when the pairing has none. */
  protected winRate(row: MatchupRow): number | null {
    const decided = row.wins + row.losses;
    return decided > 0 ? (row.wins / decided) * 100 : null;
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const [report, scouts] = await Promise.all([
        firstValueFrom(this.intel.matchups()),
        firstValueFrom(this.intel.listScouts({ limit: 100, sort: 'threat', page: 1 })).catch(() => null),
      ]);
      this.report.set(report);
      const names: Record<number, string> = {};
      for (const scout of scouts?.items ?? []) {
        names[scout.id] = scout.name;
      }
      this.names.set(names);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
