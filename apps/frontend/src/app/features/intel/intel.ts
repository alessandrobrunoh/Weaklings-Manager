import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/services/api.service';
import { IntelService } from '../../core/services/intel.service';
import type { ScoutListParams } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import type {
  FightTrendView,
  GuildReport,
  MatchupReport,
  ScoutedCompSummary,
  TrendBucket,
} from '../../core/models/api.models';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Meter } from '../../shared/components/meter/meter';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

type MatchupRow = NonNullable<MatchupReport>['rows'][number];
type RosterRow = NonNullable<GuildReport>['members'][number];

/** Default page size for the scout library table. */
const SCOUT_PAGE_LIMIT = 25;

/**
 * Enemy intel: the scouted-composition library and the matchup matrix.
 * Streamlined into 4 intuitive workspaces:
 * - Overview: Executive combat health, KPIs, notable battles, and 24h activity.
 * - Matchups: Comp vs Comp win matrix, weapon meta analysis, and weekly trends.
 * - Enemy Scouts: Full scout library with threat scoring, weapon coverage, and filters.
 * - Operations: Guild roster performance, role fill rates, and economic flow.
 */
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

@Component({
  selector: 'app-intel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    DataTable,
    DataTableCell,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    Meter,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
    StatusChip,
    TooltipDirective,
    ViewToggle,
  ],
  styles: `
    .intel-trend-chart { min-inline-size: 0; }
    .intel-trend-chart__header { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 0.5rem 1rem; }
    .intel-trend-chart__title { margin: 0; color: var(--color-text); font-size: 0.875rem; font-weight: 600; }
    .intel-trend-chart__note, .intel-trend-chart__sample { margin: 0.2rem 0 0; color: var(--color-text-secondary); font-size: 0.75rem; line-height: 1.45; }
    .intel-trend-chart__sample { color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.6875rem; white-space: nowrap; }
    .intel-trend-chart__bars { display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); align-items: end; gap: 0.2rem; block-size: 8rem; margin-block: 1rem 0; padding-block: 0.35rem; border-block-end: 1px solid var(--color-border-strong); }
    .intel-trend-chart__bar { display: block; min-block-size: 2px; border-radius: 2px 2px 0 0; background-color: var(--color-primary); opacity: 0.8; }
    .intel-trend-chart__axis { display: flex; justify-content: space-between; margin-block-start: 0.4rem; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 0.6875rem; }
    .intel-trend-chart__data { margin-block-start: 0.875rem; color: var(--color-text-secondary); font-size: 0.75rem; }
    .intel-trend-chart__data summary { inline-size: fit-content; cursor: pointer; }
    .intel-trend-chart__data summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
    .intel-trend-chart__table { inline-size: 100%; margin-block-start: 0.625rem; border-collapse: collapse; font-size: 0.75rem; }
    .intel-trend-chart__table th, .intel-trend-chart__table td { padding: 0.375rem 0.5rem; border-block-end: 1px solid var(--color-border); text-align: end; }
    .intel-trend-chart__table th:first-child, .intel-trend-chart__table td:first-child { text-align: start; }
    @media (max-width: 32rem) { .intel-trend-chart__bars { gap: 0.1rem; } .intel-trend-chart__sample { white-space: normal; } }
  `,
  template: `
    <app-page-header [title]="t('intel.title')" [subtitle]="t('intel.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="load()"
        [appTooltip]="'Aggiorna dati di intelligence e report'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      <app-view-toggle
        pageTabs
        [options]="tabs()"
        [active]="tab()"
        (activeChange)="onTabChange($event)"
      />
    </app-page-header>

    @if (loading()) {
      <app-loading />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else {
      <app-page-stack>
        <!-- Top KPI headline strip -->
        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Intel summary">
          <app-stat-card
            [label]="t('intel.stat.scouts')"
            [value]="headlineTotal().toString()"
            icon="search"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('intel.stat.topThreat')"
            [value]="topThreat()?.opponent_guild_name ?? '—'"
            [sub]="topThreat() ? t('intel.stat.threatScore') + ' ' + topThreat()!.threat_score : ''"
            icon="alert"
            tone="danger"
          />
          <app-stat-card
            [label]="t('intel.stat.record')"
            [value]="recordLabel()"
            [sub]="t('intel.stat.acrossFights')"
            icon="swords"
            [tone]="recordTone()"
          />
          <app-stat-card
            [label]="t('intel.stat.coverage')"
            [value]="coverageLabel()"
            [sub]="t('intel.stat.coverageSub')"
            icon="shield"
            [tone]="coverageTone()"
          />
        </section>

        @switch (tab()) {
          @case ('overview') {
            @if (report(); as r) {
              <!-- Performance Cards + Notable Battles -->
              <div class="grid gap-4 lg:grid-cols-2">
                <section class="card p-5">
                  <h2 class="eyebrow mb-4">{{ t('intel.tab.performance') }}</h2>
                  <div class="grid grid-cols-2 gap-3">
                    <app-stat-card
                      [label]="t('intel.winRate')"
                      [value]="(r.overview.win_rate | number: '1.0-0') + '%'"
                      [sub]="r.overview.wins + '–' + r.overview.losses"
                      [tone]="r.overview.win_rate >= 50 ? 'success' : 'danger'"
                    />
                    <app-stat-card
                      [label]="'K/D'"
                      [value]="r.overview.kill_death_ratio | number: '1.2-2'"
                      [sub]="r.overview.kills + ' / ' + r.overview.deaths"
                    />
                    <app-stat-card
                      [label]="t('intel.streak')"
                      [value]="r.overview.win_streak.toString()"
                      [tone]="r.overview.win_streak > 0 ? 'success' : 'neutral'"
                    />
                    <app-stat-card
                      [label]="t('intel.ipDelta')"
                      [value]="(r.overview.item_power_delta > 0 ? '+' : '') + (r.overview.item_power_delta | number: '1.0-0')"
                      [sub]="t('intel.ipDeltaSub')"
                      [tone]="r.overview.item_power_delta >= 0 ? 'success' : 'warning'"
                    />
                  </div>
                </section>

                <section class="card p-5">
                  <h2 class="eyebrow mb-4">{{ t('intel.tab.notableFights') }}</h2>
                  <div class="flex flex-col gap-3">
                    @for (fight of notableFights(); track fight.label) {
                      @if (fight.data; as f) {
                        <a
                          class="flex items-center justify-between rounded-xl p-3.5 no-underline transition-colors hover:opacity-90"
                          [style.background-color]="f.is_win ? 'var(--color-success-container)' : 'var(--color-error-container)'"
                          [routerLink]="['/battles', f.battle_id]"
                        >
                          <div>
                            <span class="eyebrow text-xs font-semibold" [style.color]="f.is_win ? 'var(--color-success)' : 'var(--color-error)'">
                              {{ fight.label }} · {{ f.is_win ? t('common.win') : t('common.loss') }}
                            </span>
                            <span class="mt-1 block text-sm font-medium" style="color: var(--color-text)">
                              {{ f.opponent ?? t('intel.unknownOpponent') }}
                            </span>
                          </div>
                          <div class="text-right">
                            <span class="mono text-sm font-medium" style="color: var(--color-text)">
                              {{ f.kills }}k / {{ f.deaths }}d
                            </span>
                          </div>
                        </a>
                      }
                    }
                    @if (!r.overview.best_fight && !r.overview.worst_fight) {
                      <p class="text-sm" style="color: var(--color-text-secondary)">
                        {{ t('common.empty') }}
                      </p>
                    }
                  </div>
                </section>

                <section class="card p-5 lg:col-span-2" aria-labelledby="intel-performance-evidence-heading">
                  <div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div>
                      <h2 class="eyebrow" id="intel-performance-evidence-heading">{{ t('intel.performanceEvidence') }}</h2>
                      <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                        {{ t('intel.performanceEvidenceHint') }}
                      </p>
                    </div>
                    <p class="mono text-[11px]" style="color: var(--color-text-tertiary)">
                      {{ t('intel.reportWindow') }} {{ r.from | date: 'mediumDate' }}–{{ r.to | date: 'mediumDate' }}
                    </p>
                  </div>

                  <div class="grid gap-3 lg:grid-cols-3">
                    <section class="rounded-lg border p-3" style="border-color: var(--color-border); background-color: var(--color-surface-2)" aria-labelledby="intel-player-performance-heading">
                      <h3 class="text-sm font-medium" id="intel-player-performance-heading" style="color: var(--color-text)">{{ t('intel.playerPerformance') }}</h3>
                      <p class="mt-1 text-[11px]" style="color: var(--color-text-secondary)">
                        {{ playerCoverageLabel(r) }}
                      </p>
                      @if (topPlayers().length > 0) {
                        <ol class="mt-3 divide-y" style="border-color: var(--color-border)">
                          @for (player of topPlayers(); track player.user_id) {
                            <li class="flex items-center justify-between gap-3 py-2 first:pt-0">
                              <span class="min-w-0 truncate text-sm" style="color: var(--color-text)">{{ player.username }}</span>
                              <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                                {{ player.fights }} {{ t('intel.fights') }} · {{ player.kill_death_ratio | number: '1.1-2' }} K/D
                              </span>
                            </li>
                          }
                        </ol>
                      } @else {
                        <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.playerPerformanceUnavailable') }}</p>
                      }
                    </section>

                    <section class="rounded-lg border p-3" style="border-color: var(--color-border); background-color: var(--color-surface-2)" aria-labelledby="intel-comp-performance-heading">
                      <h3 class="text-sm font-medium" id="intel-comp-performance-heading" style="color: var(--color-text)">{{ t('intel.compPerformance') }}</h3>
                      <p class="mt-1 text-[11px]" style="color: var(--color-text-secondary)">
                        {{ compCoverageLabel(r) }}
                      </p>
                      @if (topComps().length > 0) {
                        <ol class="mt-3 divide-y" style="border-color: var(--color-border)">
                          @for (comp of topComps(); track comp.comp_id) {
                            <li class="flex items-center justify-between gap-3 py-2 first:pt-0">
                              <a class="min-w-0 truncate text-sm no-underline hover:underline" [routerLink]="['/comps', comp.comp_id]" style="color: var(--color-text)">{{ comp.name }}</a>
                              <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                                {{ comp.wins }}–{{ comp.losses }} · {{ comp.win_rate | number: '1.0-0' }}%
                              </span>
                            </li>
                          }
                        </ol>
                      } @else {
                        <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.compPerformanceUnavailable') }}</p>
                      }
                    </section>

                    <section class="rounded-lg border p-3" style="border-color: var(--color-border); background-color: var(--color-surface-2)" aria-labelledby="intel-build-performance-heading">
                      <h3 class="text-sm font-medium" id="intel-build-performance-heading" style="color: var(--color-text)">{{ t('intel.buildPerformance') }}</h3>
                      <p class="mt-1 text-[11px]" style="color: var(--color-text-secondary)">
                        {{ t('intel.buildPerformanceUnavailable') }}
                      </p>
                      @if (plannedBuilds().length > 0) {
                        <ol class="mt-3 divide-y" style="border-color: var(--color-border)">
                          @for (build of plannedBuilds(); track build.id) {
                            <li class="flex items-center justify-between gap-3 py-2 first:pt-0">
                              <span class="min-w-0 truncate text-sm" style="color: var(--color-text)">{{ build.name }}</span>
                              <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">{{ build.count }} {{ t('intel.assignments') }}</span>
                            </li>
                          }
                        </ol>
                        <p class="mt-3 text-[11px]" style="color: var(--color-text-tertiary)">{{ buildCoverageLabel() }}</p>
                      } @else {
                        <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">{{ t('intel.buildCoverageUnavailable') }}</p>
                      }
                    </section>
                  </div>
                </section>

                @if (fightTrends(); as trends) {
                  <section class="card p-5 lg:col-span-2 intel-trend-chart" aria-labelledby="intel-fight-pulse-heading">
                    <div class="intel-trend-chart__header">
                      <div>
                        <h2 class="intel-trend-chart__title" id="intel-fight-pulse-heading">30-day fight pulse</h2>
                        <p class="intel-trend-chart__note">Daily canonical fights. Quiet days are included so gaps do not look like missing data.</p>
                      </div>
                      <p class="intel-trend-chart__sample">{{ fightTrendSampleLabel(trends) }}</p>
                    </div>
                    <figure class="mt-1" aria-describedby="intel-fight-pulse-description">
                      <figcaption class="sr-only" id="intel-fight-pulse-description">
                        {{ fightTrendDescription(trends) }} Exact daily values are available in the table below.
                      </figcaption>
                      <div class="intel-trend-chart__bars" aria-hidden="true">
                        @for (day of trends.rolling_daily_fight_counts; track day.date) {
                          <span class="intel-trend-chart__bar" [style.height.%]="dailyFightBarHeight(day.fights)"></span>
                        }
                      </div>
                      <div class="intel-trend-chart__axis" aria-hidden="true">
                        <span>{{ trends.rolling_daily_fight_counts[0]?.date | date: 'MMM d' }}</span>
                        <span>{{ trends.rolling_daily_fight_counts[trends.rolling_daily_fight_counts.length - 1]?.date | date: 'MMM d' }}</span>
                      </div>
                    </figure>
                    <details class="intel-trend-chart__data">
                      <summary>View daily fight counts as a table</summary>
                      <table class="intel-trend-chart__table">
                        <caption class="sr-only">Canonical fights for each day in the 30-day trend</caption>
                        <thead><tr><th scope="col">UTC date</th><th scope="col">Fights</th></tr></thead>
                        <tbody>
                          @for (day of trends.rolling_daily_fight_counts; track day.date) {
                            <tr><td>{{ day.date | date: 'MMM d, y' }}</td><td class="mono">{{ day.fights }}</td></tr>
                          }
                        </tbody>
                      </table>
                    </details>
                  </section>
                }

                <!-- Activity by hour of day -->
                <section class="card p-5 lg:col-span-2">
                  <div class="flex items-center justify-between mb-3">
                    <div>
                      <h2 class="eyebrow">{{ t('intel.tab.timing') }}</h2>
                      <p class="text-xs mt-0.5" style="color: var(--color-text-secondary)">{{ t('intel.timingHint') }}</p>
                    </div>
                  </div>
                  <div class="flex h-36 items-end gap-1 pt-4">
                    @for (bucket of r.hours; track bucket.hour) {
                      <button
                        type="button"
                        class="flex flex-1 flex-col justify-end gap-0.5 border-0 bg-transparent p-0 cursor-pointer group"
                        [title]="bucket.hour + ':00 — ' + bucket.wins + 'W ' + bucket.losses + 'L'"
                        [attr.aria-label]="bucket.hour + ':00 — ' + bucket.wins + ' ' + t('common.win') + ', ' + bucket.losses + ' ' + t('common.loss')"
                      >
                        <span
                          class="w-full rounded-t-sm transition-opacity group-hover:opacity-80"
                          style="background-color: var(--color-success)"
                          [style.height.px]="barHeight(bucket.wins)"
                        ></span>
                        <span
                          class="w-full transition-opacity group-hover:opacity-80"
                          style="background-color: var(--color-error)"
                          [style.height.px]="barHeight(bucket.losses)"
                        ></span>
                      </button>
                    }
                  </div>
                  <div class="mt-2 flex justify-between text-[11px] mono" style="color: var(--color-text-secondary)">
                    <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
                  </div>
                </section>

                <!-- Activity Timeline -->
                <section class="card p-5 lg:col-span-2">
                  <h2 class="eyebrow mb-3">{{ t('intel.tab.timeline') }}</h2>
                  <div class="divide-y divide-(--color-border)">
                    @for (entry of r.timeline; track entry.at + entry.title) {
                      <div class="flex items-baseline gap-3 py-2.5">
                        <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                          {{ entry.at | date: 'MMM d, HH:mm' }}
                        </span>
                        <div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-2">
                          <span class="text-sm font-medium" style="color: var(--color-text)">{{ entry.title }}</span>
                          <span class="text-xs" style="color: var(--color-text-secondary)">{{ entry.detail }}</span>
                        </div>
                      </div>
                    }
                  </div>
                </section>
              </div>
            } @else {
              <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" [hint]="t('intel.reportUnavailableHint')" />
            }
          }

          @case ('matchups') {
            <!-- Matchup Matrix DataTable -->
            <div class="space-y-6">
              <section>
                <div class="mb-2">
                  <h2 class="text-lg font-semibold" style="color: var(--color-text)">{{ t('intel.nav.matchups') }}</h2>
                  <p class="text-xs" style="color: var(--color-text-secondary)">{{ matchupCoverageLabel() }}</p>
                </div>
                <app-data-table
                  [columns]="matchupColumns()"
                  [rows]="matchupRows()"
                  [trackBy]="trackMatchup"
                  [hidePageSize]="false"
                  emptyIcon="swords"
                  [emptyLabel]="'intel.noMatchups'"
                >
                  <ng-template dataTableCell="our_comp" let-row>
                    <a class="font-medium no-underline hover:underline" [routerLink]="['/comps', row.our_comp_id]" style="color: var(--color-text)">
                      {{ row.our_comp_name }}
                    </a>
                  </ng-template>
                  <ng-template dataTableCell="enemy" let-row>
                    <a class="no-underline hover:underline text-sm" [routerLink]="['/intel', row.scouted_comp_id]" style="color: var(--color-text-secondary)">
                      {{ scoutName(row.scouted_comp_id) }}
                    </a>
                  </ng-template>
                  <ng-template dataTableCell="record" let-row>
                    <span class="mono">
                      <span style="color: var(--color-success)">{{ row.wins }}</span>
                      <span class="opacity-40">/</span>
                      <span style="color: var(--color-error)">{{ row.losses }}</span>
                    </span>
                  </ng-template>
                  <ng-template dataTableCell="win_rate" let-row>
                    @let totalFights = row.wins + row.losses;
                    @let wr = totalFights > 0 ? (row.wins / totalFights) * 100 : 0;
                    <app-meter
                      [label]="''"
                      [value]="row.wins"
                      [max]="totalFights || 1"
                      [display]="(wr | number: '1.0-0') + '%'"
                      [tone]="wr >= 50 ? 'success' : 'danger'"
                    />
                  </ng-template>
                </app-data-table>
              </section>

              <!-- Meta Weapon Breakdown -->
              @if (report(); as r) {
                <div class="grid gap-4 lg:grid-cols-2">
                  <section class="card p-5">
                    <h3 class="eyebrow mb-3">{{ t('intel.ourMeta') }}</h3>
                    @if (r.our_meta.length === 0) {
                      <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
                    } @else {
                      <div class="space-y-2">
                        @for (w of r.our_meta; track w.weapon) {
                          <app-meter
                            [label]="prettyWeapon(w.weapon)"
                            [value]="w.count"
                            [max]="r.our_meta[0].count"
                            [display]="w.count.toString()"
                            tone="primary"
                          />
                        }
                      </div>
                    }
                  </section>

                  <section class="card p-5">
                    <h3 class="eyebrow mb-3">{{ t('intel.enemyMeta') }}</h3>
                    @if (r.enemy_meta.length === 0) {
                      <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
                    } @else {
                      <div class="space-y-2">
                        @for (w of r.enemy_meta; track w.weapon) {
                          <app-meter
                            [label]="prettyWeapon(w.weapon)"
                            [value]="w.count"
                            [max]="r.enemy_meta[0].count"
                            [display]="w.count.toString()"
                            tone="danger"
                          />
                        }
                      </div>
                    }
                  </section>
                </div>

                <!-- Weekly Performance Trends -->
                <section class="space-y-3">
                  <div>
                    <h3 class="text-base font-semibold" style="color: var(--color-text)">{{ t('intel.nav.trends') }}</h3>
                  </div>
                  <app-data-table
                    [columns]="trendsColumns()"
                    [rows]="r.trends"
                    [trackBy]="trackTrend"
                    [hideSearch]="true"
                    emptyIcon="chart"
                  >
                    <ng-template dataTableCell="week_start" let-row>
                      <span class="mono">{{ row.week_start | date: 'mediumDate' }}</span>
                    </ng-template>
                    <ng-template dataTableCell="record" let-row>
                      <span class="mono">
                        <span style="color: var(--color-success)">{{ row.wins }}</span>
                        <span class="opacity-40">/</span>
                        <span style="color: var(--color-error)">{{ row.losses }}</span>
                      </span>
                    </ng-template>
                    <ng-template dataTableCell="win_rate" let-row>
                      <app-meter
                        [label]="''"
                        [value]="row.wins"
                        [max]="row.fights || 1"
                        [display]="weekWinRate(row) + '%'"
                        [tone]="weekWinRate(row) >= 50 ? 'success' : 'danger'"
                      />
                    </ng-template>
                    <ng-template dataTableCell="net" let-row>
                      <span class="mono" [style.color]="weekNet(row) >= 0 ? 'var(--color-success)' : 'var(--color-error)'">
                        {{ weekNet(row) | number: '1.0-0' }}
                      </span>
                    </ng-template>
                  </app-data-table>

                  @if (weekOverWeek(); as delta) {
                    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4 pt-2">
                      <app-stat-card
                        [label]="t('intel.trends.winRateDelta')"
                        [value]="formatDelta(delta.winRate) + 'pp'"
                        [tone]="delta.winRate >= 0 ? 'success' : 'danger'"
                      />
                      <app-stat-card
                        [label]="t('intel.trends.attendanceDelta')"
                        [value]="formatDelta(delta.attendance)"
                        [tone]="delta.attendance >= 0 ? 'success' : 'danger'"
                      />
                      <app-stat-card
                        [label]="t('intel.trends.netDelta')"
                        [value]="formatDelta(delta.net)"
                        [tone]="delta.net >= 0 ? 'success' : 'danger'"
                      />
                      <app-stat-card
                        [label]="t('intel.trends.fightsDelta')"
                        [value]="formatDelta(delta.fights)"
                        [tone]="delta.fights >= 0 ? 'success' : 'danger'"
                      />
                    </div>
                  }
                </section>
              }
            </div>
          }

          @case ('scouts') {
            <!-- Enemy Scout Library DataTable -->
            <app-data-table
              [columns]="libraryColumns()"
              [rows]="scouts()"
              [loading]="libraryLoading()"
              [error]="libraryFailed()"
              (retry)="reloadLibrary()"
              [trackBy]="trackScout"
              [pageSize]="SCOUT_PAGE_LIMIT"
              [serverMode]="true"
              [totalItems]="libraryTotal()"
              emptyIcon="search"
              [emptyLabel]="libraryEmptyLabel"
              [rowClickable]="true"
              (rowClick)="openScout($event)"
              (pageChange)="onLibraryPageChange($event)"
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
                <span class="mono">{{ row.avg_ip | number: '1.0-0' }}</span>
              </ng-template>
              <ng-template dataTableCell="threat" let-row>
                <span class="mono font-semibold" style="color: var(--color-error)">{{ row.threat_score }}</span>
              </ng-template>
              <ng-template dataTableCell="battles" let-row>
                <span class="mono">{{ row.source_battle_count }}</span>
              </ng-template>
              <ng-template dataTableCell="saved_at" let-row>
                <span class="text-sm" style="color: var(--color-text-secondary)">{{ row.saved_at | date: 'short' }}</span>
              </ng-template>
              <ng-template dataTableCell="coverage" let-row>
                @if (!row.full_weapon_coverage) {
                  <span
                    class="chip chip--warning text-[11px]"
                    [title]="t('intel.partialCoverageHint')"
                  >
                    {{ row.weapon_sample_size }}/{{ row.player_count }}
                  </span>
                }
              </ng-template>
            </app-data-table>
          }

          @case ('operations') {
            @if (report(); as r) {
              <div class="space-y-6">
                <!-- Operations Stats Strip -->
                <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <app-stat-card [label]="t('intel.roster')" [value]="r.operations.roster.toString()" icon="users" />
                  <app-stat-card [label]="t('intel.officers')" [value]="r.operations.officers.toString()" icon="shield" />
                  <app-stat-card
                    [label]="t('intel.unlinked')"
                    [value]="r.operations.unlinked.toString()"
                    icon="alert"
                    [tone]="r.operations.unlinked > 0 ? 'warning' : 'success'"
                  />
                  <app-stat-card
                    [label]="t('intel.fillRate')"
                    [value]="(r.operations.fill_rate | number: '1.0-0') + '%'"
                    [sub]="r.operations.attendance + ' / ' + r.operations.slots"
                    icon="chart"
                  />
                </section>

                <!-- Role coverage + Inactive members -->
                <div class="grid gap-4 lg:grid-cols-2">
                  <section class="card p-5">
                    <h2 class="eyebrow mb-3">{{ t('intel.roleCoverage') }}</h2>
                    <div class="space-y-2.5">
                      @for (role of roleCoverage(); track role.name) {
                        <app-meter
                          [label]="role.name"
                          [value]="role.filled"
                          [max]="role.needed || 1"
                          [display]="role.filled + ' / ' + role.needed"
                          [tone]="role.filled >= role.needed ? 'success' : 'danger'"
                        />
                      }
                    </div>
                  </section>

                  <section class="card p-5">
                    <h2 class="eyebrow mb-3">{{ t('intel.inactive') }}</h2>
                    @if (r.operations.inactive_members.length === 0) {
                      <p class="text-sm" style="color: var(--color-success)">{{ t('intel.allActive') }}</p>
                    } @else {
                      <div class="flex flex-wrap gap-1.5">
                        @for (m of r.operations.inactive_members; track m) {
                          <span class="chip chip--warning text-xs">{{ m }}</span>
                        }
                      </div>
                    }
                  </section>
                </div>

                <!-- Economy Overview Strip -->
                <section class="space-y-3">
                  <h3 class="text-base font-semibold" style="color: var(--color-text)">{{ t('intel.nav.economy') }}</h3>
                  <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <app-stat-card
                      [label]="t('intel.lootIn')"
                      [value]="r.economy.loot_in | number: '1.0-0'"
                      icon="bank"
                      tone="success"
                    />
                    <app-stat-card
                      [label]="t('intel.outflow')"
                      [value]="r.economy.outflow_total | number: '1.0-0'"
                      icon="bank"
                      tone="warning"
                    />
                    <app-stat-card
                      [label]="t('intel.net')"
                      [value]="r.economy.net | number: '1.0-0'"
                      icon="chart"
                      [tone]="r.economy.net >= 0 ? 'success' : 'danger'"
                    />
                    <app-stat-card
                      [label]="t('intel.famePerMillion')"
                      [value]="r.economy.fame_per_million_lost | number: '1.0-0'"
                      [sub]="t('intel.famePerMillionSub')"
                      icon="sparkles"
                    />
                  </div>
                  <div class="card p-5">
                    <h4 class="eyebrow mb-2">{{ t('intel.outflowBreakdown') }}</h4>
                    <p class="text-xs mb-3" style="color: var(--color-text-secondary)">{{ t('intel.outflowHint') }}</p>
                    <div class="space-y-2.5">
                      <app-meter
                        [label]="t('intel.splits')"
                        [value]="r.economy.outflow_splits"
                        [max]="r.economy.outflow_total || 1"
                        [display]="(r.economy.outflow_splits | number: '1.0-0') ?? '0'"
                      />
                      <app-meter
                        [label]="t('intel.regears')"
                        [value]="r.economy.outflow_regear"
                        [max]="r.economy.outflow_total || 1"
                        [display]="(r.economy.outflow_regear | number: '1.0-0') ?? '0'"
                        tone="danger"
                      />
                      <app-meter
                        [label]="t('intel.other')"
                        [value]="r.economy.outflow_other"
                        [max]="r.economy.outflow_total || 1"
                        [display]="(r.economy.outflow_other | number: '1.0-0') ?? '0'"
                        tone="neutral"
                      />
                    </div>
                  </div>
                </section>

                <!-- Combat Member Roster DataTable -->
                <section class="space-y-3">
                  <h3 class="text-base font-semibold" style="color: var(--color-text)">{{ t('intel.nav.roster') }}</h3>
                  <app-data-table
                    [columns]="rosterColumns()"
                    [rows]="r.members"
                    [trackBy]="trackMember"
                    emptyIcon="users"
                  >
                    <ng-template dataTableCell="username" let-row>
                      <div class="flex items-center gap-2">
                        <span class="font-medium">{{ row.username }}</span>
                        @if (!row.linked) {
                          <span class="chip chip--warning text-[10px]">{{ t('intel.notLinked') }}</span>
                        }
                      </div>
                    </ng-template>
                    <ng-template dataTableCell="silver_lost" let-row>
                      <span class="mono">{{ row.silver_lost | number: '1.0-0' }}</span>
                    </ng-template>
                  </app-data-table>
                </section>
              </div>
            } @else {
              <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
            }
          }
        }
      </app-page-stack>
    }
  `,
})
export class Intel {
  private readonly api = inject(ApiService);
  private readonly intel = inject(IntelService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly SCOUT_PAGE_LIMIT = SCOUT_PAGE_LIMIT;
  protected readonly libraryEmptyLabel: TranslationKey = 'intel.empty';
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly scouts = signal<ScoutedCompSummary[]>([]);
  protected readonly matchups = signal<MatchupReport | null>(null);
  protected readonly report = signal<GuildReport | null>(null);
  /** Optional existing Fight Trends endpoint, intentionally non-blocking for Intel. */
  protected readonly fightTrends = signal<FightTrendView | null>(null);
  protected readonly tab = signal('overview');
  protected readonly headlineTotal = signal(0);
  protected readonly headlineTopThreat = signal<ScoutedCompSummary | null>(null);
  protected readonly libraryTotal = signal(0);
  protected readonly libraryLoading = signal(false);
  protected readonly libraryFailed = signal(false);
  private readonly scoutNames = signal<Readonly<Record<number, string>>>({});

  private libraryParams: DataTablePageChange = {
    page: 1,
    pageSize: SCOUT_PAGE_LIMIT,
    search: '',
    sort: null,
    columnFilters: {},
  };

  protected readonly tabs = computed<ViewToggleOption[]>(() => [
    { id: 'overview', label: this.t('intel.nav.overview') },
    { id: 'matchups', label: this.t('intel.nav.matchups') },
    { id: 'scouts', label: this.t('intel.nav.enemies') },
    { id: 'operations', label: this.t('intel.nav.ops') },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly libraryColumns = computed<readonly DataTableColumn<ScoutedCompSummary>[]>(
    () => [
      {
        key: 'opponent',
        label: 'intel.enemy',
        searchable: true,
        accessor: (row) => row.opponent_guild_name,
      },
      {
        key: 'name',
        label: 'common.name',
        searchable: true,
        accessor: (row) => row.name,
      },
      {
        key: 'category',
        label: 'common.category',
        accessor: (row) => row.category,
        filterOptions: [
          { value: 'gank', label: this.t('intel.category.gank') },
          { value: 'small_scale', label: this.t('intel.category.smallScale') },
          { value: 'zvz', label: this.t('intel.category.zvz') },
        ],
      },
      {
        key: 'players',
        label: 'intel.players',
        accessor: (row) => row.player_count,
        align: 'right',
      },
      {
        key: 'avg_ip',
        label: 'intel.avgIp',
        accessor: (row) => row.avg_ip,
        align: 'right',
      },
      {
        key: 'threat',
        label: 'intel.threat',
        sortable: true,
        accessor: (row) => row.threat_score,
        align: 'right',
      },
      {
        key: 'battles',
        label: 'intel.fights',
        sortable: true,
        accessor: (row) => row.source_battle_count,
        align: 'right',
      },
      {
        key: 'saved_at',
        label: 'intel.detail.lastSeen',
        sortable: true,
        accessor: (row) => row.saved_at,
      },
      {
        key: 'coverage',
        label: '',
      },
    ],
  );

  protected readonly matchupColumns = computed<readonly DataTableColumn<MatchupRow>[]>(() => [
    {
      key: 'our_comp',
      label: 'intel.ourComp',
      searchable: true,
      accessor: (row) => row.our_comp_name,
    },
    {
      key: 'enemy',
      label: 'intel.enemy',
      searchable: true,
      accessor: (row) => this.scoutName(row.scouted_comp_id),
    },
    {
      key: 'fights',
      label: 'intel.fights',
      sortable: true,
      accessor: (row) => row.wins + row.losses,
      align: 'right',
    },
    {
      key: 'record',
      label: 'intel.record',
      accessor: (row) => `${row.wins}-${row.losses}`,
      align: 'right',
    },
    {
      key: 'win_rate',
      label: 'intel.winRate',
      sortable: true,
      accessor: (row) => (row.wins + row.losses > 0 ? (row.wins / (row.wins + row.losses)) * 100 : 0),
    },
  ]);

  protected readonly trendsColumns = computed<readonly DataTableColumn<TrendBucket>[]>(() => [
    {
      key: 'week_start',
      label: 'intel.trends.week',
      sortable: true,
      accessor: (row) => row.week_start,
    },
    {
      key: 'fights',
      label: 'intel.fights',
      sortable: true,
      accessor: (row) => row.fights,
      align: 'right',
    },
    {
      key: 'record',
      label: 'intel.record',
      accessor: (row) => `${row.wins}-${row.losses}`,
      align: 'right',
    },
    {
      key: 'win_rate',
      label: 'intel.winRate',
      accessor: (row) => this.weekWinRate(row),
    },
    {
      key: 'attendance',
      label: 'intel.trends.attendance',
      sortable: true,
      accessor: (row) => row.attendance,
      align: 'right',
    },
    {
      key: 'net',
      label: 'intel.trends.net',
      sortable: true,
      accessor: (row) => this.weekNet(row),
      align: 'right',
    },
  ]);

  protected readonly rosterColumns = computed<readonly DataTableColumn<RosterRow>[]>(() => [
    {
      key: 'username',
      label: 'common.username',
      searchable: true,
      accessor: (row) => row.username,
    },
    {
      key: 'events_signed',
      label: 'intel.events',
      sortable: true,
      accessor: (row) => row.events_signed,
      align: 'right',
    },
    {
      key: 'fights',
      label: 'intel.fights',
      sortable: true,
      accessor: (row) => row.fights,
      align: 'right',
    },
    {
      key: 'kill_death_ratio',
      label: 'intel.kd',
      sortable: true,
      accessor: (row) => row.kill_death_ratio,
      align: 'right',
    },
    {
      key: 'silver_lost',
      label: 'intel.silverLost',
      sortable: true,
      accessor: (row) => row.silver_lost,
      align: 'right',
    },
  ]);

  protected readonly trackScout = (scout: ScoutedCompSummary): unknown => scout.id;
  protected readonly trackMatchup = (row: MatchupRow): unknown => row.our_comp_id + ':' + row.scouted_comp_id;
  protected readonly trackTrend = (row: TrendBucket): unknown => row.week_start;
  protected readonly trackMember = (row: RosterRow): unknown => row.user_id;

  protected readonly topThreat = computed<ScoutedCompSummary | null>(
    () => this.headlineTopThreat(),
  );

  protected readonly matchupRows = computed(() => this.matchups()?.rows ?? []);
  protected readonly coverage = computed(() => this.matchups()?.coverage ?? null);

  private readonly totals = computed(() => {
    const rows = this.matchupRows();
    return {
      wins: rows.reduce((sum, row) => sum + row.wins, 0),
      losses: rows.reduce((sum, row) => sum + row.losses, 0),
    };
  });

  protected recordLabel(): string {
    const { wins, losses } = this.totals();
    return wins + losses === 0 ? '—' : `${wins}–${losses}`;
  }

  protected recordTone(): 'success' | 'danger' | 'default' {
    const { wins, losses } = this.totals();
    if (wins + losses === 0) {
      return 'default';
    }
    return wins >= losses ? 'success' : 'danger';
  }

  protected coverageLabel(): string {
    const cov = this.coverage();
    if (!cov || cov.total_battles === 0) {
      return '—';
    }
    return `${Math.round((cov.battles_with_comp / cov.total_battles) * 100)}%`;
  }

  protected coverageTone(): 'success' | 'warning' | 'default' {
    const cov = this.coverage();
    if (!cov || cov.total_battles === 0) {
      return 'default';
    }
    return cov.battles_with_comp === cov.total_battles ? 'success' : 'warning';
  }

  protected matchupCoverageLabel(): string {
    const cov = this.coverage();
    if (!cov || cov.total_battles === 0) {
      return this.t('intel.coverageNoteHint');
    }
    return `${cov.battles_with_comp} of ${cov.total_battles} battles have composition evidence (${this.coverageLabel()} coverage).`;
  }

  protected readonly maxDailyFights = computed(() =>
    Math.max(1, ...(this.fightTrends()?.rolling_daily_fight_counts.map((day) => day.fights) ?? [0])),
  );

  protected dailyFightBarHeight(fights: number): number {
    return (fights / this.maxDailyFights()) * 100;
  }

  protected fightTrendSampleLabel(trends: FightTrendView): string {
    const period = trends.last_30_days;
    return `${period.fight_sample_size} canonical fights · ${period.win_sample_size} with winner data · ${period.combat_sample_size} with snapshots`;
  }

  protected fightTrendDescription(trends: FightTrendView): string {
    const days = trends.rolling_daily_fight_counts;
    return `Daily canonical fight volume from ${days[0]?.date ?? trends.last_30_days.window_started_at} to ${days.at(-1)?.date ?? trends.last_30_days.window_ended_at}, peaking at ${this.maxDailyFights()} fights per day.`;
  }

  protected prettyWeapon(id: string): string {
    return id
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

  protected readonly topPlayers = computed(() =>
    (this.report()?.members ?? [])
      .filter((member) => member.fights > 0)
      .sort((a, b) => b.fights - a.fights || b.kills - a.kills || a.username.localeCompare(b.username))
      .slice(0, 4),
  );

  protected readonly topComps = computed(() =>
    (this.report()?.comps ?? [])
      .filter((comp) => comp.fights > 0)
      .sort((a, b) => b.fights - a.fights || b.win_rate - a.win_rate || a.name.localeCompare(b.name))
      .slice(0, 4),
  );

  protected readonly plannedBuilds = computed(() => {
    const selections = this.fightTrends()?.last_30_days.planned_participation;
    if (!selections) {
      return [];
    }
    const counts = new Map<number, { id: number; name: string; count: number }>();
    for (const selection of [...selections.primary_build_assignments, ...selections.secondary_build_assignments]) {
      const current = counts.get(selection.id);
      counts.set(selection.id, {
        id: selection.id,
        name: selection.name ?? `Unknown build #${selection.id}`,
        count: (current?.count ?? 0) + selection.count,
      });
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 4);
  });

  protected playerCoverageLabel(report: GuildReport): string {
    const membersWithFights = report.members.filter((member) => member.fights > 0).length;
    return `${membersWithFights} of ${report.members.length} roster members have combat records.`;
  }

  protected compCoverageLabel(report: GuildReport): string {
    const attributed = report.data_quality.attributed_battles;
    const total = report.data_quality.total_battles;
    return total > 0
      ? `${attributed} of ${total} battles are attributed to a comp.`
      : 'No battle attribution is available in this report window.';
  }

  protected buildCoverageLabel(): string {
    const participation = this.fightTrends()?.last_30_days.planned_participation;
    if (!participation) {
      return '';
    }
    return `${participation.planned_participant_assignments} planned assignments across ${participation.linked_fights} linked fights in the last 30 days.`;
  }

  protected readonly notableFights = computed(() => {
    const overview = this.report()?.overview;
    return [
      { label: this.t('intel.bestFight'), data: overview?.best_fight ?? null },
      { label: this.t('intel.worstFight'), data: overview?.worst_fight ?? null },
    ].filter((entry) => entry.data !== null);
  });

  protected readonly roleCoverage = computed(() => {
    const ops = this.report()?.operations;
    if (!ops) {
      return [];
    }
    const names = new Set([...Object.keys(ops.role_need), ...Object.keys(ops.role_fill)]);
    return [...names]
      .map((name) => ({
        name: name.replace('_', ' '),
        needed: ops.role_need[name] ?? 0,
        filled: ops.role_fill[name] ?? 0,
      }))
      .filter((role) => role.needed > 0 || role.filled > 0)
      .sort((a, b) => a.filled - a.needed - (b.filled - b.needed));
  });

  private readonly peakHour = computed(() =>
    Math.max(1, ...(this.report()?.hours ?? []).map((h) => h.fights)),
  );

  protected barHeight(value: number): number {
    const HISTOGRAM_PX = 120;
    return Math.round((value / this.peakHour()) * HISTOGRAM_PX);
  }

  protected weekNet(week: TrendBucket): number {
    return week.loot_in - week.outflow;
  }

  protected weekWinRate(week: TrendBucket): number {
    return week.fights === 0 ? 0 : Math.round((week.wins / week.fights) * 100);
  }

  protected weekOverWeek(): {
    winRate: number;
    attendance: number;
    net: number;
    fights: number;
  } | null {
    const weeks = this.report()?.trends ?? [];
    if (weeks.length < 2) {
      return null;
    }
    const current = weeks[weeks.length - 1];
    const previous = weeks[weeks.length - 2];
    return {
      winRate: this.weekWinRate(current) - this.weekWinRate(previous),
      attendance: current.attendance - previous.attendance,
      net: this.weekNet(current) - this.weekNet(previous),
      fights: current.fights - previous.fights,
    };
  }

  protected formatDelta(value: number): string {
    const rounded = Math.round(value);
    return rounded > 0 ? `+${rounded}` : String(rounded);
  }

  protected scoutName(id: number): string {
    return this.scoutNames()[id] ?? `#${id}`;
  }

  private rememberScoutNames(items: readonly ScoutedCompSummary[]): void {
    this.scoutNames.update((map) => {
      const next: Record<number, string> = { ...map };
      for (const scout of items) {
        next[scout.id] = scout.name;
      }
      return next;
    });
  }

  constructor() {
    void this.load();
  }

  protected onTabChange(tab: string): void {
    this.tab.set(tab);
  }

  protected openScout(scout: ScoutedCompSummary): void {
    void this.router.navigate(['/intel', scout.id]);
  }

  protected onLibraryPageChange(event: DataTablePageChange): void {
    this.libraryParams = event;
    void this.loadLibrary();
  }

  protected reloadLibrary(): void {
    void this.loadLibrary();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [library, matchups, report, fightTrends] = await Promise.all([
        firstValueFrom(this.intel.listScouts({ limit: SCOUT_PAGE_LIMIT, sort: 'threat', page: 1 })),
        firstValueFrom(this.intel.matchups()).catch(() => null),
        firstValueFrom(this.intel.report()).catch(() => null),
        firstValueFrom(this.api.get<FightTrendView>('/api/fights/trends')).catch(() => null),
      ]);
      this.scouts.set(library.items);
      this.rememberScoutNames(library.items);
      this.libraryTotal.set(library.total_items);
      this.headlineTotal.set(library.total_items);
      this.headlineTopThreat.set(library.items.at(0) ?? null);
      this.matchups.set(matchups);
      this.report.set(report);
      this.fightTrends.set(fightTrends);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadLibrary(): Promise<void> {
    this.libraryLoading.set(true);
    this.libraryFailed.set(false);
    try {
      const library = await firstValueFrom(this.intel.listScouts(this.toScoutParams()));
      this.scouts.set(library.items);
      this.rememberScoutNames(library.items);
      this.libraryTotal.set(library.total_items);
    } catch (error) {
      this.libraryFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.libraryLoading.set(false);
    }
  }

  private toScoutParams(): ScoutListParams {
    const event = this.libraryParams;
    const sortKey = event.sort?.columnKey;
    const sort: ScoutListParams['sort'] =
      sortKey === 'saved_at' ? 'saved_at' : sortKey === 'battles' ? 'battles' : 'threat';
    const category = event.columnFilters['category'] || undefined;
    return {
      q: event.search.trim() || undefined,
      category,
      sort,
      page: event.page,
      limit: event.pageSize,
    };
  }
}
