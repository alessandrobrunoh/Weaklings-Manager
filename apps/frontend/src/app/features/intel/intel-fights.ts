import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntelFightList, IntelFightRow, IntelFightsQuery } from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { IntelFormat } from './intel-format';
import { IntelPeriod, IntelPeriodState } from './intel-period';
import { OutcomeChip } from './outcome-chip';

const PAGE_LIMIT = 25;

/** Table column key to the API's `sort` value; columns not listed here are not sortable. */
const SORT_KEYS: Record<string, NonNullable<IntelFightsQuery['sort']>> = {
  date: 'started_at',
  players: 'players',
  kills: 'kills',
  deaths: 'deaths',
  kill_fame: 'kill_fame',
  kd: 'kd',
};

const OUTCOMES = ['victory', 'defeat', 'draw', 'unknown'] as const;

/**
 * Intel fights: every fight the guild took part in, filtered and paged on the server.
 *
 * Filters are period, outcome, opponent, comp and fight size. The summary line counts every
 * fight that matches, not just the visible page.
 */
@Component({
  selector: 'app-intel-fights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, IntelPeriod, OutcomeChip, PageStack, RouterLink],
  template: `
    <app-page-stack>
      <app-intel-period />

      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.col.outcome') }}</span>
          <select class="select select--sm" [value]="outcome()" (change)="onOutcome($event)">
            <option value="">{{ t('common.all') }}</option>
            @for (value of outcomes; track value) {
              <option [value]="value" [selected]="outcome() === value">{{ outcomeLabel(value) }}</option>
            }
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.col.opponent') }}</span>
          <select class="select select--sm" [value]="opponent()" (change)="onOpponent($event)">
            <option value="">{{ t('common.all') }}</option>
            @for (name of opponentOptions(); track name) {
              <option [value]="name" [selected]="opponent() === name">{{ name }}</option>
            }
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.col.comp') }}</span>
          <select class="select select--sm" [value]="compId()" (change)="onComp($event)">
            <option value="">{{ t('common.all') }}</option>
            @for (comp of compOptions(); track comp.comp_id) {
              <option [value]="comp.comp_id" [selected]="compId() === '' + comp.comp_id">{{ comp.name }}</option>
            }
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.fi.minPlayers') }}</span>
          <input class="input input--sm w-24" type="number" min="0" inputmode="numeric" [value]="minPlayers()" (change)="onMin($event)" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.fi.maxPlayers') }}</span>
          <input class="input input--sm w-24" type="number" min="0" inputmode="numeric" [value]="maxPlayers()" (change)="onMax($event)" />
        </label>
        @if (filtered()) {
          <button type="button" class="btn btn--outline btn--sm" (click)="resetFilters()">
            {{ t('intel.fi.reset') }}
          </button>
        }
      </div>

      @if (summaryText(); as text) {
        <p class="text-xs" style="color: var(--color-text-secondary)" role="status">{{ text }}</p>
      }

      <app-data-table
        [columns]="columns"
        [rows]="rows()"
        [loading]="loading()"
        [error]="failed()"
        (retry)="reload()"
        [trackBy]="trackFight"
        [pageSize]="PAGE_LIMIT"
        [serverMode]="true"
        [totalItems]="total()"
        [hideSearch]="true"
        emptyIcon="swords"
        [emptyLabel]="'intel.fi.empty'"
        [rowClickable]="true"
        (rowClick)="open($event)"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="date" let-row>
          <a
            class="font-medium no-underline hover:underline"
            style="color: var(--color-text)"
            [routerLink]="['/fights', row.fight_id]"
            (click)="$event.stopPropagation()"
          >
            {{ fmt.dateTime(row.started_at) }}
          </a>
        </ng-template>
        <ng-template dataTableCell="opponent" let-row>
          <span class="text-sm">{{ row.opponent ?? t('intel.unknownOpponent') }}</span>
        </ng-template>
        <ng-template dataTableCell="outcome" let-row>
          <app-outcome-chip [outcome]="row.outcome" />
        </ng-template>
        <ng-template dataTableCell="comp" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ row.comp_name ?? '—' }}</span>
        </ng-template>
        <ng-template dataTableCell="players" let-row>
          <span class="mono">{{ fmt.int(row.our_players) }}</span>
          <span class="mono text-xs" style="color: var(--color-text-tertiary)"> v {{ fmt.int(row.enemy_players) }}</span>
        </ng-template>
        <ng-template dataTableCell="kills" let-row>
          <span class="mono">{{ fmt.int(row.kills) }}</span>
        </ng-template>
        <ng-template dataTableCell="deaths" let-row>
          <span class="mono">{{ fmt.int(row.deaths) }}</span>
        </ng-template>
        <ng-template dataTableCell="kd" let-row>
          <span class="mono">{{ fmt.ratio(row.kd_ratio) }}</span>
        </ng-template>
        <ng-template dataTableCell="kill_fame" let-row>
          <span class="mono">{{ fmt.compact(row.kill_fame) }}</span>
        </ng-template>
        <ng-template dataTableCell="ip" let-row>
          <span class="mono">{{ fmt.int(row.avg_item_power) }}</span>
        </ng-template>
      </app-data-table>
    </app-page-stack>
  `,
})
export class IntelFightsPage {
  private readonly intel = inject(IntelService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);
  protected readonly period = inject(IntelPeriodState);

  protected readonly PAGE_LIMIT = PAGE_LIMIT;
  protected readonly outcomes = OUTCOMES;

