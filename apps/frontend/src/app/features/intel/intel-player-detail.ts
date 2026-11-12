import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntelPlayer } from '../../core/models/api.models';
import { ApiError } from '../../core/services/api.service';
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
import { Meter } from '../../shared/components/meter/meter';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { buildTrendChart } from './intel-charts';
import { IntelFormat } from './intel-format';
import { IntelPeriod, IntelPeriodState } from './intel-period';
import { OutcomeChip } from './outcome-chip';

/**
 * One member's combat page: trend, fights, weapons, roles, builds and comps for a period.
 *
 * Sits outside the Intel shell (it is a detail page), so it provides its own
 * {@link IntelPeriodState}, seeded from the link that brought the viewer here. The backend
 * refuses another member's page without `intel.report.view`.
 */
@Component({
  selector: 'app-intel-player-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    EmptyState,
    ErrorState,
    Icon,
    IntelPeriod,
    Loading,
    Meter,
    OutcomeChip,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
  ],
  providers: [IntelPeriodState],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
  `,
  template: `
    <a
      class="mb-3 inline-flex items-center gap-1 text-xs no-underline hover:underline"
      style="color: var(--color-text-secondary)"
      routerLink="/intel/players"
      [queryParams]="period.queryParams()"
    >
      <app-icon name="chevron-left" size="0.875rem" />
      {{ t('intel.pd.back') }}
    </a>

    @if (data(); as d) {
      <app-page-header [title]="d.member.username" [subtitle]="subtitle()" />
    }

    <app-page-stack>
      <app-intel-period />

      @if (notFound()) {
        <app-empty-state icon="alert" [message]="t('intel.pd.notFound')" />
      } @else if (data(); as d) {
        <div [attr.aria-busy]="loading()" [class.opacity-60]="loading()">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <app-stat-card [label]="t('intel.fights')" [value]="fmt.int(d.member.fights)" [sub]="fightsSub()" />
            <app-stat-card [label]="t('intel.winRate')" [value]="fmt.pct(d.member.win_rate)" [sub]="recordSub()" />
            <app-stat-card [label]="t('intel.kd')" [value]="fmt.ratio(d.member.kd_ratio)" [sub]="fmt.int(d.member.kills) + ' / ' + fmt.int(d.member.deaths)" />
            <app-stat-card [label]="t('intel.killFame')" [value]="fmt.compact(d.member.kill_fame)" [sub]="t('intel.col.deathFame') + ' ' + fmt.compact(d.member.death_fame)" />
          </div>

          @if (d.member.fights === 0) {
            <div class="mt-4">
              <app-empty-state icon="swords" [message]="t('intel.pd.noFights')" />
            </div>
          } @else {
            <section class="card mt-4 p-4" aria-labelledby="intel-pd-trend">
              <h2 class="eyebrow mb-2" id="intel-pd-trend">{{ t('intel.pd.trend') }}</h2>
              @if (trend(); as chart) {
                <app-chart
                  [option]="chart.option"
                  height="14rem"
                  [stale]="loading()"
                  [label]="t('intel.pd.trendLabel')"
                  [tableHead]="chart.tableHead"
                  [tableRows]="chart.tableRows"
                />
              }
            </section>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <section class="card p-4" aria-labelledby="intel-pd-weapons">
                <h2 class="eyebrow mb-3" id="intel-pd-weapons">{{ t('intel.pd.weapons') }}</h2>
                @if (d.weapons.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.pd.nothing') }}</p>
                } @else {
                  <div class="space-y-2">
                    @for (weapon of d.weapons; track weapon.weapon) {
                      <app-meter
                        [label]="fmt.weapon(weapon.weapon)"
                        [value]="weapon.count"
                        [max]="d.weapons[0].count"
                        [display]="fmt.int(weapon.count)"
                        tone="primary"
                      />
                    }
                  </div>
                }
              </section>

              <section class="card p-4" aria-labelledby="intel-pd-roles">
                <h2 class="eyebrow mb-3" id="intel-pd-roles">{{ t('intel.pd.roles') }}</h2>
                @if (d.roles.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.pd.nothing') }}</p>
                } @else {
                  <div class="space-y-2">
                    @for (role of d.roles; track role.role) {
                      <app-meter
                        [label]="fmt.role(role.role)"
                        [value]="role.count"
                        [max]="d.roles[0].count"
                        [display]="fmt.int(role.count)"
                        tone="primary"
                      />
                    }
                  </div>
                }
              </section>

              <section class="card p-4" aria-labelledby="intel-pd-comps">
                <h2 class="eyebrow mb-2" id="intel-pd-comps">{{ t('intel.pd.comps') }}</h2>
                @if (d.comps.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.pd.nothing') }}</p>
                } @else {
                  <div class="overflow-x-auto">
                    <table class="table">
                      <thead>
                        <tr>
                          <th scope="col">{{ t('intel.col.comp') }}</th>
                          <th scope="col" class="text-right">{{ t('intel.fights') }}</th>
                          <th scope="col" class="text-right">{{ t('intel.col.record') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (comp of d.comps; track comp.comp_id) {
                          <tr>
                            <td>
                              <a class="no-underline hover:underline" style="color: var(--color-text)" [routerLink]="['/comps', comp.comp_id]">{{ comp.name }}</a>
                            </td>
                            <td class="mono text-right">{{ fmt.int(comp.fights) }}</td>
                            <td class="mono whitespace-nowrap text-right">{{ comp.wins }} / {{ comp.losses }} / {{ comp.draws }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              </section>

              <section class="card p-4" aria-labelledby="intel-pd-builds">
                <h2 class="eyebrow mb-2" id="intel-pd-builds">{{ t('intel.pd.builds') }}</h2>
                @if (d.builds.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.pd.nothing') }}</p>
                } @else {
                  <ul class="divide-y" style="border-color: var(--color-border)">
                    @for (build of d.builds; track build.build_id) {
                      <li class="flex items-center justify-between gap-3 py-2 first:pt-0">
                        <div class="min-w-0">
                          <p class="truncate text-sm font-medium">{{ build.name }}</p>
                          <p class="text-xs" style="color: var(--color-text-secondary)">{{ fmt.role(build.role) }}</p>
                        </div>
                        <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                          {{ t('intel.pd.events', { n: build.events }) }}
                        </span>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>

            <section class="card mt-4 p-4" aria-labelledby="intel-pd-fights">
              <h2 class="eyebrow mb-2" id="intel-pd-fights">{{ t('intel.pd.fights') }}</h2>
              <div class="overflow-x-auto">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('common.date') }}</th>
                      <th scope="col">{{ t('intel.col.opponent') }}</th>
                      <th scope="col">{{ t('intel.col.outcome') }}</th>
                      <th scope="col">{{ t('intel.col.comp') }}</th>
                      <th scope="col">{{ t('intel.pd.weapon') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.kills') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.col.deaths') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.killFame') }}</th>
                      <th scope="col" class="text-right">{{ t('intel.avgIp') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (fight of d.fights; track fight.fight_id) {
                      <tr>
                        <td>
                          <a class="no-underline hover:underline" style="color: var(--color-text)" [routerLink]="['/fights', fight.fight_id]">
                            {{ fmt.dateTime(fight.started_at) }}
                          </a>
                        </td>
                        <td>{{ fight.opponent ?? t('intel.unknownOpponent') }}</td>
                        <td><app-outcome-chip [outcome]="fight.outcome" /></td>
                        <td>{{ fight.comp_name ?? '—' }}</td>
                        <td>{{ fmt.weapon(fight.weapon) }}</td>
                        <td class="mono text-right">{{ fmt.int(fight.kills) }}</td>
                        <td class="mono text-right">{{ fmt.int(fight.deaths) }}</td>
                        <td class="mono text-right">{{ fmt.compact(fight.kill_fame) }}</td>
                        <td class="mono text-right">{{ fmt.int(fight.avg_item_power) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
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
export class IntelPlayerDetailPage {
  private readonly intel = inject(IntelService);
  private readonly route = inject(ActivatedRoute);
  private readonly theme = inject(ThemeService);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);
  protected readonly period = inject(IntelPeriodState);

  protected readonly data = signal<IntelPlayer | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly notFound = signal(false);
  private requestId = 0;

  private readonly userId = Number(this.route.snapshot.paramMap.get('userId'));

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly subtitle = computed(() => {
    const member = this.data()?.member;
    if (!member) {
      return '';
    }
    const parts = [member.albion_name, member.role].filter((part): part is string => !!part);
    return parts.join(' · ');
  });

  protected readonly fightsSub = computed(() => {
    const member = this.data()?.member;
    return member ? `${this.t('intel.pl.attendance')} ${this.fmt.pct(member.attendance_rate)}` : '';
  });

  protected readonly recordSub = computed(() => {
    const member = this.data()?.member;
    return member ? `${member.wins} / ${member.losses} / ${member.draws}` : '';
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
        line: week.kills,
      })),
      barName: this.t('intel.fights'),
      lineName: this.t('intel.kills'),
      linePercent: false,
      weekHeader: this.t('intel.trends.week'),
      formatLine: (value) => this.fmt.int(value),
      palette: chartPalette(dark),
      chrome: chartChrome(dark),
    });
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

  private async load(query: ReturnType<IntelPeriodState['query']>): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.failed.set(false);
    this.notFound.set(false);
    try {
      const player = await firstValueFrom(this.intel.rosterMember(this.userId, query));
      if (id === this.requestId) {
        this.data.set(player);
      }
    } catch (error) {
      if (id === this.requestId) {
        this.data.set(null);
        if (error instanceof ApiError && error.status === 404) {
          this.notFound.set(true);
        } else {
          this.failed.set(true);
        }
      }
    } finally {
      if (id === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
