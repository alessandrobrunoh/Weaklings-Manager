import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  GuildReport,
  LeaderboardEntry,
  ReportCompRow,
  ReportEnemyRow,
  ReportMemberRow,
  TimelineEntry,
} from '../../core/models/api.models';
import { IntelService } from '../../core/services/intel.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  buildCombatTrendsChart,
  buildEconomyFlowChart,
  buildHorizontalBarsChart,
  buildHoursActivityChart,
  buildLossRegearChart,
  topWeaponRows,
  type ChartBuild,
} from '../../shared/charts/guild-report-charts';
import { Chart } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type GuildTab = 'overview' | 'roster' | 'economy' | 'meta' | 'leaderboards';
type PeriodId = '7' | '30' | '90' | 'custom';

const MS_PER_DAY = 86_400_000;
const PRESET_DAYS: Readonly<Record<Exclude<PeriodId, 'custom'>, number>> = { '7': 7, '30': 30, '90': 90 };

type Fight = NonNullable<GuildReport['overview']['best_fight']>;

interface NotableFight {
  readonly key: string;
  readonly label: string;
  readonly fight: Fight;
}

interface RoleComparisonRow {
  readonly role: string;
  readonly needed: number;
  readonly filled: number;
}

interface LeaderboardCategory {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly LeaderboardEntry[];
}

function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * Whole-guild dashboard over the full `GuildReport`.
 *
 * Every other page that touches this report reads one slice of it: `/season`
 * shows the leaderboards, `/admin/finance` shows the economy, `/intel` shows
 * enemies and comps. This page is the one place that surfaces all of it —
 * combat, roster, economy, meta and leaderboards — for a single reporting
 * window, so an officer never has to stitch the picture together by hand.
 *
 * Each tab shows one summary band of the figures an officer acts on, then the
 * detail as charts and tables. A figure appears once: the band holds the totals,
 * and tables and charts do not repeat them.
 */
