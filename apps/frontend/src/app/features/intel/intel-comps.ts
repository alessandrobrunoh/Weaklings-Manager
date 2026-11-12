import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntelComps, IntelCompUsage, IntelOpponentRecord } from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { IntelFormat } from './intel-format';
import { IntelPeriod, IntelPeriodState } from './intel-period';

/**
 * Intel comps: the comps the guild fielded in the period and how each one did.
 *
 * A fight counts for a comp through the event it was fought in, so fights outside any event
 * are reported as unattributed rather than guessed at. Selecting a row lists that comp's record
 * against each opponent; the comp's own page is one link away.
 */
@Component({
  selector: 'app-intel-comps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, IntelPeriod, PageStack, RouterLink],
  template: `
    <app-page-stack>
      <app-intel-period />
      <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.co.hint') }}</p>
      @if (unattributedText(); as text) {
        <p class="text-xs" role="note" style="color: var(--color-text-secondary)">{{ text }}</p>
      }

      <app-data-table
        [columns]="columns()"
        [rows]="rows()"
        [loading]="loading()"
        [error]="failed()"
        (retry)="reload()"
        [trackBy]="trackComp"
        [pageSize]="25"
        emptyIcon="package"
        [emptyLabel]="'intel.co.empty'"
        [rowClickable]="true"
        (rowClick)="select($event)"
      >
        <ng-template dataTableCell="name" let-row>
          <a
            class="font-medium no-underline hover:underline"
            style="color: var(--color-text)"
            [routerLink]="['/comps', row.comp_id]"
            (click)="$event.stopPropagation()"
          >
            {{ row.name }}
          </a>
        </ng-template>
        <ng-template dataTableCell="events" let-row>
          <span class="mono">{{ fmt.int(row.events) }}</span>
        </ng-template>
        <ng-template dataTableCell="fights" let-row>
          <span class="mono">{{ fmt.int(row.totals.fights) }}</span>
        </ng-template>
        <ng-template dataTableCell="record" let-row>
          <span class="mono whitespace-nowrap">{{ row.totals.wins }} / {{ row.totals.losses }} / {{ row.totals.draws }}</span>
        </ng-template>
        <ng-template dataTableCell="win_rate" let-row>
          <span class="mono">{{ fmt.pct(row.totals.win_rate) }}</span>
        </ng-template>
        <ng-template dataTableCell="kd" let-row>
          <span class="mono">{{ fmt.ratio(row.totals.kd_ratio) }}</span>
        </ng-template>
        <ng-template dataTableCell="kill_fame" let-row>
          <span class="mono">{{ fmt.compact(row.totals.kill_fame) }}</span>
        </ng-template>
        <ng-template dataTableCell="best" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ matchupLabel(row.best_matchup) }}</span>
        </ng-template>
        <ng-template dataTableCell="worst" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ matchupLabel(row.worst_matchup) }}</span>
        </ng-template>
        <ng-template dataTableCell="last_used" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ fmt.date(row.last_used_at) }}</span>
        </ng-template>
      </app-data-table>

      @if (selected(); as comp) {
        <section class="card p-4" aria-labelledby="intel-co-matchups">
          <h2 class="eyebrow" id="intel-co-matchups">{{ t('intel.co.matchups') }}: {{ comp.name }}</h2>
          @if (comp.matchups.length === 0) {
            <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.ov.noOpponents') }}</p>
          } @else {
            <div class="mt-2 overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">{{ t('intel.col.opponent') }}</th>
                    <th scope="col" class="text-right">{{ t('intel.fights') }}</th>
                    <th scope="col" class="text-right">{{ t('intel.col.record') }}</th>
                    <th scope="col" class="text-right">{{ t('intel.winRate') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of comp.matchups; track row.opponent) {
                    <tr>
                      <td>{{ row.opponent }}</td>
                      <td class="mono text-right">{{ fmt.int(row.fights) }}</td>
                      <td class="mono whitespace-nowrap text-right">{{ row.wins }} / {{ row.losses }} / {{ row.draws }}</td>
                      <td class="mono text-right">{{ fmt.pct(row.win_rate) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </app-page-stack>
  `,
})
export class IntelCompsPage {
  private readonly intel = inject(IntelService);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);
  protected readonly period = inject(IntelPeriodState);

  protected readonly data = signal<IntelComps | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private readonly selectedId = signal<number | null>(null);
  private requestId = 0;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly rows = computed<IntelCompUsage[]>(() =>
    [...(this.data()?.comps ?? [])].sort((a, b) => b.totals.fights - a.totals.fights),
  );

  protected readonly selected = computed(
    () => this.rows().find((comp) => comp.comp_id === this.selectedId()) ?? null,
  );

  protected readonly unattributedText = computed(() => {
    const d = this.data();
    return d && d.unattributed_fights > 0
      ? this.t('intel.co.unattributed', { n: d.unattributed_fights, total: d.total_fights })
      : '';
  });

  protected readonly columns = computed<readonly DataTableColumn<IntelCompUsage>[]>(() => [
    { key: 'name', label: 'intel.col.comp', searchable: true, sortable: true, accessor: (r) => r.name },
    { key: 'events', label: 'intel.events', sortable: true, accessor: (r) => r.events, align: 'right' },
    { key: 'fights', label: 'intel.fights', sortable: true, accessor: (r) => r.totals.fights, align: 'right' },
    { key: 'record', label: 'intel.col.record', accessor: (r) => r.totals.wins - r.totals.losses, align: 'right' },
    { key: 'win_rate', label: 'intel.winRate', sortable: true, accessor: (r) => r.totals.win_rate ?? -1, align: 'right' },
    { key: 'kd', label: 'intel.kd', sortable: true, accessor: (r) => r.totals.kd_ratio ?? -1, align: 'right' },
    { key: 'kill_fame', label: 'intel.killFame', sortable: true, accessor: (r) => r.totals.kill_fame, align: 'right' },
    { key: 'best', label: 'intel.co.bestMatchup', accessor: (r) => r.best_matchup?.opponent },
    { key: 'worst', label: 'intel.co.worstMatchup', accessor: (r) => r.worst_matchup?.opponent },
    { key: 'last_used', label: 'intel.col.lastUsed', sortable: true, accessor: (r) => r.last_used_at },
  ]);

  protected readonly trackComp = (row: IntelCompUsage): unknown => row.comp_id;

  constructor() {
    effect(() => {
      const query = this.period.query();
      untracked(() => void this.load(query));
    });
  }

  protected reload(): void {
    void this.load(this.period.query());
  }

  protected select(row: IntelCompUsage): void {
    this.selectedId.set(this.selectedId() === row.comp_id ? null : row.comp_id);
  }

  protected matchupLabel(record: IntelOpponentRecord | null): string {
    return record ? `${record.opponent} (${record.wins}-${record.losses})` : '—';
  }

  private async load(query: ReturnType<IntelPeriodState['query']>): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const comps = await firstValueFrom(this.intel.comps(query));
      if (id === this.requestId) {
        this.data.set(comps);
      }
    } catch {
      if (id === this.requestId) {
        this.failed.set(true);
        this.data.set(null);
      }
    } finally {
      if (id === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
