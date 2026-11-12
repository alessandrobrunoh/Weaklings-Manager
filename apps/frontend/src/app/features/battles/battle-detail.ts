import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import type {
  BattleDetail,
  BattleGuildSummary,
  BattleKillEvent,
  BattlePlayer,
  BattleSummary,
  BuildItemSlot,
  BuildSlot,
} from '../../core/models/api.models';
import type { MenuItem } from '../../shared/components/menu/menu';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { albionBattlesUrl } from './battle-metrics';
import { battleOutcomeLabel, type BattleOutcomeType } from './battle-outcome';
import { Chart, type ChartClickEvent, type ChartTableRow } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EntityHeader } from '../../shared/components/entity-header/entity-header';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import {
  Tabs,
  type TabOption,
} from '../../shared/components/tabs/tabs';

const ALBION_RENDER_ITEM_BASE_URL = 'https://render.albiononline.com/v1/item';

/** Kills at or above this fame are the "high fame" filter of the kill feed. */
const HIGH_FAME_THRESHOLD = 250_000;

type DetailTab = 'overview' | 'players' | 'guilds' | 'kills';

type KillFeedFilter = 'all' | 'our_kills' | 'our_deaths' | 'high_fame';
type PlayerSideFilter = 'all' | 'our_guild' | 'allies' | 'enemies';
type KillSide = 'killer' | 'victim';
type OutcomeTone = 'success' | 'warning' | 'error' | 'neutral';

/** One row of the faction matchup table on the overview tab. */
export interface MatchupRow {
  readonly key: 'ours' | 'enemies';
  readonly side: string;
  readonly force: string;
  readonly players: number;
  readonly kills: number;
  readonly deaths: number;
  readonly kdRatio: number;
  readonly killFame: number;
}

/** One honour of our guild on the players tab (the best player for that category). */
export interface HonorRow {
  readonly id: string;
  readonly labelKey: TranslationKey;
  readonly player: PlayerEnrichedRow | null;
  readonly value: string;
}

type CombatRole = 'tank' | 'healer' | 'support' | 'melee_dps' | 'ranged_dps' | 'other';

const EQUIPMENT_SLOTS: Readonly<Record<string, BuildSlot>> = {
  MainHand: 'weapon',
  OffHand: 'off_hand',
  Head: 'head',
  Armor: 'armor',
  Shoes: 'shoes',
  Cape: 'cape',
  Bag: 'bag',
  Potion: 'potion',
  Food: 'food',
  Mount: 'mount',
};

type RawObject = Record<string, unknown>;

export interface AllianceSummary {
  readonly name: string;
  readonly isSolo: boolean;
  readonly isOurAlliance: boolean;
  readonly guilds: readonly BattleGuildSummary[];
  readonly players: number;
  readonly kills: number;
  readonly deaths: number;
  readonly killFame: number;
  readonly deathFame: number;
  readonly netFame: number;
  readonly kdRatio: number;
  readonly avgIp: number;
  readonly estimatedLoss: number;
}

export interface TimelineMinuteBucket {
  readonly minute: number;
  readonly label: string;
  readonly ourKills: number;
  readonly ourDeaths: number;
  readonly enemyKills: number;
  readonly totalKills: number;
  readonly fame: number;
  readonly ourFame: number;
  readonly enemyFame: number;
}

export interface WeaponUsageStat {
  readonly type: string;
  readonly name: string;
  readonly role: CombatRole;
  readonly totalCount: number;
  readonly ourCount: number;
  readonly kills: number;
}

export interface PlayerEnrichedRow extends BattlePlayer {
  readonly isOurGuild: boolean;
  readonly isOurAlliance: boolean;
  readonly role: CombatRole;
  readonly weaponType: string | null;
  readonly weaponName: string;
  readonly netFame: number;
  readonly kdRatio: number;
  readonly estimatedLoss: number;
}

export interface GuildEnrichedRow extends BattleGuildSummary {
  readonly isOurGuild: boolean;
  readonly isOurAlliance: boolean;
  readonly kdRatio: number;
  readonly famePerPlayer: number;
  readonly estimatedLoss: number;
}

/**
 * Advanced tactical analytics war room for an Albion Online battle.
 *
 * Provides deep insights into overall combat dynamics, multi-alliance matchups,
 * our guild's performance, player MVPs, timeline skirmishes, and gear loss breakdown.
 */
