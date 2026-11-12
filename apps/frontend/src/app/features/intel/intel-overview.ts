import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntelOverview, IntelTotals } from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Chart } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { buildTrendChart } from './intel-charts';
import { IntelFormat } from './intel-format';
import { IntelPeriod, IntelPeriodState } from './intel-period';
import { OutcomeChip } from './outcome-chip';

type Direction = 'up' | 'down' | 'neutral';

/** A metric that moved enough against the previous period to be worth a line. */
interface Change {
  readonly id: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly delta: string;
  /** Which way the number moved. */
  readonly moved: 'up' | 'down';
  /** Whether that is good news, bad news, or just a fact. */
  readonly tone: 'good' | 'bad' | 'neutral';
}

/** Share of the previous value a metric has to move by before it counts as a change. */
const RELATIVE_THRESHOLD = 0.15;
/** Win rate moves by this many points before it counts as a change. */
const WIN_RATE_POINTS = 5;
/** Fewer decided fights than this and a win-rate swing is noise. */
const MIN_DECIDED_FOR_RATE = 3;

/**
 * Intel overview: how the guild is doing over the selected period, and what changed.
 *
 * Every figure comes from `GET /api/intel/overview`. Rates stay blank rather than showing 0%
 * when nothing was decided, and the previous period drives the deltas and the change list.
 */