  protected readonly data = signal<IntelFightList | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  protected readonly outcome = signal('');
  protected readonly opponent = signal('');
  protected readonly compId = signal('');
  protected readonly minPlayers = signal('');
  protected readonly maxPlayers = signal('');
  private readonly table = signal<DataTablePageChange>(
    parseDataTableQuery(this.route.snapshot.queryParamMap, { defaultPageSize: PAGE_LIMIT }),
  );
  private requestId = 0;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly rows = computed<IntelFightRow[]>(() => this.data()?.items ?? []);
  protected readonly total = computed(() => this.data()?.total_items ?? 0);
  protected readonly opponentOptions = computed(() => this.data()?.opponents ?? []);
  protected readonly compOptions = computed(() => this.data()?.comps ?? []);
  protected readonly filtered = computed(
    () =>
      this.outcome() !== '' ||
      this.opponent() !== '' ||
      this.compId() !== '' ||
      this.minPlayers() !== '' ||
      this.maxPlayers() !== '',
  );

  protected readonly summaryText = computed(() => {
    const summary = this.data()?.summary;
    if (!summary || summary.fights === 0) {
      return '';
    }
    return this.t('intel.fi.summary', {
      n: summary.fights,
      wins: summary.wins,
      losses: summary.losses,
      draws: summary.draws,
    });
  });

  protected readonly columns: readonly DataTableColumn<IntelFightRow>[] = [
    { key: 'date', label: 'common.date', sortable: true, accessor: (r) => r.started_at },
    { key: 'opponent', label: 'intel.col.opponent', accessor: (r) => r.opponent },
    { key: 'outcome', label: 'intel.col.outcome', accessor: (r) => r.outcome },
    { key: 'comp', label: 'intel.col.comp', accessor: (r) => r.comp_name },
    { key: 'players', label: 'intel.col.players', sortable: true, accessor: (r) => r.our_players, align: 'right' },
    { key: 'kills', label: 'intel.kills', sortable: true, accessor: (r) => r.kills, align: 'right' },
    { key: 'deaths', label: 'intel.col.deaths', sortable: true, accessor: (r) => r.deaths, align: 'right' },
    { key: 'kd', label: 'intel.kd', sortable: true, accessor: (r) => r.kd_ratio, align: 'right' },
    { key: 'kill_fame', label: 'intel.killFame', sortable: true, accessor: (r) => r.kill_fame, align: 'right' },
    { key: 'ip', label: 'intel.avgIp', accessor: (r) => r.avg_item_power, align: 'right' },
  ];

  protected readonly trackFight = (row: IntelFightRow): unknown => row.fight_id;

  constructor() {
    effect(() => {
      const query = this.buildQuery();
      untracked(() => void this.load(query));
    });
  }

  protected reload(): void {
    void this.load(this.buildQuery());
  }

  protected outcomeLabel(value: (typeof OUTCOMES)[number]): string {
    const keys: Record<(typeof OUTCOMES)[number], TranslationKey> = {
      victory: 'intel.outcome.victory',
      defeat: 'intel.outcome.defeat',
      draw: 'intel.outcome.draw',
      unknown: 'intel.outcome.unknown',
    };
    return this.t(keys[value]);
  }

  protected open(row: IntelFightRow): void {
    void this.router.navigate(['/fights', row.fight_id]);
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.table.set(event);
  }

  protected onOutcome(event: Event): void {
    this.setFilter(this.outcome, event);
  }

  protected onOpponent(event: Event): void {
    this.setFilter(this.opponent, event);
  }

  protected onComp(event: Event): void {
    this.setFilter(this.compId, event);
  }

  protected onMin(event: Event): void {
    this.setFilter(this.minPlayers, event);
  }

  protected onMax(event: Event): void {
    this.setFilter(this.maxPlayers, event);
  }

  protected resetFilters(): void {
    this.outcome.set('');
    this.opponent.set('');
    this.compId.set('');
    this.minPlayers.set('');
    this.maxPlayers.set('');
    this.backToFirstPage();
  }

  private setFilter(target: { set(value: string): void }, event: Event): void {
    target.set((event.target as HTMLInputElement | HTMLSelectElement).value.trim());
    this.backToFirstPage();
  }

  /** A filter change invalidates the current page, so go back to the first one. */
  private backToFirstPage(): void {
    this.table.update((state) => ({ ...state, page: 1 }));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: 1 },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private buildQuery(): IntelFightsQuery {
    const state = this.table();
    const sortKey = state.sort ? SORT_KEYS[state.sort.columnKey] : undefined;
    const positive = (raw: string): number | undefined => {
      const value = Number(raw);
      return raw !== '' && Number.isInteger(value) && value >= 0 ? value : undefined;
    };
    const comp = positive(this.compId());
    return {
      ...this.period.query(),
      outcome: this.outcome() || undefined,
      opponent: this.opponent() || undefined,
      comp_id: comp,
      min_players: positive(this.minPlayers()),
      max_players: positive(this.maxPlayers()),
      sort: sortKey,
      order: sortKey ? state.sort?.direction : undefined,
      page: state.page,
      limit: state.pageSize,
    };
  }

  private async load(query: IntelFightsQuery): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const list = await firstValueFrom(this.intel.fights(query));
      if (id === this.requestId) {
        this.data.set(list);
      }
    } catch {
      if (id === this.requestId) {
        this.failed.set(true);
      }
    } finally {
      if (id === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
