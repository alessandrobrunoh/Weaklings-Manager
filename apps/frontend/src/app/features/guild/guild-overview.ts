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
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

type GuildTab = 'overview' | 'roster' | 'economy' | 'meta' | 'leaderboards';
type PeriodId = '7' | '30' | '90' | 'custom';

const MS_PER_DAY = 86_400_000;
const PRESET_DAYS: Readonly<Record<Exclude<PeriodId, 'custom'>, number>> = { '7': 7, '30': 30, '90': 90 };

interface OverviewStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly icon?: IconName;
  readonly tone: 'default' | 'success' | 'warning' | 'danger';
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
 */
@Component({
  selector: 'app-guild-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Chart, DataTable, DataTableCell, ErrorState, Icon, Loading, PageHeader, PageStack, RouterLink, StatCard, ViewToggle],
  styles: `
    .guild-filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.625rem 0.75rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .guild-filters__group { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .guild-filters__window { color: var(--color-text-tertiary); font-size: 0.75rem; }
    .guild-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; }
    .guild-section { display: grid; gap: 0.75rem; }
    .guild-section__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
    .guild-section__title { margin: 0; color: var(--color-text); font-size: 0.9375rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
    .guild-section__sub { margin: 0; color: var(--color-text-tertiary); font-size: 0.75rem; }
    .guild-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
    .guild-card { min-inline-size: 0; padding: 1rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .guild-mini-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
    .guild-mini-card { padding: 0.875rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .guild-mini-card__title { margin: 0 0 0.375rem; color: var(--color-text-tertiary); font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
    .guild-mini-card__opponent { font-weight: 600; color: var(--color-text); }
    .guild-mini-card__row { display: flex; justify-content: space-between; margin-top: 0.375rem; font-size: 0.75rem; color: var(--color-text-secondary); }
    .guild-timeline { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
    .guild-timeline__row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.625rem; padding: 0.5rem 0.625rem; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); }
    .guild-timeline__icon { display: flex; align-items: center; justify-content: center; width: 1.75rem; height: 1.75rem; border-radius: 50%; background: var(--color-surface-2); color: var(--color-text-secondary); flex-shrink: 0; }
    .guild-timeline__title { font-size: 0.8125rem; font-weight: 500; color: var(--color-text); }
    .guild-timeline__detail { font-size: 0.6875rem; color: var(--color-text-tertiary); }
    .guild-timeline__at { font-size: 0.6875rem; color: var(--color-text-tertiary); white-space: nowrap; }
    .guild-note { margin: 0; padding: 0.625rem 0.75rem; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-tertiary); font-size: 0.75rem; line-height: 1.5; }
    .guild-chip-list { display: flex; flex-wrap: wrap; gap: 0.375rem; }
    .guild-role-table { width: 100%; border-collapse: collapse; }
    .guild-role-table th, .guild-role-table td { padding: 0.5rem 0.625rem; border-bottom: 1px solid var(--color-border); text-align: left; font-size: 0.75rem; }
    .guild-role-table th { color: var(--color-text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; font-size: 0.625rem; }
    .guild-role-table td.mono { text-align: right; }
    .guild-leaderboard-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
    .guild-leaderboard-card { padding: 0.875rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .guild-leaderboard-card__title { margin: 0 0 0.5rem; color: var(--color-text); font-size: 0.75rem; font-weight: 700; }
    .guild-leaderboard-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.25rem 0; font-size: 0.75rem; }
    .guild-leaderboard-row__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
    .guild-leaderboard-row__rank { color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.6875rem; margin-inline-end: 0.375rem; }
    @media (max-width: 72rem) {
      .guild-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .guild-chart-grid, .guild-mini-grid, .guild-leaderboard-grid { grid-template-columns: 1fr; }
    }
  `,
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (report(); as r) {
      <app-page-header [title]="t('guild.title')" [subtitle]="t('guild.subtitle')">
        <button type="button" class="btn btn--outline btn--sm" [disabled]="busy()" (click)="refresh()">
          <app-icon name="refresh" size="0.875rem" />
          {{ t('common.refreshNow') }}
        </button>
        <app-view-toggle pageTabs [options]="tabOptions()" [active]="tab()" (activeChange)="onTabChange($event)" />
      </app-page-header>

      <app-page-stack>
        <div class="guild-filters">
          <div class="guild-filters__group">
            <span class="eyebrow">{{ t('guild.period.label') }}</span>
            <app-view-toggle [options]="periodOptions()" [active]="period()" (activeChange)="onPeriodChange($event)" />
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
              <span aria-hidden="true" style="color: var(--color-text-tertiary)">→</span>
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
          <p class="guild-filters__window" aria-live="polite">
            <strong>{{ formatDate(r.from) }} → {{ formatDate(r.to) }}</strong>
          </p>
        </div>

        @switch (tab()) {
          @case ('overview') {
            <section class="guild-stat-grid" [attr.aria-label]="t('guild.tabs.overview')">
              @for (stat of overviewStats(); track stat.key) {
                <app-stat-card [label]="stat.label" [value]="stat.value" [sub]="stat.sub" [icon]="stat.icon" [tone]="stat.tone" />
              }
            </section>

            @if (notableFights().length > 0) {
              <div class="guild-mini-grid">
                @for (entry of notableFights(); track entry.label) {
                  <article class="guild-mini-card">
                    <p class="guild-mini-card__title">{{ entry.label }}</p>
                    <a class="guild-mini-card__opponent no-underline" [routerLink]="['/battles', entry.fight.battle_id]">
                      {{ entry.fight.opponent || t('intel.unknownOpponent') }}
                    </a>
                    <div class="guild-mini-card__row">
                      <span>{{ formatDateTime(entry.fight.started_at) }}</span>
                      <span class="mono">{{ entry.fight.kills }} / {{ entry.fight.deaths }} · {{ formatCompact(entry.fight.kill_fame) }}</span>
                    </div>
                  </article>
                }
              </div>
            }

            <div class="guild-chart-grid">
              <article class="guild-card">
                <header class="guild-section__head">
                  <div>
                    <h3 class="guild-section__title">{{ t('guild.charts.weeklyTrends') }}</h3>
                    <p class="guild-section__sub">{{ t('guild.charts.weeklyTrendsSub') }}</p>
                  </div>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>

              <article class="guild-card">
                <header class="guild-section__head">
                  <div>
                    <h3 class="guild-section__title">{{ t('guild.charts.hourly') }}</h3>
                    <p class="guild-section__sub">{{ t('intel.timingHint') }}</p>
                  </div>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>
            </div>

            <section class="guild-section">
              <header class="guild-section__head">
                <h3 class="guild-section__title">
                  <app-icon name="activity" size="0.9375rem" />
                  {{ t('guild.timeline.title') }}
                </h3>
              </header>
              @if (recentTimeline().length > 0) {
                <ul class="guild-timeline">
                  @for (entry of recentTimeline(); track entry.at + entry.title) {
                    <li class="guild-timeline__row">
                      <span class="guild-timeline__icon">
                        <app-icon [name]="timelineIcon(entry.kind)" size="0.875rem" />
                      </span>
                      <span>
                        <span class="guild-timeline__title">{{ entry.title }}</span>
                        @if (entry.detail) {
                          <br />
                          <span class="guild-timeline__detail">{{ entry.detail }}</span>
                        }
                      </span>
                      <span class="guild-timeline__at">{{ formatDateTime(entry.at) }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="guild-note">{{ t('common.empty') }}</p>
              }
            </section>

            <p class="guild-note">
              {{ t('guild.dataQuality.line', {
                attributed: r.data_quality.attributed_battles,
                total: r.data_quality.total_battles,
                unlinked: r.data_quality.unlinked_players.length
              }) }}
            </p>
          }

          @case ('roster') {
            <section class="guild-stat-grid" [attr.aria-label]="t('guild.tabs.roster')">
              @for (stat of operationsStats(); track stat.key) {
                <app-stat-card [label]="stat.label" [value]="stat.value" [sub]="stat.sub" [icon]="stat.icon" [tone]="stat.tone" />
              }
            </section>

            <div class="guild-chart-grid">
              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('intel.roleCoverage') }}</h3>
                </header>
                @if (roleComparisonRows().length > 0) {
                  <table class="guild-role-table">
                    <thead>
                      <tr>
                        <th scope="col">{{ t('common.role') }}</th>
                        <th scope="col">{{ t('guild.roster.roleNeeded') }}</th>
                        <th scope="col">{{ t('guild.roster.roleFilled') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of roleComparisonRows(); track row.role) {
                        <tr>
                          <td>{{ row.role }}</td>
                          <td class="mono">{{ row.needed }}</td>
                          <td class="mono" [class.text-warning]="row.filled < row.needed" [class.text-success]="row.filled >= row.needed">
                            {{ row.filled }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>

              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('guild.roster.inactive') }}</h3>
                </header>
                @if (r.operations.inactive_members.length > 0) {
                  <div class="guild-chip-list">
                    @for (name of r.operations.inactive_members; track name) {
                      <span class="chip chip--warning">{{ name }}</span>
                    }
                  </div>
                } @else {
                  <p class="guild-note">{{ t('intel.allActive') }}</p>
                }
              </article>
            </div>

            <section class="guild-section">
              <header class="guild-section__head">
                <h3 class="guild-section__title">{{ t('battles.guild_roster') }}</h3>
                <span class="text-xs text-secondary">{{ r.members.length }}</span>
              </header>
              <app-data-table
                [columns]="memberColumns"
                [rows]="r.members"
                [trackBy]="trackMember"
                [pageSize]="15"
              >
                <ng-template dataTableCell="username" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/users', row.user_id]">
                    {{ row.username }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="kill_fame" let-row>
                  <span class="mono text-warning">{{ formatCompact(row.kill_fame) }}</span>
                </ng-template>
                <ng-template dataTableCell="silver_lost" let-row>
                  <span class="mono">{{ formatCompact(row.silver_lost) }}</span>
                </ng-template>
                <ng-template dataTableCell="fill_rate" let-row>
                  <span class="mono">{{ formatPercent(row.fill_rate) }}</span>
                </ng-template>
                <ng-template dataTableCell="siphoned" let-row>
                  <span class="mono">{{ formatCompact(row.siphoned) }}</span>
                </ng-template>
              </app-data-table>
            </section>
          }

          @case ('economy') {
            <section class="guild-stat-grid" [attr.aria-label]="t('guild.tabs.economy')">
              @for (stat of economyStats(); track stat.key) {
                <app-stat-card [label]="stat.label" [value]="stat.value" [sub]="stat.sub" [icon]="stat.icon" [tone]="stat.tone" />
              }
            </section>

            <div class="guild-chart-grid">
              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('bank.finance.weeklyFlow') }}</h3>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>

              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('bank.finance.lossVsRegear') }}</h3>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>
            </div>

            <a class="btn btn--outline btn--sm no-underline" routerLink="/admin/finance">
              {{ t('guild.economy.fullDetail') }}
              <app-icon name="chevron-right" size="0.75rem" />
            </a>
          }

          @case ('meta') {
            <div class="guild-chart-grid">
              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('intel.ourMeta') }}</h3>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>

              <article class="guild-card">
                <header class="guild-section__head">
                  <h3 class="guild-section__title">{{ t('intel.enemyMeta') }}</h3>
                </header>
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
                  <p class="guild-note">{{ t('guild.charts.noData') }}</p>
                }
              </article>
            </div>

            <section class="guild-section">
              <header class="guild-section__head">
                <h3 class="guild-section__title">{{ t('intel.compPerformance') }}</h3>
              </header>
              <app-data-table [columns]="compColumns" [rows]="r.comps" [trackBy]="trackComp" [pageSize]="10">
                <ng-template dataTableCell="name" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/comps', row.comp_id]">
                    {{ row.name }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="win_rate" let-row>
                  <span class="mono">{{ formatPercent(row.win_rate) }}</span>
                </ng-template>
                <ng-template dataTableCell="fill_rate" let-row>
                  <span class="mono">{{ formatPercent(row.fill_rate) }}</span>
                </ng-template>
              </app-data-table>
            </section>

            <section class="guild-section">
              <header class="guild-section__head">
                <h3 class="guild-section__title">{{ t('intel.nav.enemies') }}</h3>
              </header>
              <app-data-table [columns]="enemyColumns" [rows]="r.enemies" [trackBy]="trackEnemy" [pageSize]="10">
                <ng-template dataTableCell="name" let-row>
                  <a class="no-underline font-medium" style="color: var(--color-text)" [routerLink]="['/intel', row.scouted_comp_id]">
                    {{ row.name }}
                  </a>
                </ng-template>
                <ng-template dataTableCell="record" let-row>
                  <span class="mono">{{ row.wins }} - {{ row.losses }}</span>
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
                <article class="guild-leaderboard-card">
                  <h3 class="guild-leaderboard-card__title">{{ category.label }}</h3>
                  @if (category.entries.length > 0) {
                    @for (entry of category.entries; track entry.user_id; let i = $index) {
                      <div class="guild-leaderboard-row">
                        <span class="guild-leaderboard-row__name">
                          <span class="guild-leaderboard-row__rank">#{{ i + 1 }}</span>{{ entry.username }}
                        </span>
                        <span class="mono">{{ formatCompact(entry.value) }}</span>
                      </div>
                    }
                  } @else {
                    <p class="guild-note">{{ t('leaderboards.empty') }}</p>
                  }
                </article>
              }
            </div>

            <a class="btn btn--outline btn--sm no-underline" routerLink="/season">
              {{ t('guild.leaderboard.fullStandings') }}
              <app-icon name="chevron-right" size="0.75rem" />
            </a>
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

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'overview', label: this.t('guild.tabs.overview') },
    { id: 'roster', label: this.t('guild.tabs.roster') },
    { id: 'economy', label: this.t('guild.tabs.economy') },
    { id: 'meta', label: this.t('guild.tabs.meta') },
    { id: 'leaderboards', label: this.t('guild.tabs.leaderboards') },
  ]);

  protected readonly periodOptions = computed<ViewToggleOption[]>(() => [
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

  protected readonly overviewStats = computed<OverviewStat[]>(() => {
    const overview = this.report()?.overview;
    if (!overview) {
      return [];
    }
    return [
      { key: 'fights', label: this.t('intel.fights'), value: this.formatNumber(overview.fights), tone: 'default', icon: 'swords' },
      {
        key: 'record',
        label: this.t('intel.record'),
        value: `${overview.wins} - ${overview.losses}`,
        sub: this.formatPercent(overview.win_rate) + ' ' + this.t('events.detail.win_rate'),
        tone: overview.win_rate >= 50 ? 'success' : 'warning',
        icon: 'shield',
      },
      {
        key: 'kd',
        label: this.t('intel.kd'),
        value: overview.kill_death_ratio.toFixed(2),
        sub: `${this.formatNumber(overview.kills)} / ${this.formatNumber(overview.deaths)}`,
        tone: overview.kill_death_ratio >= 1 ? 'success' : 'danger',
      },
      {
        key: 'kill_fame',
        label: this.t('battles.kill_fame'),
        value: this.formatCompact(overview.kill_fame),
        tone: 'default',
        icon: 'trophy',
      },
      {
        key: 'silver_lost',
        label: this.t('battles.silver_lost'),
        value: this.formatCompact(overview.silver_lost),
        tone: 'danger',
        icon: 'bank',
      },
      {
        key: 'ip_delta',
        label: this.t('intel.ipDelta'),
        value: this.formatSigned(overview.item_power_delta),
        sub: this.t('intel.ipDeltaSub'),
        tone: overview.item_power_delta >= 0 ? 'success' : 'danger',
      },
      {
        key: 'streak',
        label: this.t('intel.streak'),
        value: this.formatNumber(overview.win_streak),
        tone: overview.win_streak > 0 ? 'success' : 'default',
        icon: 'sparkles',
      },
      {
        key: 'attributed',
        label: this.t('intel.stat.coverage'),
        value: this.formatNumber(overview.attributed_fights),
        sub: this.t('intel.stat.coverageSub'),
        tone: 'default',
      },
    ];
  });

  protected readonly notableFights = computed(() => {
    const overview = this.report()?.overview;
    if (!overview) {
      return [];
    }
    return [
      { label: this.t('intel.bestFight'), fight: overview.best_fight },
      { label: this.t('intel.worstFight'), fight: overview.worst_fight },
    ].filter((entry): entry is { label: string; fight: NonNullable<typeof overview.best_fight> } => entry.fight !== null);
  });

  protected readonly trendsChart = computed<ChartBuild>(() =>
    buildCombatTrendsChart(this.report()?.trends ?? [], this.palette(), this.chrome(), this.t),
  );

  protected readonly hoursChart = computed<ChartBuild>(() =>
    buildHoursActivityChart(this.report()?.hours ?? [], this.palette(), this.t),
  );

  protected readonly recentTimeline = computed<TimelineEntry[]>(() =>
    [...(this.report()?.timeline ?? [])].slice(-10).reverse(),
  );

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

  /* ------------------------------ Roster ------------------------------ */

  protected readonly operationsStats = computed<OverviewStat[]>(() => {
    const ops = this.report()?.operations;
    if (!ops) {
      return [];
    }
    return [
      { key: 'roster', label: this.t('intel.roster'), value: this.formatNumber(ops.roster), tone: 'default', icon: 'users' },
      { key: 'officers', label: this.t('intel.officers'), value: this.formatNumber(ops.officers), tone: 'default' },
      {
        key: 'attendance',
        label: this.t('leaderboards.tab.attendance'),
        value: this.formatNumber(ops.attendance),
        tone: 'default',
      },
      {
        key: 'fill_rate',
        label: this.t('intel.fillRate'),
        value: this.formatPercent(ops.fill_rate),
        sub: `${ops.slots} ${this.t('intel.seats')}`,
        tone: ops.fill_rate >= 80 ? 'success' : 'warning',
      },
      {
        key: 'cta_rate',
        label: this.t('guild.roster.ctaRate'),
        value: this.formatPercent(ops.cta_rate),
        sub: `${ops.call_to_arms} ${this.t('events.call_to_arms')}`,
        tone: 'default',
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

  protected readonly economyStats = computed<OverviewStat[]>(() => {
    const economy = this.report()?.economy;
    if (!economy) {
      return [];
    }
    return [
      { key: 'loot_in', label: this.t('intel.lootIn'), value: this.formatCompact(economy.loot_in), tone: 'success' },
      {
        key: 'outflow',
        label: this.t('intel.outflow'),
        value: this.formatCompact(economy.outflow_total),
        sub: this.t('bank.finance.splitOutflow') + ` ${this.formatCompact(economy.outflow_splits)} · ` +
          this.t('bank.finance.regearPaid') + ` ${this.formatCompact(economy.outflow_regear)}`,
        tone: 'default',
      },
      {
        key: 'net',
        label: this.t('intel.net'),
        value: this.formatSigned(economy.net),
        tone: economy.net >= 0 ? 'success' : 'danger',
      },
      {
        key: 'bank_pending',
        label: this.t('bank.finance.openLiability'),
        value: this.formatCompact(economy.bank_pending),
        tone: 'warning',
      },
      {
        key: 'regear',
        label: this.t('intel.regears'),
        value: this.formatCompact(economy.regear_paid),
        sub: `${this.t('guild.economy.regearOpen')} ${this.formatCompact(economy.regear_open)}`,
        tone: 'default',
      },
      {
        key: 'splits',
        label: this.t('intel.splits'),
        value: this.formatCompact(economy.split_completed),
        sub: `${this.t('guild.economy.splitPending')} ${this.formatCompact(economy.split_pending)}`,
        tone: 'default',
      },
      {
        key: 'siphoned',
        label: this.t('bank.finance.siphonedNet'),
        value: this.formatCompact(economy.siphoned_net),
        tone: 'default',
      },
      {
        key: 'fame_efficiency',
        label: this.t('intel.famePerMillion'),
        value: this.formatCompact(economy.fame_per_million_lost),
        sub: this.t('intel.famePerMillionSub'),
        tone: 'default',
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
    const lang = this.translate.language();
    if (lang === 'it') return 'it-IT';
    if (lang === 'es') return 'es-ES';
    return 'en-US';
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