@Component({
  selector: 'app-intel-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    EmptyState,
    ErrorState,
    Icon,
    IntelPeriod,
    Loading,
    OutcomeChip,
    PageStack,
    RouterLink,
    StatCard,
  ],
  template: `
    <app-page-stack>
      <app-intel-period />

      @if (data(); as d) {
        <div [attr.aria-busy]="loading()" [class.opacity-60]="loading()">
          <p class="mb-3 text-xs" style="color: var(--color-text-secondary)">{{ periodText() }}</p>

          @if (d.current.fights === 0) {
            <app-empty-state icon="swords" [message]="t('intel.ov.empty')" [hint]="t('intel.ov.emptyHint')" />
          } @else {
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              @for (kpi of kpis(); track kpi.id) {
                <app-stat-card
                  [label]="kpi.label"
                  [value]="kpi.value"
                  [sub]="kpi.sub"
                  [delta]="kpi.delta"
                  [deltaDirection]="kpi.direction"
                />
              }
            </div>

            <div class="mt-4 grid gap-4 lg:grid-cols-3">
              <section class="card p-4 lg:col-span-2" aria-labelledby="intel-ov-trend">
                <h2 class="eyebrow mb-2" id="intel-ov-trend">{{ t('intel.ov.trend') }}</h2>
                @if (trend(); as chart) {
                  <app-chart
                    [option]="chart.option"
                    height="16rem"
                    [stale]="loading()"
                    [label]="t('intel.ov.trendLabel')"
                    [tableHead]="chart.tableHead"
                    [tableRows]="chart.tableRows"
                  />
                }
              </section>

              <section class="card p-4" aria-labelledby="intel-ov-changes">
                <h2 class="eyebrow" id="intel-ov-changes">{{ t('intel.ov.changes') }}</h2>
                <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">{{ t('intel.ov.changesHint') }}</p>
                @if (d.previous === null) {
                  <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.ov.changesNoPrevious') }}</p>
                } @else if (changes().length === 0) {
                  <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.ov.changesNone') }}</p>
                } @else {
                  <ul class="mt-3 divide-y" style="border-color: var(--color-border)">
                    @for (change of changes(); track change.id) {
                      <li class="flex items-start justify-between gap-3 py-2 first:pt-0">
                        <div class="min-w-0">
                          <p class="text-sm font-medium">{{ change.label }}</p>
                          <p class="mono text-xs" style="color: var(--color-text-secondary)">
                            {{ change.from }} → {{ change.to }}
                          </p>
                        </div>
                        <p
                          class="mono flex shrink-0 items-center gap-1 text-sm font-medium"
                          [style.color]="toneColor(change.tone)"
                        >
                          <app-icon [name]="change.moved === 'up' ? 'chevron-up' : 'chevron-down'" size="0.875rem" />
                          <span class="sr-only">{{ change.moved === 'up' ? t('intel.ov.up') : t('intel.ov.down') }}</span>
                          {{ change.delta }}
                        </p>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>

            <section class="card mt-4 p-4" aria-labelledby="intel-ov-recent">
              <div class="mb-2 flex items-center justify-between gap-3">
                <h2 class="eyebrow" id="intel-ov-recent">{{ t('intel.ov.recent') }}</h2>
                <a class="text-xs no-underline hover:underline" style="color: var(--color-primary)" routerLink="/intel/fights" [queryParams]="period.queryParams()">
                  {{ t('intel.ov.allFights') }}
                </a>
              </div>
              <div class="overflow-x-auto">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('common.date') }}</th>
                      <th scope="col">{{ t('intel.col.opponent') }}</th>
                      <th scope="col">{{ t('intel.col.outcome') }}</th>
                      <th scope="col">{{ t('intel.col.comp') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.col.players') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.kd') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (fight of d.recent_fights; track fight.fight_id) {
                      <tr>
                        <td>
                          <a class="no-underline hover:underline" style="color: var(--color-text)" [routerLink]="['/fights', fight.fight_id]">
                            {{ fmt.dateTime(fight.started_at) }}
                          </a>
                        </td>
                        <td>{{ fight.opponent ?? t('intel.unknownOpponent') }}</td>
                        <td><app-outcome-chip [outcome]="fight.outcome" /></td>
                        <td>{{ fight.comp_name ?? '—' }}</td>
                        <td class="mono text-right">{{ fmt.int(fight.our_players) }}</td>
                        <td class="mono text-right">{{ fmt.ratio(fight.kd_ratio) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <section class="card p-4" aria-labelledby="intel-ov-opponents">
                <h2 class="eyebrow mb-2" id="intel-ov-opponents">{{ t('intel.ov.topOpponents') }}</h2>
                @if (d.top_opponents.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.ov.noOpponents') }}</p>
                } @else {
                  <div class="overflow-x-auto">
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
                        @for (row of d.top_opponents; track row.opponent) {
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

              <section class="card p-4" aria-labelledby="intel-ov-coverage">
                <h2 class="eyebrow mb-2" id="intel-ov-coverage">{{ t('intel.ov.coverage') }}</h2>
                @if (coverageNotes().length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.ov.coverageOk') }}</p>
                } @else {
                  <ul class="space-y-2 text-sm" style="color: var(--color-text-secondary)">
                    @for (note of coverageNotes(); track note) {
                      <li class="flex items-start gap-2">
                        <app-icon name="info" size="0.875rem" class="mt-0.5 shrink-0" />
                        <span>{{ note }}</span>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>
          }
        </div>
      } @else if (failed()) {
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="reload()" />
      } @else {
        <app-loading [label]="t('common.loading')" />
      }
    </app-page-stack>
  `,
})
export class IntelOverviewPage {
  private readonly intel = inject(IntelService);
  private readonly theme = inject(ThemeService);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);
  protected readonly period = inject(IntelPeriodState);

  protected readonly data = signal<IntelOverview | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private requestId = 0;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly periodText = computed(() => {
    const d = this.data();
    if (!d) {
      return '';
    }
    const to = this.fmt.date(d.period.to);
    return d.period.from
      ? this.t('intel.period.showing', { from: this.fmt.date(d.period.from), to })
      : this.t('intel.period.showingAll', { to });
  });

  protected readonly kpis = computed(() => {
    const d = this.data();
    if (!d) {
      return [];
    }
    const cur = d.current;
    const prev = d.previous;
    const f = this.fmt;
    const list: {
      id: string;
      label: string;
      value: string;
      sub?: string;
      delta?: string;
      direction: Direction;
    }[] = [
      {
        id: 'fights',
        label: this.t('intel.fights'),
        value: f.int(cur.fights),
        sub: this.t('intel.ov.fightsSub', { n: cur.fights_with_stats }),
        ...this.deltaOf(prev, cur, (t) => t.fights, (n) => f.signed(n), false),
      },
      {
        id: 'win_rate',
        label: this.t('intel.winRate'),
        value: f.pct(cur.win_rate),
        sub: cur.decided > 0 ? this.t('intel.ov.decided', { n: cur.decided }) : this.t('intel.ov.noneDecided'),
        ...this.deltaOf(
          prev,
          cur,
          (t) => t.win_rate,
          (n) => this.t('intel.ov.pts', { n: f.signed(n, 1) }),
          true,
        ),
      },
      {
        id: 'kd',
        label: this.t('intel.kd'),
        value: f.ratio(cur.kd_ratio),
        sub: `${f.int(cur.kills)} / ${f.int(cur.deaths)}`,
        ...this.deltaOf(prev, cur, (t) => t.kd_ratio, (n) => f.signed(n, 2), true),
      },
      {
        id: 'kill_fame',
        label: this.t('intel.killFame'),
        value: f.compact(cur.kill_fame),
        sub: `${this.t('intel.col.deathFame')} ${f.compact(cur.death_fame)}`,
        ...this.deltaOf(prev, cur, (t) => t.kill_fame, (n) => `${n < 0 ? '-' : '+'}${f.compact(Math.abs(n))}`, true),
      },
      {
        id: 'players',
        label: this.t('intel.ov.avgPlayers'),
        value: f.dec(cur.avg_players, 1),
        ...this.deltaOf(prev, cur, (t) => t.avg_players, (n) => f.signed(n, 1), false),
      },
      {
        id: 'ip',
        label: this.t('intel.avgIp'),
        value: f.int(cur.avg_item_power),
        sub: cur.enemy_avg_item_power === null ? undefined : `${this.t('intel.enemy')} ${f.int(cur.enemy_avg_item_power)}`,
        ...this.deltaOf(prev, cur, (t) => t.avg_item_power, (n) => f.signed(n, 0), false),
      },
    ];
    if (cur.estimated_silver_lost !== null) {
      list.push({
        id: 'silver',
        label: this.t('intel.silverLost'),
        value: f.compact(cur.estimated_silver_lost),
        sub: this.t('intel.ov.silverSub'),
        direction: 'neutral',
      });
    }
    return list;
  });

  protected readonly changes = computed<Change[]>(() => {
    const d = this.data();
    if (!d?.previous) {
      return [];
    }
    return this.collectChanges(d.previous, d.current);
  });

  protected readonly trend = computed(() => {
    const d = this.data();
    if (!d || d.weekly.length === 0) {
      return null;
    }
    const dark = this.theme.isDark();
    return buildTrendChart({
      points: d.weekly.map((week) => ({
        label: this.fmt.shortDate(week.week_start),
        bar: week.fights,
        line: week.win_rate,
      })),
      barName: this.t('intel.fights'),
      lineName: this.t('intel.winRate'),
      linePercent: true,
      weekHeader: this.t('intel.trends.week'),
      formatLine: (value) => this.fmt.pct(value),
      palette: chartPalette(dark),
      chrome: chartChrome(dark),
    });
  });

  protected readonly coverageNotes = computed<string[]>(() => {
    const q = this.data()?.data_quality;
    if (!q) {
      return [];
    }
    const notes: string[] = [];
    if (q.fights_without_stats > 0) {
      notes.push(this.t('intel.ov.noStats', { n: q.fights_without_stats }));
    }
    if (q.fights_unknown_outcome > 0) {
      notes.push(this.t('intel.ov.unknownOutcome', { n: q.fights_unknown_outcome }));
    }
    if (q.fights_without_comp > 0) {
      notes.push(this.t('intel.ov.noComp', { n: q.fights_without_comp }));
    }
    return notes;
  });

  constructor() {
    effect(() => {
      const query = this.period.query();
      untracked(() => void this.load(query));
    });
  }

  protected reload(): void {
    void this.load(this.period.query());
  }

  protected toneColor(tone: Change['tone']): string {
    if (tone === 'good') {
      return 'var(--color-success)';
    }
    return tone === 'bad' ? 'var(--color-error)' : 'var(--color-text-secondary)';
  }

  private async load(query: ReturnType<IntelPeriodState['query']>): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const overview = await firstValueFrom(this.intel.overview(query));
      if (id === this.requestId) {
        this.data.set(overview);
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

  /**
   * Delta chip for a KPI. `higherIsBetter` decides whether a rise reads as good news; when it
   * is false the chip stays neutral, since more fights or bigger fights are facts, not verdicts.
   */
  private deltaOf(
    previous: IntelTotals | null,
    current: IntelTotals,
    pick: (totals: IntelTotals) => number | null,
    format: (diff: number) => string,
    higherIsBetter: boolean,
  ): { delta?: string; direction: Direction } {
    if (!previous || previous.fights === 0) {
      return { direction: 'neutral' };
    }
    const a = pick(previous);
    const b = pick(current);
    if (a === null || b === null) {
      return { direction: 'neutral' };
    }
    const diff = b - a;
    if (Math.abs(diff) < 1e-9) {
      return { delta: format(0), direction: 'neutral' };
    }
    if (!higherIsBetter) {
      return { delta: format(diff), direction: 'neutral' };
    }
    return { delta: format(diff), direction: diff > 0 ? 'up' : 'down' };
  }

  private collectChanges(previous: IntelTotals, current: IntelTotals): Change[] {
    const f = this.fmt;
    const out: Change[] = [];

    if (
      previous.decided >= MIN_DECIDED_FOR_RATE &&
      current.decided >= MIN_DECIDED_FOR_RATE &&
      previous.win_rate !== null &&
      current.win_rate !== null &&
      Math.abs(current.win_rate - previous.win_rate) >= WIN_RATE_POINTS
    ) {
      const diff = current.win_rate - previous.win_rate;
      out.push({
        id: 'win_rate',
        label: this.t('intel.winRate'),
        from: f.pct(previous.win_rate),
        to: f.pct(current.win_rate),
        delta: this.t('intel.ov.pts', { n: f.signed(diff, 1) }),
        moved: diff > 0 ? 'up' : 'down',
        tone: diff > 0 ? 'good' : 'bad',
      });
    }

    const relative = (
      id: string,
      label: string,
      a: number | null,
      b: number | null,
      show: (n: number) => string,
      showDiff: (n: number) => string,
      good: 'up' | 'down' | 'neutral',
      minAbs: number,
    ): void => {
      if (a === null || b === null || a === 0) {
        return;
      }
      const diff = b - a;
      if (Math.abs(diff) < minAbs || Math.abs(diff) / Math.abs(a) < RELATIVE_THRESHOLD) {
        return;
      }
      const moved = diff > 0 ? 'up' : 'down';
      out.push({
        id,
        label,
        from: show(a),
        to: show(b),
        delta: showDiff(diff),
        moved,
        tone: good === 'neutral' ? 'neutral' : good === moved ? 'good' : 'bad',
      });
    };

    relative('fights', this.t('intel.fights'), previous.fights, current.fights, (n) => f.int(n), (n) => f.signed(n), 'neutral', 3);
    relative('kd', this.t('intel.kd'), previous.kd_ratio, current.kd_ratio, (n) => f.ratio(n), (n) => f.signed(n, 2), 'up', 0.1);
    relative('kill_fame', this.t('intel.killFame'), previous.kill_fame, current.kill_fame, (n) => f.compact(n), (n) => `${n < 0 ? '-' : '+'}${f.compact(Math.abs(n))}`, 'up', 1);
    relative('death_fame', this.t('intel.col.deathFame'), previous.death_fame, current.death_fame, (n) => f.compact(n), (n) => `${n < 0 ? '-' : '+'}${f.compact(Math.abs(n))}`, 'down', 1);
    relative('players', this.t('intel.ov.avgPlayers'), previous.avg_players, current.avg_players, (n) => f.dec(n, 1), (n) => f.signed(n, 1), 'neutral', 1);
    return out;
  }
}
