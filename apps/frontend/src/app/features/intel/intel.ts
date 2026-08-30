import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { IntelService } from '../../core/services/intel.service';
import type { ScoutListParams } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import type {
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

/** Default page size for the scout library table. */
const SCOUT_PAGE_LIMIT = 25;

/**
 * Enemy intel: the scouted-composition library and the matchup matrix.
 *
 * Everything here is derived server-side, because it aggregates across
 * battles, events and comps that the browser never holds in full.
 *
 * Two honesty rules shape the presentation:
 * - a similarity or weapon figure drawn from a partial kill feed is labelled
 *   as such, never presented as if the whole enemy force was observed;
 * - a sparse matchup matrix reports *why* it is sparse, since battles that
 *   were never linked to an event carry no comp and cannot be attributed.
 */
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
    Loading,
    Meter,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
    StatusChip,
    ViewToggle,
  ],
  template: `
    <app-page-header [title]="t('intel.title')" [subtitle]="t('intel.subtitle')" [actions]="false">
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
      <!-- Headline numbers, always visible so the tabs never hide the shape
           of the library. -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <app-stat-card [label]="t('intel.stat.scouts')" [value]="headlineTotal().toString()" />
        <app-stat-card
          [label]="t('intel.stat.topThreat')"
          [value]="topThreat()?.opponent_guild_name ?? '—'"
          [sub]="topThreat() ? t('intel.stat.threatScore') + ' ' + topThreat()!.threat_score : ''"
          tone="danger"
        />
        <app-stat-card
          [label]="t('intel.stat.record')"
          [value]="recordLabel()"
          [sub]="t('intel.stat.acrossFights')"
          [tone]="recordTone()"
        />
        <app-stat-card
          [label]="t('intel.stat.coverage')"
          [value]="coverageLabel()"
          [sub]="t('intel.stat.coverageSub')"
          [tone]="coverageTone()"
        />
      </div>

      @switch (tab()) {
        @case ('overview') {
          @if (report(); as r) {
            <div class="grid gap-4 lg:grid-cols-2">
              <section class="card p-4">
                <h2 class="eyebrow mb-3">{{ t('intel.tab.performance') }}</h2>
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
                    [tone]="r.overview.win_streak > 0 ? 'success' : 'default'"
                  />
                  <app-stat-card
                    [label]="t('intel.ipDelta')"
                    [value]="(r.overview.item_power_delta > 0 ? '+' : '') + (r.overview.item_power_delta | number: '1.0-0')"
                    [sub]="t('intel.ipDeltaSub')"
                    [tone]="r.overview.item_power_delta >= 0 ? 'success' : 'warning'"
                  />
                </div>
              </section>

              <section class="card p-4">
                <h2 class="eyebrow mb-3">{{ t('intel.tab.notableFights') }}</h2>
                @for (fight of notableFights(); track fight.label) {
                  @if (fight.data; as f) {
                    <a
                      class="mb-2 flex items-center justify-between rounded-2xl p-3 no-underline"
                      [style.background-color]="f.is_win ? 'var(--color-success-container)' : 'var(--color-error-container)'"
                      [routerLink]="['/battles', f.battle_id]"
                    >
                      <span>
                        <span class="eyebrow" [style.color]="f.is_win ? 'var(--color-success)' : 'var(--color-error)'">
                          {{ fight.label }} · {{ f.is_win ? t('common.win') : t('common.loss') }}
                        </span>
                        <span class="mt-0.5 block text-sm" style="color: var(--color-text)">
                          {{ f.opponent ?? t('intel.unknownOpponent') }}
                        </span>
                      </span>
                      <span class="mono text-xs" style="color: var(--color-text-secondary)">
                        {{ f.kills }}/{{ f.deaths }}
                      </span>
                    </a>
                  }
                }
                @if (!r.overview.best_fight) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ t('common.empty') }}
                  </p>
                }
              </section>

              <section class="card p-4 lg:col-span-2">
                <h2 class="eyebrow mb-3">{{ t('intel.tab.timeline') }}</h2>
                @for (entry of r.timeline; track entry.at + entry.title) {
                  <div class="flex items-baseline gap-3 border-t py-2" style="border-color: var(--color-border)">
                    <span class="mono shrink-0 text-[11px]" style="color: var(--color-text-disabled)">
                      {{ entry.at | date: 'MMM d, HH:mm' }}
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="text-sm" style="color: var(--color-text)">{{ entry.title }}</span>
                      <span class="ml-2 text-xs" style="color: var(--color-text-secondary)">{{ entry.detail }}</span>
                    </span>
                  </div>
                }
              </section>
            </div>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" [hint]="t('intel.reportUnavailableHint')" />
          }
        }

        @case ('trends') {
          @if (report(); as r) {
            @if (r.trends.length === 0) {
              <app-empty-state icon="chart" [message]="t('common.empty')" />
            } @else {
              <div class="card overflow-x-auto">
                <table class="table">
                  <thead>
                    <tr>
                      <th>{{ t('intel.trends.week') }}</th>
                      <th class="text-right">{{ t('intel.fights') }}</th>
                      <th class="text-right">{{ t('intel.record') }}</th>
                      <th class="w-40">{{ t('intel.winRate') }}</th>
                      <th class="text-right">{{ t('intel.trends.attendance') }}</th>
                      <th class="text-right">{{ t('intel.trends.net') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (week of r.trends; track week.week_start) {
                      <tr>
                        <td>{{ week.week_start | date: 'MMM d' }}</td>
                        <td class="mono text-right">{{ week.fights }}</td>
                        <td class="mono text-right">
                          <span style="color: var(--color-success)">{{ week.wins }}</span>
                          <span style="color: var(--color-text-disabled)">/</span>
                          <span style="color: var(--color-error)">{{ week.losses }}</span>
                        </td>
                        <td>
                          @if (week.fights > 0) {
                            <app-meter
                              [label]="''"
                              [value]="week.wins"
                              [max]="week.fights"
                              [display]="weekWinRate(week) + '%'"
                              [tone]="weekWinRate(week) >= 50 ? 'success' : 'danger'"
                            />
                          } @else {
                            <span style="color: var(--color-text-disabled)">—</span>
                          }
                        </td>
                        <td class="mono text-right">
                          {{ week.attendance }}
                          @if (week.events > 0) {
                            <span class="text-xs" style="color: var(--color-text-secondary)">
                              ({{ week.events }} {{ t('intel.events') }})
                            </span>
                          }
                        </td>
                        <td class="mono text-right" [style.color]="weekNet(week) >= 0 ? 'var(--color-success)' : 'var(--color-error)'">
                          {{ weekNet(week) | number: '1.0-0' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <!-- Week-over-week deltas on the headline measures, so a single
                   number ("62% win rate") reads alongside its direction. -->
              @if (weekOverWeek(); as delta) {
                <div class="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                <p class="mt-3 text-xs" style="color: var(--color-text-secondary)">
                  {{ t('intel.trends.deltaHint') }}
                </p>
              }
            }
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" [hint]="t('intel.reportUnavailableHint')" />
          }
        }

        @case ('ops') {
          @if (report(); as r) {
            <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <app-stat-card [label]="t('intel.roster')" [value]="r.operations.roster.toString()" />
              <app-stat-card [label]="t('intel.officers')" [value]="r.operations.officers.toString()" />
              <app-stat-card
                [label]="t('intel.unlinked')"
                [value]="r.operations.unlinked.toString()"
                [tone]="r.operations.unlinked > 0 ? 'warning' : 'success'"
              />
              <app-stat-card
                [label]="t('intel.fillRate')"
                [value]="(r.operations.fill_rate | number: '1.0-0') + '%'"
                [sub]="r.operations.attendance + ' / ' + r.operations.slots"
              />
            </div>

            <div class="grid gap-4 lg:grid-cols-2">
              <section class="card p-4">
                <h2 class="eyebrow mb-2">{{ t('intel.roleCoverage') }}</h2>
                @for (role of roleCoverage(); track role.name) {
                  <app-meter
                    [label]="role.name"
                    [value]="role.filled"
                    [max]="role.needed || 1"
                    [display]="role.filled + ' / ' + role.needed"
                    [tone]="role.filled >= role.needed ? 'success' : 'danger'"
                  />
                }
              </section>

              <section class="card p-4">
                <h2 class="eyebrow mb-2">{{ t('intel.inactive') }}</h2>
                @if (r.operations.inactive_members.length === 0) {
                  <p class="text-sm" style="color: var(--color-success)">{{ t('intel.allActive') }}</p>
                } @else {
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ r.operations.inactive_members.join(', ') }}
                  </p>
                }
              </section>
            </div>

            @if (r.data_quality.unlinked_players.length) {
              <p class="mt-4 text-xs" style="color: var(--color-warning)">
                {{ t('intel.unlinkedPlayers') }}: {{ r.data_quality.unlinked_players.join(', ') }}
              </p>
            }
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('comps') {
          @if (report(); as r) {
            <div class="card overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('intel.ourComp') }}</th>
                    <th class="text-right">{{ t('intel.seats') }}</th>
                    <th class="text-right">{{ t('intel.events') }}</th>
                    <th class="text-right">{{ t('intel.fights') }}</th>
                    <th class="text-right">{{ t('intel.record') }}</th>
                    <th class="text-right">{{ t('intel.fillRate') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.comps; track row.comp_id) {
                    <tr>
                      <td>
                        <a class="no-underline" [routerLink]="['/comps', row.comp_id]" style="color: var(--color-primary)">
                          {{ row.name }}
                        </a>
                      </td>
                      <td class="mono text-right">{{ row.seats }}</td>
                      <td class="mono text-right">{{ row.events }}</td>
                      <td class="mono text-right">{{ row.fights }}</td>
                      <td class="mono text-right">
                        <span style="color: var(--color-success)">{{ row.wins }}</span>
                        <span style="color: var(--color-text-disabled)">/</span>
                        <span style="color: var(--color-error)">{{ row.losses }}</span>
                      </td>
                      <td class="mono text-right">{{ row.fill_rate | number: '1.0-0' }}%</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('roster') {
          @if (report(); as r) {
            <div class="card overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('common.username') }}</th>
                    <th class="text-right">{{ t('intel.events') }}</th>
                    <th class="text-right">{{ t('intel.fights') }}</th>
                    <th class="text-right">K/D</th>
                    <th class="text-right">{{ t('intel.silverLost') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.members; track row.user_id) {
                    <tr>
                      <td>
                        {{ row.username }}
                        @if (!row.linked) {
                          <span class="chip chip--warning ml-2">{{ t('intel.notLinked') }}</span>
                        }
                      </td>
                      <td class="mono text-right">{{ row.events_signed }}</td>
                      <td class="mono text-right">{{ row.fights }}</td>
                      <td class="mono text-right">{{ row.kill_death_ratio | number: '1.2-2' }}</td>
                      <td class="mono text-right">{{ row.silver_lost | number: '1.0-0' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('timing') {
          @if (report(); as r) {
            <section class="card p-4">
              <h2 class="eyebrow mb-1">{{ t('intel.tab.timing') }}</h2>
              <p class="mb-4 text-xs" style="color: var(--color-text-secondary)">
                {{ t('intel.timingHint') }}
              </p>
              <div class="flex h-40 items-end gap-1">
                @for (bucket of r.hours; track bucket.hour) {
                  <button
                    type="button"
                    class="flex flex-1 flex-col justify-end gap-px border-0 bg-transparent p-0 cursor-pointer"
                    [title]="bucket.hour + ':00 — ' + bucket.wins + 'W ' + bucket.losses + 'L'"
                    [attr.aria-label]="bucket.hour + ':00 — ' + bucket.wins + ' ' + t('common.win') + ', ' + bucket.losses + ' ' + t('common.loss')"
                  >
                    <span
                      class="w-full rounded-t-sm"
                      style="background-color: var(--color-success)"
                      [style.height.px]="barHeight(bucket.wins)"
                    ></span>
                    <span
                      class="w-full"
                      style="background-color: var(--color-error)"
                      [style.height.px]="barHeight(bucket.losses)"
                    ></span>
                  </button>
                }
              </div>
              <div class="mt-2 flex justify-between text-[10px]" style="color: var(--color-text-disabled)">
                <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
              </div>
            </section>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('meta') {
          @if (report(); as r) {
            <div class="grid gap-4 lg:grid-cols-2">
              <section class="card p-4">
                <h2 class="eyebrow mb-2">{{ t('intel.ourMeta') }}</h2>
                @if (r.our_meta.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
                } @else {
                  @for (w of r.our_meta; track w.weapon) {
                    <app-meter
                      [label]="prettyWeapon(w.weapon)"
                      [value]="w.count"
                      [max]="r.our_meta[0].count"
                      [display]="w.count.toString()"
                    />
                  }
                }
              </section>
              <section class="card p-4">
                <h2 class="eyebrow mb-2">{{ t('intel.enemyMeta') }}</h2>
                @if (r.enemy_meta.length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
                } @else {
                  @for (w of r.enemy_meta; track w.weapon) {
                    <app-meter
                      [label]="prettyWeapon(w.weapon)"
                      [value]="w.count"
                      [max]="r.enemy_meta[0].count"
                      [display]="w.count.toString()"
                      tone="danger"
                    />
                  }
                }
              </section>
            </div>
            <p class="mt-3 text-xs" style="color: var(--color-text-secondary)">
              {{ t('intel.metaHint') }}
            </p>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('economy') {
          @if (report(); as r) {
            <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <app-stat-card
                [label]="t('intel.lootIn')"
                [value]="r.economy.loot_in | number: '1.0-0'"
                tone="success"
              />
              <app-stat-card
                [label]="t('intel.outflow')"
                [value]="r.economy.outflow_total | number: '1.0-0'"
                tone="warning"
              />
              <app-stat-card
                [label]="t('intel.net')"
                [value]="r.economy.net | number: '1.0-0'"
                [tone]="r.economy.net >= 0 ? 'success' : 'danger'"
              />
              <app-stat-card
                [label]="t('intel.famePerMillion')"
                [value]="r.economy.fame_per_million_lost | number: '1.0-0'"
                [sub]="t('intel.famePerMillionSub')"
              />
            </div>

            <section class="card p-4">
              <h2 class="eyebrow mb-1">{{ t('intel.outflowBreakdown') }}</h2>
              <p class="mb-3 text-xs" style="color: var(--color-text-secondary)">
                {{ t('intel.outflowHint') }}
              </p>
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
            </section>
          } @else {
            <app-empty-state icon="alert" [message]="t('intel.reportUnavailable')" />
          }
        }

        @case ('enemies') {
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
              <span class="mono" style="color: var(--color-error)">{{ row.threat_score }}</span>
            </ng-template>
            <ng-template dataTableCell="battles" let-row>
              <span class="mono">{{ row.source_battle_count }}</span>
            </ng-template>
            <ng-template dataTableCell="saved_at" let-row>
              <span class="text-sm">{{ row.saved_at | date: 'short' }}</span>
            </ng-template>
            <ng-template dataTableCell="coverage" let-row>
              @if (!row.full_weapon_coverage) {
                <span
                  class="text-[11px]"
                  style="color: var(--color-warning)"
                  [title]="t('intel.partialCoverageHint')"
                >
                  {{ t('intel.partialCoverage') }}
                  {{ row.weapon_sample_size }}/{{ row.player_count }}
                </span>
              }
            </ng-template>
          </app-data-table>
        }

        @case ('matchups') {
          @if (matchupRows().length === 0) {
            <app-empty-state
              icon="swords"
              [message]="t('intel.noMatchups')"
              [hint]="t('intel.noMatchupsHint')"
            />
          } @else {
            <div class="card overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('intel.ourComp') }}</th>
                    <th>{{ t('intel.enemy') }}</th>
                    <th class="text-right">{{ t('intel.fights') }}</th>
                    <th class="text-right">{{ t('intel.record') }}</th>
                    <th class="w-40">{{ t('intel.winRate') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of matchupRows(); track row.our_comp_id + ':' + row.scouted_comp_id) {
                    <tr>
                      <td>
                        <a
                          class="no-underline"
                          [routerLink]="['/comps', row.our_comp_id]"
                          style="color: var(--color-primary)"
                        >
                          {{ row.our_comp_name }}
                        </a>
                      </td>
                      <td>
                        <a
                          class="no-underline"
                          [routerLink]="['/intel', row.scouted_comp_id]"
                          style="color: var(--color-text)"
                        >
                          {{ scoutName(row.scouted_comp_id) }}
                        </a>
                      </td>
                      <td class="mono text-right">{{ row.battles }}</td>
                      <td class="mono text-right">
                        <span style="color: var(--color-success)">{{ row.wins }}</span>
                        <span style="color: var(--color-text-disabled)"> / </span>
                        <span style="color: var(--color-error)">{{ row.losses }}</span>
                      </td>
                      <td>
                        <app-meter
                          [label]="''"
                          [value]="row.win_rate"
                          [max]="100"
                          [display]="(row.win_rate | number: '1.0-0') + '%'"
                          [tone]="row.win_rate >= 50 ? 'success' : 'danger'"
                        />
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            @if (coverage(); as cov) {
              @if (cov.battles_with_comp < cov.total_battles) {
                <p class="mt-3 text-xs" style="color: var(--color-text-secondary)">
                  {{ t('intel.coverageNote') }}
                  {{ cov.battles_with_comp }}/{{ cov.total_battles }}.
                  {{ t('intel.coverageNoteHint') }}
                </p>
              }
            }
          }
        }
      }
      </app-page-stack>
    }
  `,
})
export class Intel {
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