@Component({
  selector: 'app-guild-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    DataTable,
    DataTableCell,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    .guild-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .guild-filters__group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .guild-section {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .guild-section__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .guild-section__head .hint {
      margin-top: 0.125rem;
    }
    .guild-chart-grid,
    .guild-split-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .guild-card {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .guild-chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .guild-table__num {
      text-align: right;
    }
    .guild-leaderboard-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .guild-leaderboard-grid .guild-card {
      align-content: start;
    }
    .guild-leaderboard-grid .section-title {
      margin: 0;
    }
    @media (max-width: 72rem) {
      .guild-leaderboard-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 52rem) {
      .guild-chart-grid,
      .guild-split-grid,
      .guild-leaderboard-grid {
        grid-template-columns: 1fr;
      }
    }
  `,
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (report(); as r) {
      <app-page-header [title]="t('guild.title')" [subtitle]="t('guild.subtitle')">
        <button type="button" class="btn btn--outline btn--sm" [disabled]="busy()" (click)="refresh()">
          <app-icon name="refresh" size="0.875rem" />
          {{ t('common.refreshNow') }}
        </button>
        <app-tabs
          pageTabs
          [ariaLabel]="t('guild.sections')"
          [options]="tabOptions()"
          [active]="tab()"
          (activeChange)="onTabChange($event)"
        />
      </app-page-header>

      <app-page-stack>
        <div class="guild-filters">
          <div class="guild-filters__group">
            <span class="label">{{ t('guild.period.label') }}</span>
            <app-tabs
              variant="segmented"
              [ariaLabel]="t('guild.period.label')"
              [options]="periodOptions()"
              [active]="period()"
              (activeChange)="onPeriodChange($event)"
            />
            @if (period() === 'custom') {
              <label class="sr-only" for="guild-from">{{ t('guild.period.from') }}</label>
              <input
                id="guild-from"
                class="input input--sm"
                type="date"
                [value]="customFrom()"
                [max]="customTo()"
                (change)="onCustomFrom($event)"
              />
              <span aria-hidden="true" class="hint">→</span>
              <label class="sr-only" for="guild-to">{{ t('guild.period.to') }}</label>
              <input
                id="guild-to"
                class="input input--sm"
                type="date"
                [value]="customTo()"
                [min]="customFrom()"
                [max]="today()"
                (change)="onCustomTo($event)"
              />
            }
          </div>
          <p class="hint" aria-live="polite">{{ formatDate(r.from) }} → {{ formatDate(r.to) }}</p>
        </div>

        @switch (tab()) {
          @case ('overview') {
            <app-summary-band [ariaLabel]="t('guild.tabs.overview')" [items]="overviewStats()" />

            @if (notableFights().length > 0) {
              <section class="guild-section" aria-labelledby="guild-notable">
                <h2 class="section-title" id="guild-notable">{{ t('guild.notable.title') }}</h2>
                <app-data-table
                  [columns]="notableColumns"
                  [rows]="notableFights()"
                  [trackBy]="trackNotable"
                  [hideSearch]="true"
                  [hidePageSize]="true"
                  [syncUrl]="false"
                  [ariaLabel]="t('guild.notable.title')"
                >
                  <ng-template dataTableCell="opponent" let-row>
                    <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/battles', row.fight.battle_id]">
                      {{ row.fight.opponent || t('intel.unknownOpponent') }}
                    </a>
                  </ng-template>
                  <ng-template dataTableCell="when" let-row>
                    {{ formatDateTime(row.fight.started_at) }}
                  </ng-template>
                  <ng-template dataTableCell="kill_fame" let-row>
                    <span class="num">{{ formatCompact(row.fight.kill_fame) }}</span>
                  </ng-template>
                </app-data-table>
              </section>
            }

            <div class="guild-chart-grid">
              <section class="card guild-card" aria-labelledby="guild-trends">
                <div class="guild-section__head">
                  <div>
                    <h2 class="section-title section-title--sm" id="guild-trends">{{ t('guild.charts.weeklyTrends') }}</h2>
                    <p class="hint">{{ t('guild.charts.weeklyTrendsSub') }}</p>
                  </div>
                </div>
                @if (r.trends.length > 0) {
                  <app-chart
                    [option]="trendsChart().option"
                    height="18rem"
                    [stale]="busy()"
                    [label]="t('guild.charts.weeklyTrends')"
                    [tableHead]="trendsChart().tableHead"
                    [tableRows]="trendsChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>

              <section class="card guild-card" aria-labelledby="guild-hours">
                <div class="guild-section__head">
                  <div>
                    <h2 class="section-title section-title--sm" id="guild-hours">{{ t('guild.charts.hourly') }}</h2>
                    <p class="hint">{{ t('intel.timingHint') }}</p>
                  </div>
                </div>
                @if (r.hours.length > 0) {
                  <app-chart
                    [option]="hoursChart().option"
                    height="18rem"
                    [stale]="busy()"
                    [label]="t('guild.charts.hourly')"
                    [tableHead]="hoursChart().tableHead"
                    [tableRows]="hoursChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>
            </div>

            <section class="guild-section" aria-labelledby="guild-timeline">
              <h2 class="section-title" id="guild-timeline">{{ t('guild.timeline.title') }}</h2>
              <app-data-table
                [columns]="timelineColumns"
                [rows]="recentTimeline()"
                [trackBy]="trackTimeline"
                [hideSearch]="true"
                [hidePageSize]="true"
                [syncUrl]="false"
                [mobileLayout]="'stack'"
                [ariaLabel]="t('guild.timeline.title')"
              >
                <ng-template dataTableCell="at" let-row>
                  {{ formatDateTime(row.at) }}
                </ng-template>
                <ng-template dataTableCell="kind" let-row>
                  <span class="inline-flex items-center gap-2">
                    <app-icon [name]="timelineIcon(row.kind)" size="0.875rem" />
                    {{ timelineKindLabel(row.kind) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="title" let-row>
                  <span class="font-medium">{{ row.title }}</span>
                  @if (row.detail) {
                    <br />
                    <span class="hint">{{ row.detail }}</span>
                  }
                </ng-template>
              </app-data-table>
            </section>

            <p class="hint">
              {{ t('guild.dataQuality.line', {
                attributed: r.data_quality.attributed_battles,
                total: r.data_quality.total_battles,
                unlinked: r.data_quality.unlinked_players.length
              }) }}
            </p>
          }

          @case ('roster') {
            <app-summary-band [ariaLabel]="t('guild.tabs.roster')" [items]="operationsStats()" />

            <div class="guild-split-grid">
              <section class="card guild-card" aria-labelledby="guild-role">
                <h2 class="section-title section-title--sm" id="guild-role">{{ t('intel.roleCoverage') }}</h2>
                @if (roleComparisonRows().length > 0) {
                  <div class="table-scroll">
                    <table class="table guild-table">
                      <thead>
                        <tr>
                          <th scope="col">{{ t('common.role') }}</th>
                          <th scope="col" class="guild-table__num">{{ t('guild.roster.roleNeeded') }}</th>
                          <th scope="col" class="guild-table__num">{{ t('guild.roster.roleFilled') }}</th>
                          <th scope="col">{{ t('common.status') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (row of roleComparisonRows(); track row.role) {
                          <tr>
                            <td>{{ row.role }}</td>
                            <td class="guild-table__num num">{{ row.needed }}</td>
                            <td class="guild-table__num num">{{ row.filled }}</td>
                            <td>
                              @if (row.filled < row.needed) {
                                <app-status-chip
                                  value="short"
                                  [toneOverride]="'warning'"
                                  [label]="t('guild.roster.shortBy', { count: row.needed - row.filled })"
                                />
                              } @else {
                                <app-status-chip value="covered" [toneOverride]="'success'" [label]="t('guild.roster.covered')" />
                              }
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>

              <section class="card guild-card" aria-labelledby="guild-inactive">
                <h2 class="section-title section-title--sm" id="guild-inactive">{{ t('guild.roster.inactive') }}</h2>
                @if (r.operations.inactive_members.length > 0) {
                  <div class="guild-chip-list">
                    @for (name of r.operations.inactive_members; track name) {
                      <span class="chip chip--neutral">{{ name }}</span>
                    }
                  </div>
                } @else {
                  <app-empty-state compact [message]="t('intel.allActive')" />
                }
              </section>
            </div>

            <section class="guild-section" aria-labelledby="guild-members">
              <h2 class="section-title" id="guild-members">{{ t('battles.guild_roster') }}</h2>
              <app-data-table
                [columns]="memberColumns"
                [rows]="r.members"
                [trackBy]="trackMember"
                [pageSize]="15"
                [stickyFirstColumn]="true"
                [syncUrl]="false"
                [ariaLabel]="t('battles.guild_roster')"
              >
                <ng-template dataTableCell="username" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/users', row.user_id]">
                    {{ row.username }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="kill_fame" let-row>
                  <span class="num">{{ formatCompact(row.kill_fame) }}</span>
                </ng-template>
                <ng-template dataTableCell="silver_lost" let-row>
                  <span class="num">{{ formatCompact(row.silver_lost) }}</span>
                </ng-template>
                <ng-template dataTableCell="fill_rate" let-row>
                  <span class="num">{{ formatPercent(row.fill_rate) }}</span>
                </ng-template>
                <ng-template dataTableCell="siphoned" let-row>
                  <span class="num">{{ formatCompact(row.siphoned) }}</span>
                </ng-template>
              </app-data-table>
            </section>
          }

          @case ('economy') {
            <app-summary-band [ariaLabel]="t('guild.tabs.economy')" [items]="economyStats()" />

            <div class="guild-chart-grid">
              <section class="card guild-card" aria-labelledby="guild-flow">
                <h2 class="section-title section-title--sm" id="guild-flow">{{ t('bank.finance.weeklyFlow') }}</h2>
                @if (r.trends.length > 0) {
                  <app-chart
                    [option]="economyFlowChart().option"
                    height="17rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.weeklyFlow')"
                    [tableHead]="economyFlowChart().tableHead"
                    [tableRows]="economyFlowChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>

              <section class="card guild-card" aria-labelledby="guild-loss-regear">
                <h2 class="section-title section-title--sm" id="guild-loss-regear">{{ t('bank.finance.lossVsRegear') }}</h2>
                @if (r.trends.length > 0) {
                  <app-chart
                    [option]="lossRegearChart().option"
                    height="17rem"
                    [stale]="busy()"
                    [label]="t('bank.finance.lossVsRegear')"
                    [tableHead]="lossRegearChart().tableHead"
                    [tableRows]="lossRegearChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>
            </div>

            <div>
              <a class="btn btn--outline btn--sm no-underline" routerLink="/admin/finance">
                {{ t('guild.economy.fullDetail') }}
                <app-icon name="chevron-right" size="0.75rem" />
              </a>
            </div>
          }

          @case ('meta') {
            <div class="guild-chart-grid">
              <section class="card guild-card" aria-labelledby="guild-our-meta">
                <h2 class="section-title section-title--sm" id="guild-our-meta">{{ t('intel.ourMeta') }}</h2>
                @if (r.our_meta.length > 0) {
                  <app-chart
                    [option]="ourMetaChart().option"
                    height="16rem"
                    [stale]="busy()"
                    [label]="t('intel.ourMeta')"
                    [tableHead]="ourMetaChart().tableHead"
                    [tableRows]="ourMetaChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>

              <section class="card guild-card" aria-labelledby="guild-enemy-meta">
                <h2 class="section-title section-title--sm" id="guild-enemy-meta">{{ t('intel.enemyMeta') }}</h2>
                @if (r.enemy_meta.length > 0) {
                  <app-chart
                    [option]="enemyMetaChart().option"
                    height="16rem"
                    [stale]="busy()"
                    [label]="t('intel.enemyMeta')"
                    [tableHead]="enemyMetaChart().tableHead"
                    [tableRows]="enemyMetaChart().tableRows"
                  />
                } @else {
                  <app-empty-state compact [message]="t('guild.charts.noData')" />
                }
              </section>
            </div>

            <section class="guild-section" aria-labelledby="guild-comps">
              <h2 class="section-title" id="guild-comps">{{ t('intel.compPerformance') }}</h2>
              <app-data-table
                urlKey="comps"
                [columns]="compColumns"
                [rows]="r.comps"
                [trackBy]="trackComp"
                [pageSize]="10"
                [ariaLabel]="t('intel.compPerformance')"
              >
                <ng-template dataTableCell="name" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/comps', row.comp_id]">
                    {{ row.name }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="win_rate" let-row>
                  <span class="num">{{ formatPercent(row.win_rate) }}</span>
                </ng-template>
                <ng-template dataTableCell="fill_rate" let-row>
                  <span class="num">{{ formatPercent(row.fill_rate) }}</span>
                </ng-template>
              </app-data-table>
            </section>

            <section class="guild-section" aria-labelledby="guild-enemies">
              <h2 class="section-title" id="guild-enemies">{{ t('intel.nav.enemies') }}</h2>
              <app-data-table
                urlKey="enemies"
                [columns]="enemyColumns"
                [rows]="r.enemies"
                [trackBy]="trackEnemy"
                [pageSize]="10"
                [ariaLabel]="t('intel.nav.enemies')"
              >
                <ng-template dataTableCell="name" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/intel/opponents/scouts', row.scouted_comp_id]">
                    {{ row.name }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="record" let-row>
                  <span class="num">{{ row.wins }} - {{ row.losses }}</span>
                </ng-template>
                <ng-template dataTableCell="last_seen" let-row>
                  {{ formatDate(row.last_seen) }}
                </ng-template>
              </app-data-table>
            </section>
          }

          @case ('leaderboards') {
            <div class="guild-leaderboard-grid">
              @for (category of leaderboardCategories(); track category.key) {
                <section class="card guild-card" [attr.aria-labelledby]="'guild-board-' + category.key">
                  <h2 class="section-title section-title--sm" [id]="'guild-board-' + category.key">{{ category.label }}</h2>
                  @if (category.entries.length > 0) {
                    <div class="table-scroll">
                      <table class="table guild-table">
                        <thead>
                          <tr>
                            <th scope="col">{{ t('guild.leaderboard.rank') }}</th>
                            <th scope="col">{{ t('common.player') }}</th>
                            <th scope="col" class="guild-table__num">{{ t('guild.leaderboard.value') }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (entry of category.entries; track entry.user_id; let i = $index) {
                            <tr>
                              <td class="num">#{{ i + 1 }}</td>
                              <td>
                                <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/users', entry.user_id]">
                                  {{ entry.username }}
                                </a>
                              </td>
                              <td class="guild-table__num num">{{ formatCompact(entry.value) }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  } @else {
                    <app-empty-state compact [message]="t('leaderboards.empty')" />
                  }
                </section>
              }
            </div>

            <div>
              <a class="btn btn--outline btn--sm no-underline" routerLink="/season">
                {{ t('guild.leaderboard.fullStandings') }}
                <app-icon name="chevron-right" size="0.75rem" />
              </a>
            </div>
          }
        }
      </app-page-stack>
    } @else {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    }
  `,
})
export class GuildOverviewPage {
  private readonly intel = inject(IntelService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly theme = inject(ThemeService);

  protected readonly report = signal<GuildReport | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly tab = signal<GuildTab>('overview');

  protected readonly period = signal<PeriodId>('30');
  protected readonly customFrom = signal(toDateInput(new Date(Date.now() - 30 * MS_PER_DAY)));
  protected readonly customTo = signal(toDateInput(new Date()));

  protected readonly busy = computed(() => this.loading() || this.refreshing());
  protected readonly today = computed(() => toDateInput(new Date()));

  private readonly palette = computed(() => chartPalette(this.theme.isDark()));
  private readonly chrome = computed(() => chartChrome(this.theme.isDark()));

  protected t = (key: TranslationKey, params?: Record<string, string | number>) => this.translate.t(key, params);

  protected readonly tabOptions = computed<TabOption[]>(() => [
    { id: 'overview', label: this.t('guild.tabs.overview') },
    { id: 'roster', label: this.t('guild.tabs.roster') },
    { id: 'economy', label: this.t('guild.tabs.economy') },
    { id: 'meta', label: this.t('guild.tabs.meta') },
    { id: 'leaderboards', label: this.t('guild.tabs.leaderboards') },
  ]);

  protected readonly periodOptions = computed<TabOption[]>(() => [
    { id: '7', label: this.t('guild.period.d7') },
    { id: '30', label: this.t('guild.period.d30') },
    { id: '90', label: this.t('guild.period.d90') },
    { id: 'custom', label: this.t('guild.period.custom'), icon: 'calendar' },
  ]);

  constructor() {
    void this.load();
  }

  protected onTabChange(id: string): void {
    this.tab.set(id as GuildTab);
  }

  /* ------------------------------ Loading ------------------------------ */

  protected onPeriodChange(id: string): void {
    this.period.set(id as PeriodId);
    void this.load();
  }

  protected onCustomFrom(event: Event): void {
    this.customFrom.set((event.target as HTMLInputElement).value);
    void this.load();
  }

  protected onCustomTo(event: Event): void {
    this.customTo.set((event.target as HTMLInputElement).value);
    void this.load();
  }

  private resolveRange(): { from: Date; to: Date } | null {
    const preset = this.period();
    if (preset === 'custom') {
      const rawFrom = this.customFrom();
      const rawTo = this.customTo();
      if (!rawFrom || !rawTo) {
        return null;
      }
      const from = new Date(`${rawFrom}T00:00:00`);
      const to = new Date(`${rawTo}T23:59:59`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return null;
      }
      return { from, to };
    }
    const to = new Date();
    const from = new Date(to.getTime() - PRESET_DAYS[preset] * MS_PER_DAY);
    return { from, to };
  }

  protected async load(): Promise<void> {
    const range = this.resolveRange();
    if (!range) {
      this.toasts.error(this.t('guild.period.invalid'));
      return;
    }
    const firstLoad = this.report() === null;
    this.loading.set(firstLoad);
    this.refreshing.set(!firstLoad);
    this.loadFailed.set(false);
    try {
      const report = await firstValueFrom(
        this.intel.report(range.from.toISOString(), range.to.toISOString()),
      );
      this.report.set(report);
    } catch {
      this.report.set(null);
      this.loadFailed.set(true);
      this.toasts.error(this.t('common.error'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  protected async refresh(): Promise<void> {
    const range = this.resolveRange();
    if (!range) {
      return;
    }
    this.refreshing.set(true);
    try {
      const report = await firstValueFrom(
        this.intel.refreshReport(range.from.toISOString(), range.to.toISOString()),
      );
      this.report.set(report);
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.refreshing.set(false);
    }
  }

  /* ------------------------------ Overview ------------------------------ */

  protected readonly overviewStats = computed<SummaryItem[]>(() => {
    const overview = this.report()?.overview;
    if (!overview) {
      return [];
    }
    return [
      {
        label: this.t('intel.record'),
        value: `${overview.wins} - ${overview.losses}`,
        hint: this.t('guild.overview.recordHint', {
          fights: this.formatNumber(overview.fights),
          rate: this.formatPercent(overview.win_rate),
        }),
        tone: overview.win_rate >= 50 ? 'success' : 'warning',
      },
      {
        label: this.t('intel.kd'),
        value: overview.kill_death_ratio.toFixed(2),
        hint: `${this.formatNumber(overview.kills)} / ${this.formatNumber(overview.deaths)}`,
        tone: overview.kill_death_ratio >= 1 ? 'success' : 'danger',
      },
      { label: this.t('battles.kill_fame'), value: this.formatCompact(overview.kill_fame) },
      { label: this.t('battles.silver_lost'), value: this.formatCompact(overview.silver_lost) },
      {
        label: this.t('intel.ipDelta'),
        value: this.formatSigned(overview.item_power_delta),
        hint: this.t('intel.ipDeltaSub'),
        tone: overview.item_power_delta >= 0 ? 'success' : 'danger',
      },
      { label: this.t('intel.streak'), value: this.formatNumber(overview.win_streak) },
    ];
  });

  protected readonly notableFights = computed<NotableFight[]>(() => {
    const overview = this.report()?.overview;
    if (!overview) {
      return [];
    }
    return [
      { key: 'best', label: this.t('intel.bestFight'), fight: overview.best_fight },
      { key: 'worst', label: this.t('intel.worstFight'), fight: overview.worst_fight },
    ].filter((entry): entry is NotableFight => entry.fight !== null);
  });

  protected readonly notableColumns: readonly DataTableColumn<NotableFight>[] = [
    { key: 'kind', label: 'guild.notable.kind', accessor: (e) => e.label },
    { key: 'opponent', label: 'battles.opponent', accessor: (e) => e.fight.opponent },
    { key: 'when', label: 'common.date', accessor: (e) => e.fight.started_at },
    { key: 'kills', label: 'battles.kills', accessor: (e) => e.fight.kills, align: 'right' },
    { key: 'deaths', label: 'battles.deaths', accessor: (e) => e.fight.deaths, align: 'right' },
    { key: 'kill_fame', label: 'battles.kill_fame', accessor: (e) => e.fight.kill_fame, align: 'right' },
  ];

  protected trackNotable = (row: NotableFight): string => row.key;

  protected readonly trendsChart = computed<ChartBuild>(() =>
    buildCombatTrendsChart(this.report()?.trends ?? [], this.palette(), this.chrome(), this.t),
  );

  protected readonly hoursChart = computed<ChartBuild>(() =>
    buildHoursActivityChart(this.report()?.hours ?? [], this.palette(), this.t),
  );

  protected readonly recentTimeline = computed<TimelineEntry[]>(() =>
    [...(this.report()?.timeline ?? [])].slice(-10).reverse(),
  );

  protected readonly timelineColumns: readonly DataTableColumn<TimelineEntry>[] = [
    { key: 'at', label: 'common.date', accessor: (e) => e.at },
    { key: 'kind', label: 'common.type', accessor: (e) => e.kind },
    { key: 'title', label: 'guild.timeline.item', accessor: (e) => e.title },
  ];

  protected trackTimeline = (row: TimelineEntry): string => row.at + row.title;

  protected timelineIcon(kind: TimelineEntry['kind']): IconName {
    switch (kind) {
      case 'battle':
        return 'shield';
      case 'event':
        return 'calendar';
      case 'scout':
        return 'scan';
    }
  }

  protected timelineKindLabel(kind: TimelineEntry['kind']): string {
    switch (kind) {
      case 'battle':
        return this.t('guild.timeline.kind.battle');
      case 'event':
        return this.t('guild.timeline.kind.event');
      case 'scout':
        return this.t('guild.timeline.kind.scout');
    }
  }

  /* ------------------------------ Roster ------------------------------ */

  protected readonly operationsStats = computed<SummaryItem[]>(() => {
    const ops = this.report()?.operations;
    if (!ops) {
      return [];
    }
    return [
      { label: this.t('intel.roster'), value: this.formatNumber(ops.roster) },
      { label: this.t('intel.officers'), value: this.formatNumber(ops.officers) },
      { label: this.t('leaderboards.tab.attendance'), value: this.formatNumber(ops.attendance) },
      {
        label: this.t('intel.fillRate'),
        value: this.formatPercent(ops.fill_rate),
        hint: `${this.formatNumber(ops.slots)} ${this.t('intel.seats')}`,
        tone: ops.fill_rate >= 80 ? 'success' : 'warning',
      },
      {
        label: this.t('guild.roster.ctaRate'),
        value: this.formatPercent(ops.cta_rate),
        hint: `${this.formatNumber(ops.call_to_arms)} ${this.t('events.call_to_arms')}`,
      },
    ];
  });

  protected readonly roleComparisonRows = computed<RoleComparisonRow[]>(() => {
    const ops = this.report()?.operations;
    if (!ops) {
      return [];
    }
    const names = new Set([...Object.keys(ops.role_need), ...Object.keys(ops.role_fill)]);
    return [...names]
      .map((name) => ({
        role: name.replace(/_/g, ' '),
        needed: ops.role_need[name] ?? 0,
        filled: ops.role_fill[name] ?? 0,
      }))
      .filter((row) => row.needed > 0 || row.filled > 0)
      .sort((a, b) => b.needed - a.needed);
  });

  protected readonly memberColumns: readonly DataTableColumn<ReportMemberRow>[] = [
    {
      key: 'username',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (m) => m.username,
      comparator: (a, b) => a.username.localeCompare(b.username),
    },
    { key: 'role', label: 'common.role', accessor: (m) => m.role },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (m) => m.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (m) => m.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      accessor: (m) => m.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
    {
      key: 'silver_lost',
      label: 'battles.silver_lost',
      sortable: true,
      accessor: (m) => m.silver_lost,
      comparator: (a, b) => a.silver_lost - b.silver_lost,
      align: 'right',
    },
    {
      key: 'fill_rate',
      label: 'intel.fillRate',
      sortable: true,
      accessor: (m) => m.fill_rate,
      comparator: (a, b) => a.fill_rate - b.fill_rate,
      align: 'right',
    },
    {
      key: 'siphoned',
      label: 'guild.roster.siphoned',
      sortable: true,
      accessor: (m) => m.siphoned,
      comparator: (a, b) => a.siphoned - b.siphoned,
      align: 'right',
    },
  ];

  protected trackMember = (row: ReportMemberRow): number => row.user_id;

  /* ------------------------------ Economy ------------------------------ */

  protected readonly economyStats = computed<SummaryItem[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    return [
      { label: this.t('intel.lootIn'), value: this.formatCompact(economy.loot_in) },
      {
        label: this.t('intel.outflow'),
        value: this.formatCompact(economy.outflow_total),
        hint: `${this.t('bank.finance.splitOutflow')} ${this.formatCompact(economy.outflow_splits)}`,
      },
      {
        label: this.t('intel.net'),
        value: this.formatSigned(economy.net),
        tone: economy.net >= 0 ? 'success' : 'danger',
      },
      {
        label: this.t('bank.finance.openLiability'),
        value: this.formatCompact(economy.bank_pending),
        tone: 'warning',
      },
      {
        label: this.t('intel.regears'),
        value: this.formatCompact(economy.regear_paid),
        hint: `${this.t('guild.economy.regearOpen')} ${this.formatCompact(economy.regear_open)}`,
      },
      {
        label: this.t('intel.splits'),
        value: this.formatCompact(economy.split_completed),
        hint: `${this.t('guild.economy.splitPending')} ${this.formatCompact(economy.split_pending)}`,
      },
    ];
  });

  protected readonly economyFlowChart = computed<ChartBuild>(() =>
    buildEconomyFlowChart(this.report()?.trends ?? [], this.palette(), this.chrome(), this.t),
  );

  protected readonly lossRegearChart = computed<ChartBuild>(() =>
    buildLossRegearChart(this.report()?.trends ?? [], this.palette(), this.t),
  );

  /* -------------------------------- Meta -------------------------------- */

  protected readonly ourMetaChart = computed<ChartBuild>(() =>
    buildHorizontalBarsChart(
      topWeaponRows(this.report()?.our_meta ?? [], this.t),
      this.palette().ally,
      [this.t('battles.weapon'), this.t('common.total')],
    ),
  );

  protected readonly enemyMetaChart = computed<ChartBuild>(() =>
    buildHorizontalBarsChart(
      topWeaponRows(this.report()?.enemy_meta ?? [], this.t),
      this.palette().enemy,
      [this.t('battles.weapon'), this.t('common.total')],
    ),
  );

  protected readonly compColumns: readonly DataTableColumn<ReportCompRow>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (c) => c.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    { key: 'seats', label: 'intel.seats', accessor: (c) => c.seats, align: 'right' },
    { key: 'events', label: 'intel.events', accessor: (c) => c.events, align: 'right' },
    {
      key: 'fights',
      label: 'intel.fights',
      sortable: true,
      accessor: (c) => c.fights,
      comparator: (a, b) => a.fights - b.fights,
      align: 'right',
    },
    {
      key: 'win_rate',
      label: 'events.detail.win_rate',
      sortable: true,
      accessor: (c) => c.win_rate,
      comparator: (a, b) => a.win_rate - b.win_rate,
      align: 'right',
    },
    {
      key: 'fill_rate',
      label: 'intel.fillRate',
      sortable: true,
      accessor: (c) => c.fill_rate,
      comparator: (a, b) => a.fill_rate - b.fill_rate,
      align: 'right',
    },
  ];

  protected trackComp = (row: ReportCompRow): number => row.comp_id;

  protected readonly enemyColumns: readonly DataTableColumn<ReportEnemyRow>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (e) => e.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    { key: 'opponent_guild_name', label: 'intel.enemy', searchable: true, accessor: (e) => e.opponent_guild_name },
    { key: 'category', label: 'common.category', accessor: (e) => e.category },
    { key: 'player_count', label: 'intel.players', accessor: (e) => e.player_count, align: 'right' },
    {
      key: 'threat_score',
      label: 'intel.threat',
      sortable: true,
      accessor: (e) => e.threat_score,
      comparator: (a, b) => a.threat_score - b.threat_score,
      align: 'right',
    },
    { key: 'record', label: 'intel.record', align: 'right' },
    {
      key: 'last_seen',
      label: 'intel.detail.lastSeen',
      sortable: true,
      accessor: (e) => e.last_seen,
      comparator: (a, b) => a.last_seen.localeCompare(b.last_seen),
    },
  ];

  protected trackEnemy = (row: ReportEnemyRow): number => row.scouted_comp_id;

  /* ---------------------------- Leaderboards ---------------------------- */

  protected readonly leaderboardCategories = computed<LeaderboardCategory[]>(() => {
    const board = this.report()?.leaderboards;
    if (!board) {
      return [];
    }
    return [
      { key: 'attendance', label: this.t('leaderboards.tab.attendance'), entries: board.attendance.slice(0, 5) },
      { key: 'kills', label: this.t('leaderboards.tab.kills'), entries: board.kills.slice(0, 5) },
      { key: 'deaths', label: this.t('battles.deaths'), entries: board.deaths.slice(0, 5) },
      { key: 'kill_fame', label: this.t('leaderboards.tab.killfame'), entries: board.kill_fame.slice(0, 5) },
      { key: 'death_fame', label: this.t('leaderboards.tab.deathfame'), entries: board.death_fame.slice(0, 5) },
      { key: 'silver_lost', label: this.t('leaderboards.tab.deaths'), entries: board.silver_lost.slice(0, 5) },
      { key: 'split_earnings', label: this.t('leaderboards.tab.payout'), entries: board.split_earnings.slice(0, 5) },
      { key: 'regear_silver', label: this.t('guild.leaderboard.regearSilver'), entries: board.regear_silver.slice(0, 5) },
      { key: 'siphoned', label: this.t('leaderboards.tab.siphoned'), entries: board.siphoned.slice(0, 5) },
    ];
  });

  /* ----------------------------- Formatting ----------------------------- */

  private getLocale(): string {
    return this.translate.locale();
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat(this.getLocale(), { maximumFractionDigits: 0 }).format(
      Number.isFinite(value) ? value : 0,
    );
  }

  protected formatCompact(value: number): string {
    return new Intl.NumberFormat(this.getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(
      Number.isFinite(value) ? value : 0,
    );
  }

  protected formatSigned(value: number): string {
    const formatted = this.formatCompact(Math.abs(value));
    if (value === 0) {
      return formatted;
    }
    return `${value > 0 ? '+' : '−'}${formatted}`;
  }

  protected formatPercent(value: number): string {
    return `${Math.round(value)}%`;
  }

  protected formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.getLocale(), { dateStyle: 'medium' }).format(date);
  }

  protected formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
}