@Component({
  selector: 'app-battle-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Chart,
    DataTable,
    DataTableCell,
    Dialog,
    EntityHeader,
    EquipmentGrid,
    ErrorState,
    FilterBar,
    Icon,
    Loading,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (battle(); as detail) {
      <a class="btn btn--ghost btn--sm mb-3 inline-flex no-underline" [routerLink]="['/battles']">
        ← {{ t('nav.battles') }}
      </a>

      <app-entity-header
        [title]="'#' + detail.battle_id"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <span entityBadges class="inline-flex flex-wrap items-center gap-2">
          <app-status-chip
            [value]="detail.outcome ?? 'unknown'"
            [label]="verdict().label"
            [toneOverride]="verdict().tone"
          />
          @if (detail.linked_event; as event) {
            <a
              class="chip chip--info no-underline"
              [routerLink]="['/events', event.id]"
              [title]="t('battles.linkedEventHint')"
            >
              {{ event.title }}
              @if (event.call_to_arms) {
                · {{ t('events.call_to_arms') }}
              }
            </a>
          } @else {
            <span class="chip" [title]="t('battles.unlinkedHint')">
              {{ t('battles.unlinked') }}
            </span>
          }
        </span>

        <div entityMeta class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{{ formatDate(detail.start_time) }}</span>
          <span>{{ formatDuration(detail) }}</span>
          <span>{{ detail.total_players }} {{ t('battles.players') }}</span>
          <span>{{ detail.guilds.length }} {{ t('battles.guilds') }}</span>
          @if (ourForceLabel(); as ours) {
            <span class="font-mono">{{ ours }}</span>
          }
        </div>

        @if (canScoutBattle()) {
          <button
            entityPrimary
            type="button"
            class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
            [disabled]="scouting()"
            [title]="t('battleDetail.scoutHint')"
            (click)="scoutBattle(detail.battle_id)"
          >
            <app-icon name="scan" size="0.875rem" />
            {{ scouting() ? t('common.loading') : t('battleDetail.scout') }}
          </button>
        }

        <div entitySummary>
          <app-summary-band [ariaLabel]="t('battleDetail.summaryLabel')" [items]="summaryItems()" />
        </div>
      </app-entity-header>

      <div class="mb-4">
        <app-tabs
          [options]="tabOptions()"
          [active]="tab()"
          [ariaLabel]="t('battleDetail.sectionsLabel')"
          (activeChange)="switchTab($event)"
        />
      </div>

      <app-page-stack>
        <!-- OVERVIEW: matchup, timeline, momentum, breakdown charts -->
        @if (tab() === 'overview') {
          <section class="card">
            <h2 class="section-title">{{ t('battleDetail.matchup') }}</h2>
            <div class="table-scroll">
              <table class="table" [attr.aria-label]="t('battleDetail.matchup')">
                <thead>
                  <tr>
                    <th scope="col">{{ t('battles.side') }}</th>
                    <th scope="col">{{ t('battleDetail.force') }}</th>
                    <th scope="col" class="text-right">{{ t('battles.players') }}</th>
                    <th scope="col" class="text-right">{{ t('battles.kills') }}</th>
                    <th scope="col" class="text-right">{{ t('battles.deaths') }}</th>
                    <th scope="col" class="text-right">{{ t('battles.kill_death') }}</th>
                    <th scope="col" class="text-right">{{ t('battles.kill_fame') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of matchupRows(); track row.key) {
                    <tr>
                      <td>{{ row.side }}</td>
                      <td class="font-medium">{{ row.force }}</td>
                      <td class="text-right num">{{ formatAmount(row.players) }}</td>
                      <td class="text-right num">{{ formatAmount(row.kills) }}</td>
                      <td class="text-right num">{{ formatAmount(row.deaths) }}</td>
                      <td class="text-right num">{{ formatDecimal(row.kdRatio) }}</td>
                      <td class="text-right num">{{ formatCompact(row.killFame) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('battles.timeline_density') }}</h2>
            <p class="hint mb-3">{{ t('battleDetail.timelineHint') }}</p>
            <app-chart
              [option]="timelineDensityOption()"
              height="16rem"
              [label]="t('battles.timeline_density')"
              [tableHead]="timelineDensityTableHead()"
              [tableRows]="timelineDensityTableRows()"
              (chartClick)="onTimelineChartClick($event)"
            />
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('battles.momentum') }}</h2>
            <p class="hint mb-3">{{ t('battles.momentum_hint') }}</p>
            <app-chart
              [option]="momentumOption()"
              height="15rem"
              [label]="t('battles.momentum')"
              [tableHead]="momentumTableHead()"
              [tableRows]="momentumTableRows()"
            />
          </section>

          <div class="grid gap-4 lg:grid-cols-3">
            <section class="card">
              <h2 class="section-title">{{ t('battles.fame_by_alliance') }}</h2>
              <app-chart
                [option]="allianceFameOption()"
                height="16rem"
                [label]="t('battles.fame_by_alliance')"
                [tableHead]="allianceFameTableHead()"
                [tableRows]="allianceFameTableRows()"
              />
            </section>

            <section class="card">
              <h2 class="section-title">{{ t('battles.top_guilds_kd') }}</h2>
              <app-chart
                [option]="topGuildsKdOption()"
                height="16rem"
                [label]="t('battles.top_guilds_kd')"
                [tableHead]="topGuildsKdTableHead()"
                [tableRows]="topGuildsKdTableRows()"
              />
            </section>

            <section class="card">
              <h2 class="section-title">{{ t('battles.composition_by_side') }}</h2>
              <p class="hint mb-3">{{ t('battles.composition_by_side_hint') }}</p>
              <app-chart
                [option]="roleCompositionOption()"
                height="14rem"
                [label]="t('battles.composition_by_side')"
                [tableHead]="roleCompositionTableHead()"
                [tableRows]="roleCompositionTableRows()"
              />
            </section>
          </div>
        }

        <!-- PLAYERS: our honours, every player, IP against fame -->
        @else if (tab() === 'players') {
          <section class="card">
            <h2 class="section-title">{{ t('battleDetail.honors') }}</h2>
            <div class="table-scroll">
              <table class="table" [attr.aria-label]="t('battleDetail.honors')">
                <thead>
                  <tr>
                    <th scope="col">{{ t('battleDetail.honor') }}</th>
                    <th scope="col">{{ t('common.name') }}</th>
                    <th scope="col" class="text-right">{{ t('battleDetail.value') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (honor of honorRows(); track honor.id) {
                    <tr>
                      <th scope="row" class="font-medium">{{ t(honor.labelKey) }}</th>
                      <td>
                        @if (honor.player; as player) {
                          <span class="bd__cell">
                            <img
                              [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')"
                              alt=""
                              class="bd__icon"
                              loading="lazy"
                            />
                            {{ player.name }}
                          </span>
                        } @else {
                          <span class="text-secondary">{{ t('common.none') }}</span>
                        }
                      </td>
                      <td class="text-right num">{{ honor.value || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <app-filter-bar
            [searchLabel]="t('battles.search_players')"
            [searchPlaceholder]="t('battles.search_players')"
            [query]="playerSearchQuery()"
            [activeCount]="playerSearchQuery() ? 1 : 0"
            (queryChange)="setPlayerQuery($event)"
            (clear)="setPlayerQuery('')"
          >
            <app-tabs
              filterPrimary
              variant="segmented"
              [options]="playerSideOptions()"
              [active]="playerFilterSide()"
              [ariaLabel]="t('battleDetail.playerSide')"
              (activeChange)="setPlayerSide($event)"
            />
          </app-filter-bar>

          <section class="card p-0">
            <app-data-table
              [syncUrl]="false"
              [columns]="playerColumns"
              [rows]="filteredAllPlayerRows()"
              [trackBy]="trackPlayerRow"
              [pageSize]="20"
              [hideSearch]="true"
              [stickyFirstColumn]="true"
              [ariaLabel]="t('battles.players')"
            >
              <ng-template dataTableCell="name" let-row>
                <span class="bd__cell">
                  <img
                    [src]="itemIconUrl(row.weaponType || 'T4_MAIN_SWORD')"
                    alt=""
                    class="bd__icon"
                    loading="lazy"
                  />
                  <span class="min-w-0">
                    <span class="block truncate font-medium" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
                    <span class="block truncate text-xs text-secondary">
                      {{ row.guild_name }}
                      @if (row.alliance_name) {
                        <span class="mono"> [{{ row.alliance_name }}]</span>
                      }
                    </span>
                  </span>
                </span>
              </ng-template>

              <ng-template dataTableCell="item_power" let-row>
                <span class="mono">{{ formatDecimal(row.item_power) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="mono">{{ formatCompact(row.kill_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="death_fame" let-row>
                <span class="mono">{{ formatCompact(row.death_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="net_fame" let-row>
                <span class="mono" [class.text-success]="row.netFame >= 0" [class.text-error]="row.netFame < 0">
                  {{ row.netFame >= 0 ? '+' : '' }}{{ formatCompact(row.netFame) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="estimated_loss" let-row>
                <span class="mono">{{ row.estimatedLoss > 0 ? formatCompact(row.estimatedLoss) : '—' }}</span>
              </ng-template>
            </app-data-table>
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('battles.ip_performance') }}</h2>
            <p class="hint mb-3">{{ t('battles.ip_performance_hint') }}</p>
            <app-chart
              [option]="ipPerformanceOption()"
              height="18rem"
              [label]="t('battles.ip_performance')"
              [tableHead]="ipPerformanceTableHead()"
              [tableRows]="ipPerformanceTableRows()"
            />
          </section>
        }

        <!-- GUILDS: alliances and guilds, as tables -->
        @else if (tab() === 'guilds') {
          <section class="card p-0">
            <div class="bd__head">
              <h2 class="section-title">{{ t('battleDetail.sections.alliances') }}</h2>
            </div>
            <app-data-table
              [syncUrl]="false"
              [columns]="allianceColumns"
              [rows]="alliances()"
              [trackBy]="trackAllianceRow"
              [pageSize]="10"
              [hideSearch]="true"
              [stickyFirstColumn]="true"
              [ariaLabel]="t('battleDetail.sections.alliances')"
            >
              <ng-template dataTableCell="name" let-row>
                <span class="bd__cell">
                  <span class="font-medium">{{ row.isSolo ? row.name : '[' + row.name + ']' }}</span>
                  @if (row.isOurAlliance) {
                    <span class="chip chip--success text-xs">{{ t('battles.allies') }}</span>
                  }
                </span>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="mono">{{ formatDecimal(row.kdRatio) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="mono">{{ formatCompact(row.killFame) }}</span>
              </ng-template>

              <ng-template dataTableCell="net_fame" let-row>
                <span class="mono" [class.text-success]="row.netFame >= 0" [class.text-error]="row.netFame < 0">
                  {{ row.netFame >= 0 ? '+' : '' }}{{ formatCompact(row.netFame) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="estimated_loss" let-row>
                <span class="mono">{{ row.estimatedLoss > 0 ? formatCompact(row.estimatedLoss) : '—' }}</span>
              </ng-template>
            </app-data-table>
          </section>

          <section class="card p-0">
            <div class="bd__head">
              <h2 class="section-title">{{ t('battles.guilds') }}</h2>
            </div>
            <app-data-table
              [syncUrl]="false"
              [columns]="guildColumns"
              [rows]="enrichedGuildRows()"
              [trackBy]="trackGuildRow"
              [pageSize]="12"
              [stickyFirstColumn]="true"
              [ariaLabel]="t('battles.guilds')"
            >
              <ng-template dataTableCell="name" let-row>
                <span class="bd__cell flex-wrap">
                  <span class="font-medium" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
                  @if (row.alliance_name) {
                    <span class="chip text-xs py-0 px-1 font-mono">[{{ row.alliance_name }}]</span>
                  }
                  @if (row.isOurGuild) {
                    <span class="chip chip--success text-xs py-0">{{ t('battleDetail.ourGuild') }}</span>
                  }
                  @if (row.winner) {
                    <span class="chip chip--success text-xs py-0">{{ t('battles.winner') }}</span>
                  }
                </span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="mono">{{ formatCompact(row.kill_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="mono">{{ formatDecimal(row.kdRatio) }}</span>
              </ng-template>

              <ng-template dataTableCell="fame_per_player" let-row>
                <span class="mono">{{ formatCompact(row.famePerPlayer) }}</span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- KILLS: kill feed with side and search filters, gear in a dialog -->
        @else {
          <app-filter-bar
            [searchLabel]="t('battleDetail.filter.search')"
            [searchPlaceholder]="t('battleDetail.filter.search')"
            [query]="killSearchQuery()"
            [activeCount]="killSearchQuery() ? 1 : 0"
            (queryChange)="setKillQuery($event)"
            (clear)="setKillQuery('')"
          >
            <app-tabs
              filterPrimary
              variant="segmented"
              [options]="killFilterOptions()"
              [active]="killFeedFilter()"
              [ariaLabel]="t('battleDetail.killFilter')"
              (activeChange)="setKillFeedFilter($event)"
            />
          </app-filter-bar>

          @if (selectedTimelineMinute() !== null) {
            <div class="bd__note" role="status">
              <span>{{ t('battleDetail.minute.showing', { minute: selectedTimelineMinute() ?? 0 }) }}</span>
              <button type="button" class="btn btn--ghost btn--sm" (click)="clearTimelineMinuteFilter()">
                {{ t('battleDetail.minute.showAll') }}
              </button>
            </div>
          }

          <section class="card p-0">
            <app-data-table
              [syncUrl]="false"
              [columns]="killColumns"
              [rows]="filteredKillRows()"
              [trackBy]="trackKillRow"
              [pageSize]="25"
              [hideSearch]="true"
              [stickyFirstColumn]="true"
              [emptyLabel]="'battles.no_matching_kills'"
              [ariaLabel]="t('battles.kill_feed')"
            >
              <ng-template dataTableCell="time" let-row>
                <span class="mono block">{{ formatTimeOffset(row.time, detail.start_time) }}</span>
                <span class="mono block text-xs text-secondary">{{ formatTime(row.time) }}</span>
              </ng-template>

              <ng-template dataTableCell="killer" let-row>
                <span class="bd__cell">
                  <img [src]="participantWeaponIcon(row, 'killer')" alt="" class="bd__icon" loading="lazy" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ row.killer.name }}</span>
                    <span class="block truncate text-xs text-secondary">
                      {{ row.killer.guild_name || t('common.none') }}
                      @if (resolveParticipantAlliance(row.killer); as ally) {
                        <span class="mono"> [{{ ally }}]</span>
                      }
                    </span>
                  </span>
                </span>
              </ng-template>

              <ng-template dataTableCell="victim" let-row>
                <span class="bd__cell">
                  <img [src]="participantWeaponIcon(row, 'victim')" alt="" class="bd__icon" loading="lazy" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ row.victim.name }}</span>
                    <span class="block truncate text-xs text-secondary">
                      {{ row.victim.guild_name || t('common.none') }}
                      @if (resolveParticipantAlliance(row.victim); as ally) {
                        <span class="mono"> [{{ ally }}]</span>
                      }
                    </span>
                  </span>
                </span>
              </ng-template>

              <ng-template dataTableCell="fame" let-row>
                <span class="mono">{{ formatCompact(row.total_kill_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="item_power" let-row>
                <span class="mono text-xs">
                  {{ formatDecimal(row.killer_item_power) }} → {{ formatDecimal(row.victim_item_power) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="gear" let-row>
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  [attr.aria-label]="t('battleDetail.gear.aria', { victim: row.victim.name })"
                  (click)="openGear(row)"
                >
                  {{ t('battles.showGear') }}
                </button>
              </ng-template>
            </app-data-table>
          </section>

          @if (gearKill(); as kill) {
            <app-dialog [title]="t('battleDetail.gear.title')" size="lg" (closed)="closeGear()">
              <div class="grid gap-4 md:grid-cols-2">
                <section class="card">
                  <h3 class="section-title">{{ t('battles.lostGear') }}</h3>
                  <p class="hint mb-3">{{ kill.victim.name }}</p>
                  <app-equipment-grid [items]="participantLoadout(kill, 'victim')" />
                </section>
                <section class="card">
                  <h3 class="section-title">{{ t('battles.killer_loadout') }}</h3>
                  <p class="hint mb-3">{{ kill.killer.name }}</p>
                  <app-equipment-grid [items]="participantLoadout(kill, 'killer')" />
                </section>
              </div>
            </app-dialog>
          }
        }
      </app-page-stack>
    } @else if (notFound()) {
      <app-error-state variant="not-found" [message]="t('ui.errorState.notFound')" [hint]="t('ui.errorState.notFoundHint')">
        <a class="btn btn--outline btn--sm no-underline" [routerLink]="['/battles']">{{ t('nav.battles') }}</a>
      </app-error-state>
    } @else {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    :host ::ng-deep .rounded-xl,
    :host ::ng-deep .rounded-2xl,
    :host ::ng-deep .rounded-lg,
    :host ::ng-deep .rounded-md,
    :host ::ng-deep .shadow-lg,
    :host ::ng-deep .shadow-xl {
      border-radius: var(--radius-cards);
      box-shadow: none;
    }
    @layer components {
      .bd__head {
        padding: var(--card-padding) var(--card-padding) 0;
      }
      .bd__head .section-title {
        margin-bottom: 0;
      }
      .bd__cell {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
      }
      .bd__icon {
        width: 2rem;
        height: 2rem;
        flex-shrink: 0;
        object-fit: contain;
        padding: 0.125rem;
        border-radius: var(--radius-sm);
        background: var(--color-surface-2);
      }
      .bd__note {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1rem;
        padding: 0.5rem var(--card-padding);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-cards);
        background: var(--color-surface-2);
        font-size: var(--ui-text-sm);
      }
    }
  `,
})

export class BattleDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly intelService = inject(IntelService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  // Chart palette/chrome, theme-reactive
  private readonly palette = computed(() => chartPalette(this.theme.isDark()));
  private readonly chrome = computed(() => chartChrome(this.theme.isDark()));

  protected readonly battle = signal<BattleDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly tab = signal<DetailTab>('overview');
  protected readonly scouting = signal(false);
  protected readonly canScoutBattle = computed(() => {
    return (
      this.auth.hasPermission('intel.create') ||
      this.auth.hasPermission('intel.manage')
    );
  });

  // Filter signals
  protected readonly selectedTimelineMinute = signal<number | null>(null);
  protected readonly killFeedFilter = signal<KillFeedFilter>('all');
  protected readonly killSearchQuery = signal<string>('');
  protected readonly playerFilterSide = signal<PlayerSideFilter>('all');
  protected readonly playerSearchQuery = signal<string>('');
  /** The kill whose gear is open in the dialog, or null when it is closed. */
  protected readonly gearKill = signal<BattleKillEvent | null>(null);

  protected readonly tabOptions = computed<TabOption[]>(() => {
    const detail = this.battle();
    return [
      { id: 'overview', label: this.t('battles.overview') },
      { id: 'players', label: this.t('battles.players'), count: detail?.players.length ?? 0 },
      { id: 'guilds', label: this.t('battles.guilds'), count: detail?.guilds.length ?? 0 },
      { id: 'kills', label: this.t('battles.kill_feed'), count: detail?.kills.length ?? 0 },
    ];
  });

  protected readonly killFilterOptions = computed<TabOption[]>(() => {
    const kills = this.battle()?.kills ?? [];
    return [
      { id: 'all', label: this.t('battles.filter_all'), count: kills.length },
      { id: 'our_kills', label: this.t('battles.filter_our_kills'), count: this.ourKillCount() },
      { id: 'our_deaths', label: this.t('battles.filter_our_deaths'), count: this.ourDeathCount() },
      {
        id: 'high_fame',
        label: this.t('battleDetail.filter.highFame'),
        count: kills.filter((k) => k.total_kill_fame >= HIGH_FAME_THRESHOLD).length,
      },
    ];
  });

  protected readonly playerSideOptions = computed<TabOption[]>(() => [
    { id: 'all', label: this.t('battles.filter_all'), count: this.battle()?.players.length ?? 0 },
    { id: 'our_guild', label: this.t('battleDetail.ourGuild'), count: this.ourGuildPlayers().length },
    { id: 'allies', label: this.t('battles.filter_allies'), count: this.allyPlayersCount() },
    { id: 'enemies', label: this.t('battles.filter_enemies'), count: this.enemyPlayersCount() },
  ]);

  /** Our guild, or our guild inside its alliance, as one display label. */
  protected readonly ourForceLabel = computed<string | null>(() => {
    const guild = this.ourGuild();
    if (!guild) return null;
    const alliance = this.ourGuildAllianceName();
    return alliance ? `[${alliance}] ${guild.name}` : guild.name;
  });

  protected readonly menuItems = computed<MenuItem[]>(() => [
    { id: 'copy', label: this.t('battles.copy_link') },
    { id: 'albion', label: this.t('battles.view_on_albion_battles') },
  ]);

  /** Header band of key numbers, derived from the battle and our guild. */
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const ours = this.ourGuild();
    return [
      {
        label: this.t('battles.total_fame'),
        value: this.formatCompact(detail.total_fame),
        hint: this.t('battleDetail.hint.ourShare', { share: this.formatDecimal(this.ourAllianceFameShare()) }),
      },
      {
        label: `${this.t('battles.kills')} / ${this.t('battles.deaths')}`,
        value: `${this.formatAmount(detail.total_kills)} / ${this.formatAmount(this.totalBattleDeaths())}`,
        hint: this.t('battleDetail.hint.ourKd', { kd: this.formatDecimal(this.ourGuildKdRatio()) }),
      },
      {
        label: this.t('battles.kill_participation'),
        value: `${this.formatDecimal(this.ourKillParticipation())}%`,
        hint: this.t('battleDetail.hint.ourKills', { count: ours?.kills ?? 0 }),
      },
      {
        label: this.t('battles.avg_ip'),
        value: this.formatDecimal(this.ourGuildAvgIp()),
        hint: this.t('battleDetail.hint.battleAvg', { avg: this.formatDecimal(this.battleAvgIp()) }),
      },
      {
        label: this.t('battles.silver_lost'),
        value: this.formatCompact(detail.estimated_losses.total_estimated_loss),
        hint: this.t('battleDetail.hint.pricedItems', {
          priced: detail.estimated_losses.priced_items,
          total: detail.estimated_losses.total_items,
        }),
      },
      {
        label: this.t('battles.survival_rate'),
        value: `${this.formatDecimal(this.ourSurvivalRate())}%`,
        hint: this.t('battleDetail.hint.survived', {
          surviving: this.ourSurvivingCount(),
          players: ours?.players ?? 0,
        }),
      },
    ];
  });

  /** Our side against the enemy forces, one row each. */
  protected readonly matchupRows = computed<MatchupRow[]>(() => {
    const ours = this.ourAlliance();
    const guild = this.ourGuild();
    const enemyAlliance = this.topEnemyAlliance();
    const enemyGuild = this.topEnemyGuild();
    return [
      {
        key: 'ours',
        side: this.t('battles.allies'),
        force: this.ourForceLabel() ?? '—',
        players: ours?.players ?? guild?.players ?? 0,
        kills: ours?.kills ?? guild?.kills ?? 0,
        deaths: ours?.deaths ?? guild?.deaths ?? 0,
        kdRatio: ours?.kdRatio ?? this.ourGuildKdRatio(),
        killFame: ours?.killFame ?? guild?.kill_fame ?? 0,
      },
      {
        key: 'enemies',
        side: this.t('battles.enemies'),
        force: enemyAlliance
          ? `[${enemyAlliance.name}]`
          : (enemyGuild?.name ?? this.t('battleDetail.hostileCoalition')),
        players: this.enemyForcesPlayers(),
        kills: this.enemyForcesKills(),
        deaths: this.enemyForcesDeaths(),
        kdRatio: this.enemyForcesKdRatio(),
        killFame: this.enemyForcesKillFame(),
      },
    ];
  });

  /** Our guild's standout players, one row per honour. */
  protected readonly honorRows = computed<HonorRow[]>(() => {
    const killer = this.guildMvpKiller();
    const fame = this.guildMvpFame();
    const ip = this.guildMvpHighestIp();
    const survivor = this.guildMvpSurvivor();
    const loss = this.guildHeaviestLoss();
    return [
      {
        id: 'killer',
        labelKey: 'battles.mvp_killer',
        player: killer,
        value: killer ? this.t('battleDetail.hint.kills', { count: killer.kills }) : '',
      },
      {
        id: 'fame',
        labelKey: 'battles.mvp_fame',
        player: fame,
        value: fame ? this.t('battleDetail.hint.fame', { amount: this.formatCompact(fame.kill_fame) }) : '',
      },
      {
        id: 'ip',
        labelKey: 'battles.mvp_ip',
        player: ip,
        value: ip ? this.t('battleDetail.hint.ip', { value: this.formatDecimal(ip.item_power) }) : '',
      },
      {
        id: 'survivor',
        labelKey: 'battles.mvp_survivor',
        player: survivor,
        value: survivor ? this.t('battleDetail.hint.survivor', { kills: survivor.kills }) : '',
      },
      {
        id: 'loss',
        labelKey: 'battles.heaviest_loss',
        player: loss,
        value: loss ? this.t('battleDetail.hint.lost', { amount: this.formatCompact(loss.estimatedLoss) }) : '',
      },
    ];
  });

  // Our guild, as decided by the backend from the tenant's Albion scope
  // (`is_own`, or the first `is_friendly` guild for an alliance tenant). The
  // Discord server name is never compared, and no guild is guessed.
  protected readonly ourGuild = computed<BattleGuildSummary | null>(() => {
    const detail = this.battle();
    if (!detail) return null;
    return detail.guilds.find((g) => g.is_own) ?? detail.guilds.find((g) => g.is_friendly) ?? null;
  });

  // Cross-hydrated map of guild name -> alliance name from all available payload nodes
  protected readonly guildAllianceMap = computed<Map<string, string>>(() => {
    const detail = this.battle();
    const map = new Map<string, string>();
    if (!detail) return map;

    // 1. From guilds list
    for (const g of detail.guilds) {
      if (g.alliance_name?.trim()) {
        map.set(g.name.toLowerCase(), g.alliance_name.trim());
      }
    }

    // 2. From players list
    for (const p of detail.players) {
      if (p.guild_name?.trim() && p.alliance_name?.trim()) {
        const key = p.guild_name.toLowerCase();
        if (!map.has(key)) {
          map.set(key, p.alliance_name.trim());
        }
      }
    }

    // 3. From kills list & raw payloads
    for (const k of detail.kills) {
      if (k.killer.guild_name?.trim() && k.killer.alliance_name?.trim()) {
        const key = k.killer.guild_name.toLowerCase();
        if (!map.has(key)) map.set(key, k.killer.alliance_name.trim());
      }
      if (k.victim.guild_name?.trim() && k.victim.alliance_name?.trim()) {
        const key = k.victim.guild_name.toLowerCase();
        if (!map.has(key)) map.set(key, k.victim.alliance_name.trim());
      }

      // From raw Killer
      const rawKiller = this.readObject(k.raw, 'Killer') ?? this.readObject(k.raw, 'killer');
      if (rawKiller) {
        const gName = (this.readString(rawKiller, 'GuildName') ?? this.readString(rawKiller, 'guildName'))?.toLowerCase();
        const ally = this.extractAllianceFromRaw(rawKiller);
        if (gName && ally && !map.has(gName)) map.set(gName, ally);
      }

      // From raw Victim
      const rawVictim = this.readObject(k.raw, 'Victim') ?? this.readObject(k.raw, 'victim');
      if (rawVictim) {
        const gName = (this.readString(rawVictim, 'GuildName') ?? this.readString(rawVictim, 'guildName'))?.toLowerCase();
        const ally = this.extractAllianceFromRaw(rawVictim);
        if (gName && ally && !map.has(gName)) map.set(gName, ally);
      }

      // From raw GroupMembers
      const groupMembers = (this.readObject(k.raw, 'GroupMembers') ?? this.readObject(k.raw, 'groupMembers')) as unknown;
      if (Array.isArray(groupMembers)) {
        for (const member of groupMembers) {
          const gName = (this.readString(member, 'GuildName') ?? this.readString(member, 'guildName'))?.toLowerCase();
          const ally = this.extractAllianceFromRaw(member);
          if (gName && ally && !map.has(gName)) map.set(gName, ally);
        }
      }
    }

    return map;
  });

  protected readonly ourGuildAllianceName = computed<string | null>(() => {
    const g = this.ourGuild();
    if (!g) return null;
    return g.alliance_name?.trim() || this.guildAllianceMap().get(g.name.toLowerCase()) || null;
  });

  // Alliances Computation with fallback extraction
  protected readonly alliances = computed<AllianceSummary[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const allyMap = this.guildAllianceMap();
    const map = new Map<string, { isSolo: boolean; guilds: BattleGuildSummary[] }>();

    // Grouped case-insensitively: an alliance or solo guild name reported with
    // inconsistent casing across guild rows must not be split into two groups.
    const groupNames = new Map<string, string>();
    for (const guild of detail.guilds) {
      const resolvedAlly = guild.alliance_name?.trim() || allyMap.get(guild.name.toLowerCase()) || null;
      const groupName = resolvedAlly ? resolvedAlly : `[SOLO] ${guild.name}`;
      const groupKey = groupName.toLowerCase();
      const isSolo = !resolvedAlly;

      if (!groupNames.has(groupKey)) {
        groupNames.set(groupKey, groupName);
      }
      const entry = map.get(groupKey) ?? { isSolo, guilds: [] };
      entry.guilds.push({
        ...guild,
        alliance_name: resolvedAlly,
      });
      map.set(groupKey, entry);
    }

    const summaries: AllianceSummary[] = [];
    for (const [key, entry] of map.entries()) {
      const { isSolo, guilds } = entry;
      const name = isSolo ? guilds[0].name : (groupNames.get(key) ?? key);
      const players = guilds.reduce((sum, g) => sum + g.players, 0);
      const kills = guilds.reduce((sum, g) => sum + g.kills, 0);
      const deaths = guilds.reduce((sum, g) => sum + g.deaths, 0);
      const killFame = guilds.reduce((sum, g) => sum + g.kill_fame, 0);
      const isOurAlliance = guilds.some((g) => g.is_friendly === true);

      // Aggregate player death fame & avg ip for this alliance
      const allyPlayers = detail.players.filter((p) =>
        guilds.some((g) => g.id === p.guild_id || g.name.toLowerCase() === p.guild_name.toLowerCase()),
      );
      const deathFame = allyPlayers.reduce((sum, p) => sum + p.death_fame, 0);
      const avgIp = this.average(allyPlayers.map((p) => p.item_power));

      // Aggregate estimated loss
      const estimatedLoss = (detail.estimated_losses?.guilds ?? [])
        .filter((loss) => guilds.some((g) => g.name.toLowerCase() === loss.guild_name.toLowerCase()))
        .reduce((sum, loss) => sum + loss.estimated_loss, 0);

      summaries.push({
        name,
        isSolo,
        isOurAlliance,
        guilds,
        players,
        kills,
        deaths,
        killFame,
        deathFame,
        netFame: killFame - deathFame,
        kdRatio: deaths === 0 ? (kills > 0 ? kills : 0) : kills / deaths,
        avgIp,
        estimatedLoss,
      });
    }

    return summaries.sort((a, b) => b.killFame - a.killFame);
  });

  protected readonly ourAlliance = computed<AllianceSummary | null>(() => {
    return this.alliances().find((a) => a.isOurAlliance) ?? null;
  });

  protected readonly topEnemyAlliance = computed<AllianceSummary | null>(() => {
    return this.alliances().find((a) => !a.isOurAlliance && !a.isSolo) ?? null;
  });

  protected readonly topEnemyGuild = computed<BattleGuildSummary | null>(() => {
    const detail = this.battle();
    if (!detail) return null;
    return (
      detail.guilds
        .filter((g) => g.is_friendly !== true)
        .sort((a, b) => b.kill_fame - a.kill_fame)[0] ?? null
    );
  });

  // Renders the verdict `GET /api/battles/{id}` already resolved. The browser
  // used to score the battle itself against its own fame thresholds, which is
  // how the same battle could read "Victory" in the list and "Contested" here.
  protected readonly verdict = computed<{ label: string; tone: OutcomeTone }>(() => {
    const type: BattleOutcomeType = this.battle()?.outcome ?? 'unknown';
    const tone: OutcomeTone =
      type === 'victory' ? 'success' : type === 'defeat' ? 'error' : type === 'draw' ? 'warning' : 'neutral';
    return { label: this.t(battleOutcomeLabel(type)), tone };
  });

  // Enemy forces totals
  protected readonly enemyForcesPlayers = computed(() => {
    const ourCount = this.ourAlliance()?.players ?? this.ourGuild()?.players ?? 0;
    return Math.max(0, (this.battle()?.total_players ?? 0) - ourCount);
  });

  protected readonly enemyForcesKills = computed(() => {
    const ourKills = this.ourAlliance()?.kills ?? this.ourGuild()?.kills ?? 0;
    return Math.max(0, (this.battle()?.total_kills ?? 0) - ourKills);
  });

  protected readonly enemyForcesDeaths = computed(() => {
    const ourDeaths = this.ourAlliance()?.deaths ?? this.ourGuild()?.deaths ?? 0;
    return Math.max(0, this.totalBattleDeaths() - ourDeaths);
  });

  protected readonly enemyForcesKillFame = computed(() => {
    const ourFame = this.ourAlliance()?.killFame ?? this.ourGuild()?.kill_fame ?? 0;
    return Math.max(0, (this.battle()?.total_fame ?? 0) - ourFame);
  });

  protected readonly enemyForcesKdRatio = computed(() => {
    const kills = this.enemyForcesKills();
    const deaths = this.enemyForcesDeaths();
    return deaths === 0 ? (kills > 0 ? kills : 0) : kills / deaths;
  });

  // Timeline Buckets computation
  protected readonly timelineBuckets = computed<TimelineMinuteBucket[]>(() => {
    const detail = this.battle();
    if (!detail || detail.kills.length === 0) return [];
    const startTime = new Date(detail.start_time).getTime();

    const minuteMap = new Map<
      number,
      { ourKills: number; ourDeaths: number; enemyKills: number; fame: number; ourFame: number; enemyFame: number }
    >();

    for (const kill of detail.kills) {
      const killTime = new Date(kill.time).getTime();
      const minute = Math.max(0, Math.floor((killTime - startTime) / 60000));
      const isOurKiller = this.isOurGuildParticipant(kill.killer);
      const isOurVictim = this.isOurGuildParticipant(kill.victim);

      const bucket = minuteMap.get(minute) ?? {
        ourKills: 0,
        ourDeaths: 0,
        enemyKills: 0,
        fame: 0,
        ourFame: 0,
        enemyFame: 0,
      };
      if (isOurKiller) {
        bucket.ourKills += 1;
        bucket.ourFame += kill.total_kill_fame;
      } else {
        bucket.enemyKills += 1;
        bucket.enemyFame += kill.total_kill_fame;
      }
      if (isOurVictim) {
        bucket.ourDeaths += 1;
      }
      bucket.fame += kill.total_kill_fame;
      minuteMap.set(minute, bucket);
    }

    const durationMinutes = Math.max(...Array.from(minuteMap.keys()), 0);
    const result: TimelineMinuteBucket[] = [];

    for (let m = 0; m <= durationMinutes; m++) {
      const data = minuteMap.get(m) ?? {
        ourKills: 0,
        ourDeaths: 0,
        enemyKills: 0,
        fame: 0,
        ourFame: 0,
        enemyFame: 0,
      };
      result.push({
        minute: m,
        label: `${m}m`,
        ourKills: data.ourKills,
        ourDeaths: data.ourDeaths,
        enemyKills: data.enemyKills,
        totalKills: data.ourKills + data.enemyKills,
        fame: data.fame,
        ourFame: data.ourFame,
        enemyFame: data.enemyFame,
      });
    }

    return result;
  });

  // Top Guilds sorted by KD
  protected readonly topKdGuilds = computed<GuildEnrichedRow[]>(() => {
    return [...this.enrichedGuildRows()]
      .sort((a, b) => b.kdRatio - a.kdRatio)
      .slice(0, 8);
  });

  // Enriched Guild Rows
  protected readonly enrichedGuildRows = computed<GuildEnrichedRow[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const allyMap = this.guildAllianceMap();

    return detail.guilds.map((g) => {
      const isOurGuild = g.is_own === true;
      const alliance_name = g.alliance_name?.trim() || allyMap.get(g.name.toLowerCase()) || null;
      const isOurAlliance = g.is_friendly === true;
      const kdRatio = g.deaths === 0 ? (g.kills > 0 ? g.kills : 0) : g.kills / g.deaths;
      const famePerPlayer = this.safeDivide(g.kill_fame, g.players);
      const estimatedLoss = (detail.estimated_losses?.guilds ?? []).find(
        (loss) => loss.guild_name.toLowerCase() === g.name.toLowerCase(),
      )?.estimated_loss ?? 0;

      return {
        ...g,
        alliance_name,
        isOurGuild,
        isOurAlliance,
        kdRatio,
        famePerPlayer,
        estimatedLoss,
      };
    });
  });

  // Enriched Player Rows
  protected readonly enrichedPlayerRows = computed<PlayerEnrichedRow[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const ourGuildName = this.ourGuild()?.name.toLowerCase();
    const allyMap = this.guildAllianceMap();

    return detail.players.map((p) => {
      const alliance_name = p.alliance_name?.trim() || allyMap.get(p.guild_name.toLowerCase()) || null;
      const isOurAlliance = p.is_friendly === true;
      // `ourGuildName` is the backend-flagged own guild, not the tenant name.
      const isOurGuild = isOurAlliance && p.guild_name.toLowerCase() === ourGuildName;
      const weaponType = this.findPlayerWeaponType(p.name, detail.kills);
      const role = this.inferRoleFromWeapon(weaponType);
      const netFame = p.kill_fame - p.death_fame;
      const kdRatio = p.deaths === 0 ? (p.kills > 0 ? p.kills : 0) : p.kills / p.deaths;
      const estimatedLoss = (detail.estimated_losses?.players ?? []).find(
        (loss) => loss.player_name.toLowerCase() === p.name.toLowerCase(),
      )?.estimated_loss ?? 0;

      return {
        ...p,
        alliance_name,
        isOurGuild,
        isOurAlliance,
        role,
        weaponType,
        weaponName: this.cleanWeaponName(weaponType),
        netFame,
        kdRatio,
        estimatedLoss,
      };
    });
  });

  // Guild Roster (Our Guild Players)
  protected readonly ourGuildPlayers = computed<PlayerEnrichedRow[]>(() => {
    return this.enrichedPlayerRows().filter((p) => p.isOurGuild);
  });

  // Filtered All Players
  protected readonly filteredAllPlayerRows = computed<PlayerEnrichedRow[]>(() => {
    let rows = this.enrichedPlayerRows();
    const side = this.playerFilterSide();
    if (side === 'our_guild') {
      rows = rows.filter((p) => p.isOurGuild);
    } else if (side === 'allies') {
      rows = rows.filter((p) => p.isOurAlliance || p.isOurGuild);
    } else if (side === 'enemies') {
      rows = rows.filter((p) => !p.isOurAlliance && !p.isOurGuild);
    }

    const query = this.playerSearchQuery().trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.guild_name.toLowerCase().includes(query) ||
        p.weaponName.toLowerCase().includes(query),
    );
  });

  // Filtered Kills
  protected readonly filteredKillRows = computed<BattleKillEvent[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    let kills = detail.kills;

    // Timeline minute filter
    const min = this.selectedTimelineMinute();
    if (min !== null) {
      const startTime = new Date(detail.start_time).getTime();
      kills = kills.filter((k) => {
        const killMinute = Math.max(0, Math.floor((new Date(k.time).getTime() - startTime) / 60000));
        return killMinute === min;
      });
    }

    // Side filter
    const filter = this.killFeedFilter();
    if (filter === 'our_kills') {
      kills = kills.filter((k) => this.isOurGuildParticipant(k.killer));
    } else if (filter === 'our_deaths') {
      kills = kills.filter((k) => this.isOurGuildParticipant(k.victim));
    } else if (filter === 'high_fame') {
      kills = kills.filter((k) => k.total_kill_fame >= HIGH_FAME_THRESHOLD);
    }

    // Search query
    const query = this.killSearchQuery().trim().toLowerCase();
    if (!query) return kills;
    return kills.filter(
      (k) =>
        k.killer.name.toLowerCase().includes(query) ||
        k.victim.name.toLowerCase().includes(query) ||
        (k.killer.guild_name && k.killer.guild_name.toLowerCase().includes(query)) ||
        (k.victim.guild_name && k.victim.guild_name.toLowerCase().includes(query)),
    );
  });

  // Guild MVP Computations
  protected readonly guildMvpKiller = computed<PlayerEnrichedRow | null>(() => {
    return [...this.ourGuildPlayers()].sort((a, b) => b.kills - a.kills)[0] ?? null;
  });

  protected readonly guildMvpFame = computed<PlayerEnrichedRow | null>(() => {
    return [...this.ourGuildPlayers()].sort((a, b) => b.kill_fame - a.kill_fame)[0] ?? null;
  });

  protected readonly guildMvpHighestIp = computed<PlayerEnrichedRow | null>(() => {
    return [...this.ourGuildPlayers()].sort((a, b) => b.item_power - a.item_power)[0] ?? null;
  });

  protected readonly guildMvpSurvivor = computed<PlayerEnrichedRow | null>(() => {
    return (
      [...this.ourGuildPlayers()]
        .filter((p) => p.deaths === 0 && p.kills > 0)
        .sort((a, b) => b.kills - a.kills)[0] ?? null
    );
  });

  protected readonly guildHeaviestLoss = computed<PlayerEnrichedRow | null>(() => {
    return (
      [...this.ourGuildPlayers()]
        .filter((p) => p.estimatedLoss > 0)
        .sort((a, b) => b.estimatedLoss - a.estimatedLoss)[0] ?? null
    );
  });

  // KPI Calculations
  protected readonly totalBattleDeaths = computed(() => {
    const detail = this.battle();
    return detail ? detail.guilds.reduce((sum, g) => sum + g.deaths, 0) : 0;
  });

  protected readonly ourAllianceFameShare = computed(() => {
    const detail = this.battle();
    if (!detail || detail.total_fame <= 0) return 0;
    const fame = this.ourAlliance()?.killFame ?? this.ourGuild()?.kill_fame ?? 0;
    return this.percentage(fame, detail.total_fame);
  });

  protected readonly ourGuildKdRatio = computed(() => {
    const g = this.ourGuild();
    if (!g) return 0;
    return g.deaths === 0 ? (g.kills > 0 ? g.kills : 0) : g.kills / g.deaths;
  });

  protected readonly ourKillParticipation = computed(() => {
    const detail = this.battle();
    if (!detail || detail.total_kills <= 0) return 0;
    const ourKills = this.ourAlliance()?.kills ?? this.ourGuild()?.kills ?? 0;
    return this.percentage(ourKills, detail.total_kills);
  });

  protected readonly ourGuildAvgIp = computed(() => {
    const players = this.ourGuildPlayers();
    return this.average(players.map((p) => p.item_power));
  });

  protected readonly battleAvgIp = computed(() => {
    const detail = this.battle();
    if (!detail) return 0;
    return this.average(detail.players.map((p) => p.item_power));
  });

  protected readonly ourSurvivalRate = computed(() => {
    const g = this.ourGuild();
    if (!g || g.players <= 0) return 0;
    const survived = Math.max(0, g.players - g.deaths);
    return (survived / g.players) * 100;
  });

  protected readonly ourSurvivingCount = computed(() => {
    const g = this.ourGuild();
    return g ? Math.max(0, g.players - g.deaths) : 0;
  });

  protected readonly allyPlayersCount = computed(() => {
    return this.enrichedPlayerRows().filter((p) => p.isOurAlliance || p.isOurGuild).length;
  });

  protected readonly enemyPlayersCount = computed(() => {
    return this.enrichedPlayerRows().filter((p) => !p.isOurAlliance && !p.isOurGuild).length;
  });

  protected readonly ourKillCount = computed(() => {
    return this.battle()?.kills.filter((k) => this.isOurGuildParticipant(k.killer)).length ?? 0;
  });

  protected readonly ourDeathCount = computed(() => {
    return this.battle()?.kills.filter((k) => this.isOurGuildParticipant(k.victim)).length ?? 0;
  });

  /* ------------------------------ Chart option builders ------------------------------ */

  /** Shared grid skeleton so every plot on this page lines up the same way. */
  private baseGrid(bottom: number): EChartsOption['grid'] {
    return { left: 4, right: 16, top: 24, bottom, containLabel: true };
  }

  private valueAxisLabel(): Record<string, unknown> {
    return { formatter: (value: number) => this.formatCompact(value), hideOverlap: true };
  }

  /** Vertical gradient under a line, fading to nothing at the baseline. */
  private areaFill(color: string): Record<string, unknown> {
    return {
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: `${color}3d` },
          { offset: 1, color: `${color}00` },
        ],
      },
    };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Fame Distribution by Alliance — horizontal bar, our alliance emphasised
  protected readonly allianceFameOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const chrome = this.chrome();
    const rows = [...this.alliances()].sort((a, b) => a.killFame - b.killFame);

    return {
      aria: { enabled: true },
      grid: this.baseGrid(4),
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', splitNumber: 3, axisLabel: this.valueAxisLabel() },
      yAxis: {
        type: 'category',
        data: rows.map((a) => (a.isSolo ? a.name : `[${a.name}]`)),
        axisLabel: { width: 110, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((a) => ({
            value: a.killFame,
            itemStyle: {
              color: a.isOurAlliance ? palette.ally : chrome.axis,
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 16,
          barCategoryGap: '42%',
        },
      ],
    };
  });

  protected readonly allianceFameTableHead = computed(() => [
    this.t('battles.alliance'),
    this.t('battles.kill_fame'),
    this.t('battles.fame_share'),
  ]);

  protected readonly allianceFameTableRows = computed<ChartTableRow[]>(() => {
    const totalFame = this.battle()?.total_fame ?? 0;
    return this.alliances().map((a) => [
      a.isSolo ? a.name : `[${a.name}]`,
      this.formatAmount(a.killFame),
      `${this.formatDecimal(this.percentage(a.killFame, totalFame))}%`,
    ]);
  });

  // Top Guilds by K/D — horizontal bar, our guild emphasised
  protected readonly topGuildsKdOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const chrome = this.chrome();
    const rows = [...this.topKdGuilds()].sort((a, b) => a.kdRatio - b.kdRatio);

    return {
      aria: { enabled: true },
      grid: this.baseGrid(4),
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', splitNumber: 3, axisLabel: this.valueAxisLabel() },
      yAxis: {
        type: 'category',
        data: rows.map((g) => g.name),
        axisLabel: { width: 110, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((g) => ({
            value: Math.round(g.kdRatio * 100) / 100,
            itemStyle: {
              color: g.isOurGuild ? palette.ally : chrome.axis,
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 16,
          barCategoryGap: '42%',
        },
      ],
    };
  });

  protected readonly topGuildsKdTableHead = computed(() => [
    this.t('common.name'),
    this.t('battles.kill_death'),
    this.t('battles.kills'),
    this.t('battles.deaths'),
  ]);

  protected readonly topGuildsKdTableRows = computed<ChartTableRow[]>(() =>
    this.topKdGuilds().map((g) => [
      g.name,
      this.formatDecimal(g.kdRatio),
      this.formatAmount(g.kills),
      this.formatAmount(g.deaths),
    ]),
  );

  // Timeline density — stacked bar, ours vs enemy kills per minute
  protected readonly timelineDensityOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const buckets = this.timelineBuckets();
    const zoomable = buckets.length > 20;

    return {
      aria: { enabled: true },
      grid: this.baseGrid(zoomable ? 46 : 8),
      legend: { top: 0, left: 0 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: buckets.map((b) => b.label) },
      yAxis: { type: 'value', minInterval: 1, axisLabel: this.valueAxisLabel() },
      dataZoom: zoomable
        ? [
            { type: 'inside', filterMode: 'none' },
            { type: 'slider', height: 16, bottom: 6, filterMode: 'none' },
          ]
        : undefined,
      series: [
        {
          name: this.t('battles.filter_our_kills'),
          type: 'bar',
          stack: 'kills',
          data: buckets.map((b) => b.ourKills),
          itemStyle: { color: palette.ally },
          barMaxWidth: 22,
        },
        {
          name: this.t('battles.enemy_kills'),
          type: 'bar',
          stack: 'kills',
          data: buckets.map((b) => b.enemyKills),
          itemStyle: { color: palette.enemy },
          barMaxWidth: 22,
        },
      ],
    };
  });

  protected readonly timelineDensityTableHead = computed(() => [
    this.t('battles.minute'),
    this.t('battles.filter_our_kills'),
    this.t('battles.enemy_kills'),
    this.t('battles.kills'),
  ]);

  protected readonly timelineDensityTableRows = computed<ChartTableRow[]>(() =>
    this.timelineBuckets().map((b) => [
      b.label,
      this.formatAmount(b.ourKills),
      this.formatAmount(b.enemyKills),
      this.formatAmount(b.totalKills),
    ]),
  );

  // Battle momentum — cumulative fame swing per minute, diverging area
  protected readonly momentumOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const chrome = this.chrome();
    const buckets = this.timelineBuckets();
    let running = 0;
    const cumulative = buckets.map((b) => (running += b.ourFame - b.enemyFame));
    const above = cumulative.map((v) => (v >= 0 ? v : null));
    const below = cumulative.map((v) => (v <= 0 ? v : null));

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', boundaryGap: false, data: buckets.map((b) => b.label) },
      yAxis: { type: 'value', axisLabel: this.valueAxisLabel() },
      series: [
        {
          name: this.t('battles.momentum_ally_lead'),
          type: 'line',
          data: above,
          symbol: 'none',
          connectNulls: false,
          lineStyle: { width: 2, color: palette.ally },
          itemStyle: { color: palette.ally },
          areaStyle: this.areaFill(palette.ally),
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: chrome.axis, type: 'dashed' },
            data: [{ yAxis: 0 }],
          },
        },
        {
          name: this.t('battles.momentum_enemy_lead'),
          type: 'line',
          data: below,
          symbol: 'none',
          connectNulls: false,
          lineStyle: { width: 2, color: palette.enemy },
          itemStyle: { color: palette.enemy },
          areaStyle: this.areaFill(palette.enemy),
        },
      ],
    };
  });

  protected readonly momentumTableHead = computed(() => [
    this.t('battles.minute'),
    this.t('battles.allies'),
    this.t('battles.enemies'),
    this.t('battles.net_fame'),
  ]);

  protected readonly momentumTableRows = computed<ChartTableRow[]>(() => {
    let running = 0;
    return this.timelineBuckets().map((b) => {
      running += b.ourFame - b.enemyFame;
      return [
        b.label,
        this.formatAmount(b.ourFame),
        this.formatAmount(b.enemyFame),
        `${running >= 0 ? '+' : ''}${this.formatAmount(running)}`,
      ];
    });
  });

  // Composition by side — allies vs enemies, stacked by role
  protected readonly roleDistributionBySide = computed<
    Array<{ role: CombatRole; allies: number; enemies: number }>
  >(() => {
    const roles: CombatRole[] = ['tank', 'healer', 'support', 'melee_dps', 'ranged_dps', 'other'];
    const counts = new Map<CombatRole, { allies: number; enemies: number }>(
      roles.map((role) => [role, { allies: 0, enemies: 0 }]),
    );
    for (const p of this.enrichedPlayerRows()) {
      const bucket = counts.get(p.role);
      if (!bucket) continue;
      if (p.isOurAlliance || p.isOurGuild) {
        bucket.allies += 1;
      } else {
        bucket.enemies += 1;
      }
    }
    return roles
      .map((role) => ({ role, ...counts.get(role)! }))
      .filter((r) => r.allies > 0 || r.enemies > 0);
  });

  protected readonly roleCompositionOption = computed<EChartsOption>(() => {
    const rows = this.roleDistributionBySide();
    const categories = [this.t('battles.allies'), this.t('battles.enemies')];

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      legend: { top: 0, left: 0 },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', minInterval: 1, axisLabel: this.valueAxisLabel() },
      yAxis: { type: 'category', data: categories },
      series: rows.map((r) => ({
        name: this.formatRoleName(r.role),
        type: 'bar' as const,
        stack: 'roles',
        data: [r.allies, r.enemies],
        barMaxWidth: 32,
      })),
    };
  });

  protected readonly roleCompositionTableHead = computed(() => [
    this.t('battles.role'),
    this.t('battles.allies'),
    this.t('battles.enemies'),
  ]);

  protected readonly roleCompositionTableRows = computed<ChartTableRow[]>(() =>
    this.roleDistributionBySide().map((r) => [
      this.formatRoleName(r.role),
      this.formatAmount(r.allies),
      this.formatAmount(r.enemies),
    ]),
  );

  // IP vs. net-fame performance — one scatter point per player
  protected readonly ipPerformanceOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const rows = this.enrichedPlayerRows();
    const allies = rows.filter((p) => p.isOurAlliance || p.isOurGuild);
    const enemies = rows.filter((p) => !p.isOurAlliance && !p.isOurGuild);
    const toPoint = (p: PlayerEnrichedRow) => ({ value: [p.item_power, p.netFame], name: p.name });

    return {
      aria: { enabled: true },
      grid: this.baseGrid(8),
      legend: { top: 0, left: 0 },
      tooltip: {
        trigger: 'item',
        formatter: (input: unknown) => {
          const param = input as { name?: string; value?: unknown };
          const value = Array.isArray(param.value) ? param.value : [0, 0];
          const name = this.escapeHtml(param.name ?? '');
          return `<strong>${name}</strong><br/>${this.t('battles.item_power')}: ${this.formatDecimal(
            Number(value[0]),
          )}<br/>${this.t('battles.net_fame')}: ${this.formatCompact(Number(value[1]))}`;
        },
      },
      xAxis: {
        type: 'value',
        name: this.t('battles.item_power'),
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: this.valueAxisLabel(),
      },
      yAxis: {
        type: 'value',
        name: this.t('battles.net_fame'),
        nameLocation: 'middle',
        nameGap: 48,
        axisLabel: this.valueAxisLabel(),
      },
      series: [
        {
          name: this.t('battles.allies'),
          type: 'scatter',
          data: allies.map(toPoint),
          symbolSize: 10,
          itemStyle: { color: palette.ally },
        },
        {
          name: this.t('battles.enemies'),
          type: 'scatter',
          data: enemies.map(toPoint),
          symbolSize: 10,
          itemStyle: { color: palette.enemy },
        },
      ],
    };
  });

  protected readonly ipPerformanceTableHead = computed(() => [
    this.t('common.name'),
    this.t('battles.side'),
    this.t('battles.item_power'),
    this.t('battles.net_fame'),
  ]);

  protected readonly ipPerformanceTableRows = computed<ChartTableRow[]>(() =>
    this.enrichedPlayerRows().map((p) => [
      p.name,
      p.isOurAlliance || p.isOurGuild ? this.t('battles.allies') : this.t('battles.enemies'),
      this.formatDecimal(p.item_power),
      `${p.netFame >= 0 ? '+' : ''}${this.formatAmount(p.netFame)}`,
    ]),
  );

  // Table Columns
  protected readonly guildColumns: readonly DataTableColumn<GuildEnrichedRow>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (g) => `${g.name} ${g.alliance_name ?? ''}`,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'players',
      label: 'battles.players',
      sortable: true,
      accessor: (g) => g.players,
      comparator: (a, b) => a.players - b.players,
      align: 'right',
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (g) => g.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (g) => g.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_death',
      label: 'battles.kill_death',
      sortable: true,
      accessor: (g) => g.kdRatio,
      comparator: (a, b) => a.kdRatio - b.kdRatio,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.total_fame',
      sortable: true,
      accessor: (g) => g.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
    {
      key: 'fame_per_player',
      label: 'battles.fame_efficiency',
      sortable: true,
      accessor: (g) => g.famePerPlayer,
      comparator: (a, b) => a.famePerPlayer - b.famePerPlayer,
      align: 'right',
    },
  ];

  protected readonly allianceColumns: readonly DataTableColumn<AllianceSummary>[] = [
    {
      key: 'name',
      label: 'battles.alliance',
      sortable: true,
      searchable: true,
      accessor: (a) => a.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'guilds',
      label: 'battles.guilds',
      sortable: true,
      accessor: (a) => a.guilds.length,
      comparator: (a, b) => a.guilds.length - b.guilds.length,
      align: 'right',
    },
    {
      key: 'players',
      label: 'battles.players',
      sortable: true,
      accessor: (a) => a.players,
      comparator: (a, b) => a.players - b.players,
      align: 'right',
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (a) => a.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (a) => a.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_death',
      label: 'battles.kill_death',
      sortable: true,
      accessor: (a) => a.kdRatio,
      comparator: (a, b) => a.kdRatio - b.kdRatio,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      accessor: (a) => a.killFame,
      comparator: (a, b) => a.killFame - b.killFame,
      align: 'right',
    },
    {
      key: 'net_fame',
      label: 'battles.net_fame',
      sortable: true,
      accessor: (a) => a.killFame - a.deathFame,
      comparator: (a, b) => a.killFame - a.deathFame - (b.killFame - b.deathFame),
      align: 'right',
    },
    {
      key: 'estimated_loss',
      label: 'battles.silver_lost',
      sortable: true,
      accessor: (a) => a.estimatedLoss,
      comparator: (a, b) => a.estimatedLoss - b.estimatedLoss,
      align: 'right',
    },
  ];

  protected readonly killColumns: readonly DataTableColumn<BattleKillEvent>[] = [
    {
      key: 'time',
      label: 'battles.time',
      sortable: true,
      accessor: (k) => k.time,
      comparator: (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    },
    {
      key: 'killer',
      label: 'battles.killer',
      accessor: (k) => k.killer.name,
    },
    {
      key: 'victim',
      label: 'battles.victim',
      accessor: (k) => k.victim.name,
    },
    {
      key: 'fame',
      label: 'battles.fame',
      sortable: true,
      accessor: (k) => k.total_kill_fame,
      comparator: (a, b) => a.total_kill_fame - b.total_kill_fame,
      align: 'right',
    },
    {
      key: 'item_power',
      label: 'battles.item_power',
      accessor: (k) => k.killer_item_power,
      align: 'right',
    },
    {
      key: 'gear',
      label: 'battles.gear',
      align: 'right',
    },
  ];

  protected readonly playerColumns: readonly DataTableColumn<PlayerEnrichedRow>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (p) => `${p.name} ${p.guild_name} ${p.alliance_name ?? ''}`,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'item_power',
      label: 'battles.item_power',
      sortable: true,
      accessor: (p) => p.item_power,
      comparator: (a, b) => a.item_power - b.item_power,
      align: 'right',
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (p) => p.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (p) => p.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      accessor: (p) => p.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
    {
      key: 'death_fame',
      label: 'battles.death_fame',
      sortable: true,
      accessor: (p) => p.death_fame,
      comparator: (a, b) => a.death_fame - b.death_fame,
      align: 'right',
    },
    {
      key: 'net_fame',
      label: 'battles.net_fame',
      sortable: true,
      accessor: (p) => p.netFame,
      comparator: (a, b) => a.netFame - b.netFame,
      align: 'right',
    },
    {
      key: 'estimated_loss',
      label: 'battles.silver_lost',
      sortable: true,
      accessor: (p) => p.estimatedLoss,
      comparator: (a, b) => a.estimatedLoss - b.estimatedLoss,
      align: 'right',
    },
  ];

  protected readonly trackAllianceRow = (a: AllianceSummary): unknown => a.name;
  protected readonly trackKillRow = (k: BattleKillEvent): unknown => k.event_id;
  protected readonly trackPlayerRow = (p: PlayerEnrichedRow): unknown => p.id || p.name;
  protected readonly trackGuildRow = (g: GuildEnrichedRow): unknown => g.id || g.name;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const battleId = Number(params.get('battleId'));
      if (battleId > 0) {
        void this.load(battleId);
      } else {
        this.toasts.error(this.t('common.error'));
        this.backToBattles();
      }
    });
  }

  protected backToBattles(): void {
    void this.router.navigate(['/battles']);
  }

  protected switchTab(tab: string): void {
    this.tab.set(tab as DetailTab);
  }

  protected setKillFeedFilter(filter: string): void {
    this.killFeedFilter.set(filter as KillFeedFilter);
  }

  protected setKillQuery(query: string): void {
    this.killSearchQuery.set(query);
  }

  protected setPlayerSide(side: string): void {
    this.playerFilterSide.set(side as PlayerSideFilter);
  }

  protected setPlayerQuery(query: string): void {
    this.playerSearchQuery.set(query);
  }

  /** A timeline column: filters the kill feed to that minute and opens the kill feed. */
  protected onTimelineChartClick(event: ChartClickEvent): void {
    const bucket = this.timelineBuckets()[event.dataIndex];
    if (!bucket) return;
    this.toggleTimelineMinute(bucket.minute);
    this.tab.set('kills');
  }

  protected toggleTimelineMinute(minute: number): void {
    this.selectedTimelineMinute.update((curr) => (curr === minute ? null : minute));
  }

  protected clearTimelineMinuteFilter(): void {
    this.selectedTimelineMinute.set(null);
  }

  protected openGear(kill: BattleKillEvent): void {
    this.gearKill.set(kill);
  }

  protected closeGear(): void {
    this.gearKill.set(null);
  }

  protected onMenu(id: string): void {
    const detail = this.battle();
    if (!detail) return;
    if (id === 'copy') {
      void this.copyBattleLink();
    } else if (id === 'albion') {
      window.open(albionBattlesUrl(detail.battle_id), '_blank', 'noopener,noreferrer');
    }
  }

  protected async copyBattleLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      this.toasts.success(this.t('battles.link_copied'));
    } catch {
      this.toasts.error(this.t('battleDetail.copyFailed'));
    }
  }

  // Formatters
  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString(this.translate.locale());
  }

  protected formatTime(isoDate: string): string {
    return new Date(isoDate).toLocaleTimeString(this.translate.locale());
  }

  protected formatTimeOffset(killIso: string, startIso: string): string {
    const offsetMs = Math.max(0, new Date(killIso).getTime() - new Date(startIso).getTime());
    const totalSec = Math.floor(offsetMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `+${m}:${s.toString().padStart(2, '0')}`;
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString(this.translate.locale());
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(this.translate.locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 1 }).format(value);
  }

  protected formatDuration(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): string {
    const ms = new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return this.t('battles.duration_unknown');
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  protected formatRoleName(role: CombatRole): string {
    switch (role) {
      case 'tank':
        return this.t('battles.tank');
      case 'healer':
        return this.t('battles.healer');
      case 'support':
        return this.t('battles.support');
      case 'melee_dps':
        return this.t('battles.melee_dps');
      case 'ranged_dps':
        return this.t('battles.ranged_dps');
      default:
        return this.t('battleDetail.role.other');
    }
  }

  protected percentage(value: number, total: number): number {
    return total <= 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100));
  }

  protected safeDivide(value: number, denominator: number): number {
    if (denominator <= 0 || !Number.isFinite(denominator)) return 0;
    return value / denominator;
  }

  protected average(values: readonly number[]): number {
    const valid = values.filter((v) => Number.isFinite(v) && v > 0);
    return valid.length === 0 ? 0 : valid.reduce((sum, v) => sum + v, 0) / valid.length;
  }

  protected itemIconUrl(itemType: string): string {
    return `${ALBION_RENDER_ITEM_BASE_URL}/${encodeURIComponent(itemType)}.png`;
  }

  protected participantWeaponIcon(kill: BattleKillEvent, side: KillSide): string {
    const weapon = this.extractWeaponType(kill.raw, side) ?? 'T4_MAIN_SWORD';
    return this.itemIconUrl(weapon);
  }

  protected isOurGuildParticipant(participant: { is_friendly?: boolean }): boolean {
    return participant.is_friendly === true;
  }

  protected resolveParticipantAlliance(participant: { guild_name?: string | null; alliance_name?: string | null }): string | null {
    if (participant.alliance_name?.trim()) return participant.alliance_name.trim();
    if (participant.guild_name?.trim()) {
      return this.guildAllianceMap().get(participant.guild_name.toLowerCase()) || null;
    }
    return null;
  }

  protected participantLoadout(kill: BattleKillEvent, side: KillSide): BuildItemSlot[] {
    const participantKey = side === 'killer' ? 'Killer' : 'Victim';
    const participant =
      this.readObject(kill.raw, participantKey) ??
      this.readObject(kill.raw, participantKey.toLowerCase());
    const equipment =
      this.readObject(participant, 'Equipment') ?? this.readObject(participant, 'equipment');
    if (!equipment) return [];

    const items: BuildItemSlot[] = [];
    for (const [upstreamKey, slot] of Object.entries(EQUIPMENT_SLOTS)) {
      const entry =
        this.readObject(equipment, upstreamKey) ??
        this.readObject(equipment, upstreamKey.charAt(0).toLowerCase() + upstreamKey.slice(1));
      const type = this.readString(entry, 'Type') ?? this.readString(entry, 'type');
      if (!type?.trim()) continue;

      items.push({
        // A killboard loadout is what the player was wearing, so it maps to the main set.
        loadout: 'main',
        slot,
        openalbion_item_type: slot,
        openalbion_item_id: 0,
        openalbion_item_name: this.cleanWeaponName(type),
        openalbion_item_icon: this.itemIconUrl(type),
        openalbion_item_tier: this.extractTier(type),
      });
    }
    return items;
  }

  private extractTier(type: string): string | null {
    const match = type.match(/^T(\d+)/i);
    return match ? `T${match[1]}` : null;
  }

  private cleanWeaponName(type: string | null): string {
    if (!type) return 'Unknown Weapon';
    const cleaned = type
      .replace(/^T\d+_/, '')
      .replace(/@\d+$/, '')
      .replace(/_/g, ' ')
      .toLowerCase();
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private extractWeaponType(raw: unknown, side: KillSide): string | null {
    const participantKey = side === 'killer' ? 'Killer' : 'Victim';
    const participant =
      this.readObject(raw, participantKey) ?? this.readObject(raw, participantKey.toLowerCase());
    const equipment =
      this.readObject(participant, 'Equipment') ?? this.readObject(participant, 'equipment');
    const mainHand =
      this.readObject(equipment, 'MainHand') ??
      this.readObject(equipment, 'mainHand') ??
      this.readObject(equipment, 'main_hand');
    const type = this.readString(mainHand, 'Type') ?? this.readString(mainHand, 'type');
    return type && type.trim().length > 0 ? type : null;
  }

  private extractAllianceFromRaw(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    for (const key of ['Alliance', 'alliance', 'AllianceName', 'allianceName', 'AllianceTag', 'allianceTag', 'alliance_name', 'alliance_tag', 'Tag', 'tag']) {
      const val = r[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }
    return null;
  }

  private findPlayerWeaponType(playerName: string, kills: readonly BattleKillEvent[]): string | null {
    for (const kill of kills) {
      if (kill.killer.name.toLowerCase() === playerName.toLowerCase()) {
        const weapon = this.extractWeaponType(kill.raw, 'killer');
        if (weapon) return weapon;
      }
      if (kill.victim.name.toLowerCase() === playerName.toLowerCase()) {
        const weapon = this.extractWeaponType(kill.raw, 'victim');
        if (weapon) return weapon;
      }
    }
    return null;
  }

  private inferPlayerRole(playerName: string, kills: readonly BattleKillEvent[]): CombatRole {
    const weapon = this.findPlayerWeaponType(playerName, kills);
    return this.inferRoleFromWeapon(weapon);
  }

  private inferRoleFromWeapon(weapon: string | null): CombatRole {
    if (!weapon) return 'other';
    const w = weapon.toUpperCase();
    if (
      w.includes('MACE') ||
      w.includes('HAMMER') ||
      w.includes('STAFF_ROCK') ||
      w.includes('FLAIL') ||
      w.includes('QUARTERSTAFF') ||
      w.includes('IRONCLAD') ||
      w.includes('GRAILSEEKER') ||
      w.includes('BLACKMONK')
    ) {
      return 'tank';
    }
    if (
      w.includes('HOLY') ||
      w.includes('DIVINE') ||
      w.includes('NATURE') ||
      w.includes('WILDSTAFF') ||
      w.includes('REDEMPTION') ||
      w.includes('HALLOWFALL') ||
      w.includes('FALLEN') ||
      w.includes('BLIGHT') ||
      w.includes('DRUIDIC') ||
      w.includes('BARKSTAFF')
    ) {
      return 'healer';
    }
    if (
      w.includes('ARCANE') ||
      w.includes('ENIGMATIC') ||
      w.includes('WITCHWORK') ||
      w.includes('LOCUS') ||
      w.includes('SHAPESHIFTER') ||
      w.includes('ROOTBOUND')
    ) {
      return 'support';
    }
    if (
      w.includes('SWORD') ||
      w.includes('CLAYMORE') ||
      w.includes('CARVING') ||
      w.includes('GALATINE') ||
      w.includes('KINGMAKER') ||
      w.includes('AXE') ||
      w.includes('HALBERD') ||
      w.includes('GREATAXE') ||
      w.includes('SCYTHE') ||
      w.includes('BEARPAWS') ||
      w.includes('REALM') ||
      w.includes('DAGGER') ||
      w.includes('CLAWS') ||
      w.includes('BLOODLETTER') ||
      w.includes('DEATHGIVERS') ||
      w.includes('SPEAR') ||
      w.includes('PIKE') ||
      w.includes('GLAIVE') ||
      w.includes('HERON') ||
      w.includes('SPIRITHUNTER') ||
      w.includes('GLOVES') ||
      w.includes('WARGLOVES') ||
      w.includes('URSINE') ||
      w.includes('HELLFIRE') ||
      w.includes('RAVEN')
    ) {
      return 'melee_dps';
    }
    if (
      w.includes('BOW') ||
      w.includes('LONGBOW') ||
      w.includes('WARBOW') ||
      w.includes('BADON') ||
      w.includes('CROSSBOW') ||
      w.includes('BOLTCASTER') ||
      w.includes('SIEGEBOW') ||
      w.includes('FIRE') ||
      w.includes('PYRO') ||
      w.includes('INFERNAL') ||
      w.includes('BLAZING') ||
      w.includes('DAWNSONG') ||
      w.includes('FROST') ||
      w.includes('GLACIAL') ||
      w.includes('ICICLE') ||
      w.includes('PERMAFROST') ||
      w.includes('CHILLHOWL') ||
      w.includes('CURSED') ||
      w.includes('DEMONIC') ||
      w.includes('SHADOWCALLER') ||
      w.includes('DAMNATION')
    ) {
      return 'ranged_dps';
    }
    return 'other';
  }

  private readObject(source: unknown, key: string): RawObject | null {
    if (!source || typeof source !== 'object') return null;
    const value = (source as RawObject)[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawObject) : null;
  }

  private readString(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') return null;
    const value = (source as RawObject)[key];
    return typeof value === 'string' ? value : null;
  }

  protected async scoutBattle(battleId: number): Promise<void> {
    if (this.scouting()) return;
    this.scouting.set(true);
    try {
      const outcomes = await firstValueFrom(this.intelService.scoutBattle(battleId));
      const count = outcomes.length;
      this.toasts.success(
        count === 1
          ? this.t('battleDetail.scoutDoneOne')
          : this.t('battleDetail.scoutDoneMany', { count }),
      );
      void this.router.navigate(['/intel/opponents']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.scouting.set(false);
    }
  }

  protected async load(targetId?: number): Promise<void> {
    const battleId = targetId ?? Number(this.route.snapshot.paramMap.get('battleId'));
    if (battleId <= 0) {
      this.toasts.error(this.t('common.error'));
      this.backToBattles();
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      this.battle.set(await firstValueFrom(this.api.get<BattleDetail>(`api/battles/${battleId}`)));
    } catch (error) {
      // A missing battle gets its own state; other failures get the retryable error.
      this.notFound.set(error instanceof HttpErrorResponse && error.status === 404);
      this.loadFailed.set(true);
      this.toasts.error(this.t(this.notFound() ? 'ui.errorState.notFound' : 'common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