  /**
   * The reference design had a per-map tab. AlbionBB carries no map or zone
   * for a battle anywhere in this pipeline, so it is replaced by an
   * hour-of-day view, which the data does support.
   */
  protected readonly tabs = computed<ViewToggleOption[]>(() => [
    { id: 'overview', label: this.t('intel.nav.overview') },
    { id: 'trends', label: this.t('intel.nav.trends') },
    { id: 'ops', label: this.t('intel.nav.ops') },
    { id: 'enemies', label: this.t('intel.nav.enemies') },
    { id: 'matchups', label: this.t('intel.nav.matchups') },
    { id: 'comps', label: this.t('intel.nav.comps') },
    { id: 'roster', label: this.t('intel.nav.roster') },
    { id: 'timing', label: this.t('intel.nav.timing') },
    { id: 'meta', label: this.t('intel.nav.meta') },
    { id: 'economy', label: this.t('intel.nav.economy') },
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

  protected readonly trackScout = (scout: ScoutedCompSummary): unknown => scout.id;

  /**
   * Headline top threat is taken from an unfiltered `sort=threat` page so
   * paging/searching the library table cannot hide the actual highest threat.
   */
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

  /** Turns `2H_HOLYSTAFF_MORGANA` into `Holystaff Morgana`. */
  protected prettyWeapon(id: string): string {
    return id
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

  /** Best and worst fight, paired with their labels for the overview. */
  protected readonly notableFights = computed(() => {
    const overview = this.report()?.overview;
    return [
      { label: this.t('intel.bestFight'), data: overview?.best_fight ?? null },
      { label: this.t('intel.worstFight'), data: overview?.worst_fight ?? null },
    ].filter((entry) => entry.data !== null);
  });

  /** Role coverage as `needed` versus `filled`, ordered by shortfall. */
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

  /** Tallest hour sets the scale, so the histogram always fills its box. */
  private readonly peakHour = computed(() =>
    Math.max(1, ...(this.report()?.hours ?? []).map((h) => h.fights)),
  );

  protected barHeight(value: number): number {
    const HISTOGRAM_PX = 150;
    return Math.round((value / this.peakHour()) * HISTOGRAM_PX);
  }

  /** A week's net silver: what came in from splits minus what left the bank. */
  protected weekNet(week: TrendBucket): number {
    return week.loot_in - week.outflow;
  }

  /** A week's win rate, 0-100; zero on a quiet week rather than NaN. */
  protected weekWinRate(week: TrendBucket): number {
    return week.fights === 0 ? 0 : Math.round((week.wins / week.fights) * 100);
  }

  /**
   * Compares the most recent week against the one before it.
   *
   * Deliberately last-vs-previous rather than last-vs-average: a single
   * outlier week should not get smoothed away by a season's worth of history,
   * since the point of this card is "did this week go better or worse than
   * the last one", not a long-run baseline.
   */
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

  /** Signs a delta so a drop reads as "-12" rather than a bare "12". */
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
        next[scout.id] = scout.opponent_guild_name;
      }
      return next;
    });
  }

  constructor() {
    void this.load();
  }

  protected onTabChange(tab: string): void {
    this.tab.set(tab);
    if (tab === 'enemies') {
      this.libraryParams = {
        page: 1,
        pageSize: SCOUT_PAGE_LIMIT,
        search: '',
        sort: null,
        columnFilters: {},
      };
      void this.reloadLibrary();
    }
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
      const [library, matchups, report] = await Promise.all([
        // Headline cards need a threat-sorted first page (and the total),
        // independent of later library paging/search.
        firstValueFrom(this.intel.listScouts({ limit: SCOUT_PAGE_LIMIT, sort: 'threat', page: 1 })),
        // Only the Matchups tab needs this. A failure/timeout here must not
        // blank Operations/Comps/Roster/Timing/Meta/Economy, which only
        // depend on `report` below — same reasoning as its own `.catch()`.
        firstValueFrom(this.intel.matchups()).catch(() => null),
        // The report needs `intel.report.view`, which members may not hold.
        // A member should still get the scout library rather than an error
        // page, so this arm degrades instead of failing the whole load.
        firstValueFrom(this.intel.report()).catch(() => null),
      ]);
      this.scouts.set(library.items);
      this.rememberScoutNames(library.items);
      this.libraryTotal.set(library.total_items);
      this.headlineTotal.set(library.total_items);
      this.headlineTopThreat.set(library.items.at(0) ?? null);
      this.matchups.set(matchups);
      this.report.set(report);
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
