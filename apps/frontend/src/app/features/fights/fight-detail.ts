import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import type {
  BattleGuildSummary,
  BattleLossEstimate,
  BattlePlayer,
  FightDetail,
  FightMutationResult,
  MergeFightsRequest,
  MoveBattleRequest,
  ObservedFriendlyPlayer,
  PlannedFightParticipant,
  SplitFightRequest,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService } from '../../core/services/translate.service';
import { battleOutcomeLabel, type BattleOutcomeType } from '../battles/battle-outcome';
import { Avatar } from '../../shared/components/avatar/avatar';
import { Chart, type ChartTableRow } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { albionBattlesUrl, formatConfidence } from '../battles/battle-metrics';
import { Loading } from '../../shared/components/loading/loading';
import { EntityHeader, type EntityMenuItem } from '../../shared/components/entity-header/entity-header';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Menu } from '../../shared/components/menu/menu';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

export type FightTab = 'overview' | 'guilds' | 'players' | 'roster' | 'segments';

export type CombatRole = 'tank' | 'healer' | 'support' | 'melee_dps' | 'ranged_dps' | 'other';

export interface FightGuildRow extends BattleGuildSummary {
  readonly isOurGuild: boolean;
  readonly isOurAlliance: boolean;
  readonly kdRatio: number;
  readonly famePerPlayer: number;
  readonly estimatedLoss: number;
  readonly death_fame?: number;
}

export interface FightPlayerRow extends BattlePlayer {
  readonly isOurGuild: boolean;
  readonly isOurAlliance: boolean;
  readonly role: CombatRole;
  readonly kdRatio: number;
  readonly estimatedLoss: number;
}

export interface FightAllianceSummary {
  readonly name: string;
  readonly isSolo: boolean;
  readonly isOurAlliance: boolean;
  readonly guilds: readonly FightGuildRow[];
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

export interface FightSideRow {
  readonly key: string;
  readonly label: string;
  readonly ours: string;
  readonly enemy: string;
}

export interface FightHonorRow {
  readonly id: string;
  readonly label: string;
  readonly player: FightPlayerRow | null;
  readonly value: string;
  readonly emptyText: string;
}

export interface FightSegmentRow {
  readonly battleId: string;
  readonly index: number;
  readonly kills: number | null;
  readonly players: number | null;
}

type PendingFightMutation =
  | { readonly kind: 'merge'; readonly body: MergeFightsRequest; readonly description: string }
  | { readonly kind: 'split'; readonly body: SplitFightRequest; readonly description: string }
  | { readonly kind: 'move'; readonly battleId: number; readonly body: MoveBattleRequest; readonly description: string };

/**
 * Tactical analytics war room for a canonical Albion Online fight.
 *
 * Aggregates combat performance across all attached battle segments,
 * multi-alliance matchups, guild and player MVPs, gear losses, and roster evidence.
 */
@Component({
  selector: 'app-fight-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    Chart,
    DataTable,
    DataTableCell,
    Dialog,
    EntityHeader,
    ErrorState,
    FilterBar,
    Loading,
    Menu,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  template: `
    @if (loading()) {
      <app-loading [variant]="'detail'" [label]="t('common.loading')" />
    } @else if (notFound()) {
      <app-error-state
        [variant]="'not-found'"
        [message]="t('ui.errorState.notFound')"
        [hint]="t('ui.errorState.notFoundHint')"
      >
        <a class="btn btn--outline btn--sm" routerLink="/battles">{{ t('nav.battles') }}</a>
      </app-error-state>
    } @else if (loadFailed() || !fight()) {
      <app-error-state
        [message]="t('fights.loadFailed')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    } @else if (fight(); as detail) {
      <a class="btn btn--ghost btn--sm mb-3 inline-flex items-center gap-1.5 no-underline" routerLink="/battles">
        ← {{ t('nav.battles') }}
      </a>

      <app-entity-header
        [title]="t('fights.title', { id: detail.id })"
        [description]="fightWindow(detail)"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <div entityBadges class="flex flex-wrap items-center gap-2">
          <app-status-chip
            [value]="fightVerdict().type"
            [label]="fightVerdict().label"
            [toneOverride]="verdictTone()"
          />
          @if (detail.needs_review) {
            <app-status-chip value="needs_review" [label]="t('fights.needsReview')" [toneOverride]="'warning'" />
          }
        </div>

        <div entityMeta class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="capitalize">
            {{ t('fights.grouping', { method: detail.grouping_method, confidence: formatConfidence(detail.grouping_confidence) }) }}
          </span>
          <span>{{ ourSideLabel() }}</span>
          @if (detail.event_id; as eventId) {
            <a [routerLink]="['/events', eventId]" [title]="t('battles.linkedEventHint')">
              {{ t('fights.linkedEvent', { id: eventId }) }}
            </a>
          } @else {
            <span>{{ t('battles.unlinked') }}</span>
          }
        </div>

        <div entitySummary>
          <app-summary-band [ariaLabel]="t('fights.kpisAria')" [items]="summaryItems()" />
        </div>
      </app-entity-header>

      <app-page-stack>
        @if (mutationError(); as error) {
          <p class="fight-feedback fight-feedback--error" role="alert">{{ error }}</p>
        }
        @if (mutationSuccess(); as message) {
          <p class="fight-feedback fight-feedback--success" role="status">{{ message }}</p>
        }

        <app-tabs
          [options]="tabOptions()"
          [active]="tab()"
          [ariaLabel]="t('fights.sectionsAria')"
          (activeChange)="onTabChange($event)"
        />

        <!-- ================= OVERVIEW ================= -->
        @if (tab() === 'overview') {
          <div class="fight-overview">
            <section class="card p-4" aria-labelledby="fight-head-to-head">
              <h2 id="fight-head-to-head" class="section-title">{{ t('fights.tacticalComparison') }}</h2>
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('fights.side') }}</th>
                      <th scope="col" class="num">{{ ourSideLabel() }}</th>
                      <th scope="col" class="num">{{ enemySideLabel() }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of headToHeadRows(); track row.key) {
                      <tr>
                        <th scope="row" class="font-medium">{{ row.label }}</th>
                        <td class="num">{{ row.ours }}</td>
                        <td class="num">{{ row.enemy }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            <section class="card p-4" aria-labelledby="fight-honors">
              <h2 id="fight-honors" class="section-title">{{ t('fights.combatHonors') }}</h2>
              <div class="table-scroll">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('fights.honor') }}</th>
                      <th scope="col">{{ t('common.player') }}</th>
                      <th scope="col" class="num">{{ t('fights.honorResult') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (honor of honorRows(); track honor.id) {
                      <tr>
                        <th scope="row" class="font-medium">{{ honor.label }}</th>
                        <td>
                          @if (honor.player; as player) {
                            <span class="block font-semibold">{{ player.name }}</span>
                            <span class="hint">{{ player.guild_name }}</span>
                          } @else {
                            <span class="hint">{{ honor.emptyText }}</span>
                          }
                        </td>
                        <td class="num">{{ honor.value }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            <div class="fight-charts">
              <section class="card p-4">
                <h2 class="section-title">{{ t('fights.killFameDistribution') }}</h2>
                <app-chart
                  [option]="fameDistributionOption()"
                  height="15rem"
                  [label]="t('fights.killFameDistributionAria')"
                  [tableHead]="fameDistributionTableHead()"
                  [tableRows]="fameDistributionTableRows()"
                />
              </section>

              <section class="card p-4">
                <h2 class="section-title">{{ t('battles.top_guilds_kd') }}</h2>
                <app-chart
                  [option]="topGuildsKdOption()"
                  height="15rem"
                  [label]="t('battles.top_guilds_kd')"
                  [tableHead]="topGuildsKdTableHead()"
                  [tableRows]="topGuildsKdTableRows()"
                />
              </section>

              <section class="card p-4">
                <h2 class="section-title">{{ t('fights.segmentActivity') }}</h2>
                @if ((detail.segments?.length ?? 0) > 0) {
                  <app-chart
                    [option]="segmentsIntensityOption()"
                    height="15rem"
                    [label]="t('fights.segmentActivityAria')"
                    [tableHead]="segmentsIntensityTableHead()"
                    [tableRows]="segmentsIntensityTableRows()"
                  />
                } @else {
                  <p class="hint py-8 text-center">{{ t('fights.segmentChartEmpty') }}</p>
                }
              </section>
            </div>
          </div>
        }

        <!-- ================= GUILDS & ALLIANCES ================= -->
        @if (tab() === 'guilds') {
          <section class="card p-4 space-y-3" aria-labelledby="fight-alliances">
            <h2 id="fight-alliances" class="section-title">{{ t('fights.alliances') }}</h2>
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">{{ t('fights.allianceColumn') }}</th>
                    <th scope="col" class="num">{{ t('battles.players') }}</th>
                    <th scope="col" class="num">{{ t('battles.kill_death') }}</th>
                    <th scope="col" class="num">{{ t('battles.kill_fame') }}</th>
                    <th scope="col" class="num">{{ t('common.loss') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (alliance of alliances(); track alliance.name) {
                    <tr>
                      <th scope="row" class="font-medium">{{ alliance.name }}</th>
                      <td class="num">{{ formatAmount(alliance.players) }}</td>
                      <td class="num">{{ formatDecimal(alliance.kdRatio) }}</td>
                      <td class="num">{{ formatCompact(alliance.killFame) }}</td>
                      <td class="num">{{ formatCompact(alliance.estimatedLoss) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card p-4 space-y-3" aria-labelledby="fight-guilds">
            <div>
              <h2 id="fight-guilds" class="section-title">{{ t('fights.participatingGuilds') }}</h2>
              <p class="hint">{{ t('fights.guildsSubtitle') }}</p>
            </div>

            <app-filter-bar
              [searchLabel]="t('fights.searchGuilds')"
              [searchPlaceholder]="t('fights.searchGuilds')"
              [query]="guildSearchQuery()"
              [activeCount]="guildSearchQuery().trim() ? 1 : 0"
              (queryChange)="guildSearchQuery.set($event)"
              (clear)="guildSearchQuery.set('')"
            />

            <app-data-table
              [columns]="allGuildColumns"
              [rows]="filteredGuildRows()"
              [trackBy]="trackGuildRow"
              [pageSize]="10"
              [hideSearch]="true"
              [syncUrl]="false"
              [ariaLabel]="t('fights.participatingGuilds')"
            >
              <ng-template dataTableCell="name" let-row>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold">{{ row.name }}</span>
                  @if (row.alliance_name) {
                    <span class="chip chip--neutral font-mono">[{{ row.alliance_name }}]</span>
                  }
                  @if (row.isOurGuild) {
                    <app-status-chip value="ours" [label]="t('fights.ourGuild')" [toneOverride]="'success'" />
                  }
                </div>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="num font-semibold">{{ formatDecimal(row.kdRatio) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="num">{{ formatCompact(row.kill_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="loss" let-row>
                <span class="num">{{ formatCompact(row.estimatedLoss) }}</span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- ================= PLAYERS ================= -->
        @if (tab() === 'players') {
          <section class="card p-4 space-y-3" aria-labelledby="fight-players">
            <h2 id="fight-players" class="section-title">{{ t('battles.players') }}</h2>

            <app-filter-bar
              [searchLabel]="t('fights.searchPlayers')"
              [searchPlaceholder]="t('fights.searchPlayers')"
              [query]="playerSearchQuery()"
              [activeCount]="playerActiveCount()"
              (queryChange)="playerSearchQuery.set($event)"
              (clear)="clearPlayerFilters()"
            >
              <app-tabs
                filterPrimary
                [variant]="'segmented'"
                [ariaLabel]="t('battles.players')"
                [options]="sideOptions()"
                [active]="playerSideFilter()"
                (activeChange)="onSideChange($event)"
              />
            </app-filter-bar>

            <app-data-table
              [columns]="allPlayerColumns"
              [rows]="filteredPlayerRows()"
              [trackBy]="trackPlayerRow"
              [pageSize]="15"
              [hideSearch]="true"
              [syncUrl]="false"
              [ariaLabel]="t('battles.players')"
            >
              <ng-template dataTableCell="name" let-row>
                <button type="button" class="fight-row-button" (click)="inspectedPlayer.set(row)">
                  <app-avatar [username]="row.name" size="xs" />
                  <span class="min-w-0">
                    <span class="block truncate text-xs font-semibold">{{ row.name }}</span>
                    <span class="block truncate hint">
                      {{ row.guild_name }}@if (row.alliance_name) { [{{ row.alliance_name }}] }
                    </span>
                  </span>
                  @if (row.isOurGuild) {
                    <app-status-chip value="ours" [label]="t('fights.ourGuild')" [toneOverride]="'success'" />
                  }
                </button>
              </ng-template>

              <ng-template dataTableCell="item_power" let-row>
                <span class="num">{{ formatDecimal(row.item_power ?? 0) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="num font-semibold">{{ formatDecimal(row.kdRatio) }}</span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="num">{{ formatCompact(row.kill_fame) }}</span>
              </ng-template>

              <ng-template dataTableCell="loss" let-row>
                <span class="num">{{ formatCompact(row.estimatedLoss) }}</span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- ================= ROSTER ================= -->
        @if (tab() === 'roster') {
          @if (detail.participant_coverage) {
            <section class="card p-4 space-y-3" aria-labelledby="fight-planning">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 id="fight-planning" class="section-title">{{ t('fights.planningEvidence') }}</h2>
                  <p class="hint">{{ t('fights.planningEvidenceHint') }}</p>
                </div>
                @if (detail.planned_comp; as comp) {
                  <span class="chip chip--neutral">
                    {{ t('events.detail.comp') }}: {{ comp.name || ('#' + comp.id) }}
                  </span>
                }
              </div>
              <app-summary-band [ariaLabel]="t('fights.planningEvidence')" [items]="coverageItems()" />
            </section>
          }

          @if (detail.planned_participants?.length) {
            <section class="card p-4 space-y-3" aria-labelledby="fight-planned">
              <h2 id="fight-planned" class="section-title">{{ t('fights.plannedParticipants') }}</h2>
              <app-data-table
                [columns]="plannedColumns"
                [rows]="detail.planned_participants ?? []"
                [trackBy]="trackPlannedRow"
                [pageSize]="25"
                [hideSearch]="true"
                [syncUrl]="false"
                [mobileLayout]="'stack'"
                [ariaLabel]="t('fights.plannedParticipants')"
              >
                <ng-template dataTableCell="primary" let-row>
                  {{ row.primary_build_name || (row.primary_build_id !== null ? t('fights.buildNumber', { id: row.primary_build_id }) : t('common.none')) }}
                </ng-template>

                <ng-template dataTableCell="secondary" let-row>
                  {{ row.secondary_build_name || t('common.none') }}
                </ng-template>

                <ng-template dataTableCell="observation" let-row>
                  <app-status-chip
                    [value]="row.observed ? 'observed' : (row.albion_player_id ? 'absent' : 'unlinked')"
                    [label]="row.observed ? t('fights.observedInBattle') : (row.albion_player_id ? t('fights.absentFromSnapshot') : t('fights.noLinkedCharacter'))"
                    [toneOverride]="row.observed ? 'success' : 'warning'"
                  />
                </ng-template>
              </app-data-table>
            </section>
          }

          @if (detail.observed_friendly_players?.length) {
            <section class="card p-4 space-y-3" aria-labelledby="fight-observed">
              <h2 id="fight-observed" class="section-title">{{ t('fights.observedAllies') }}</h2>
              <app-data-table
                [columns]="observedColumns"
                [rows]="detail.observed_friendly_players ?? []"
                [trackBy]="trackObservedRow"
                [pageSize]="25"
                [hideSearch]="true"
                [syncUrl]="false"
                [mobileLayout]="'stack'"
                [ariaLabel]="t('fights.observedAllies')"
              >
                <ng-template dataTableCell="kill_fame" let-row>
                  <span class="num">{{ formatAmount(row.kill_fame) }}</span>
                </ng-template>

                <ng-template dataTableCell="avg_ip" let-row>
                  <span class="num">{{ formatDecimal(row.average_item_power) }}</span>
                </ng-template>
              </app-data-table>
            </section>
          }
        }

        <!-- ================= SEGMENTS ================= -->
        @if (tab() === 'segments') {
          <section class="card p-4 space-y-3" aria-labelledby="fight-segments">
            <div>
              <h2 id="fight-segments" class="section-title">{{ t('fights.albionSegments') }}</h2>
              <p class="hint">{{ t('fights.albionSegmentsHint') }}</p>
            </div>

            <app-data-table
              [columns]="segmentColumns"
              [rows]="segmentRows()"
              [trackBy]="trackSegmentRow"
              [pageSize]="25"
              [hideSearch]="true"
              [syncUrl]="false"
              [ariaLabel]="t('fights.albionSegments')"
            >
              <ng-template dataTableCell="segment" let-row>
                <span class="block min-w-0">
                  <a class="font-semibold" [routerLink]="['/battles', row.battleId]">
                    {{ t('fights.battleNumber', { id: row.battleId }) }}
                  </a>
                  <span class="block hint">
                    <a
                      [href]="albionBattlesUrl(row.battleId)"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ t('battles.view_on_albion_battles') }} ↗</a>
                  </span>
                </span>
              </ng-template>

              <ng-template dataTableCell="kills" let-row>
                <span class="num">{{ row.kills === null ? '—' : formatAmount(row.kills) }}</span>
              </ng-template>

              <ng-template dataTableCell="players" let-row>
                <span class="num">{{ row.players === null ? '—' : formatAmount(row.players) }}</span>
              </ng-template>

              <ng-template dataTableCell="actions" let-row>
                @if (canManageFights()) {
                  <app-menu
                    [appearance]="'ghost'"
                    [label]="t('fights.segmentActionsAria', { id: row.battleId })"
                    [items]="segmentMenuItems()"
                    (itemSelect)="openMove(row.battleId)"
                  />
                }
              </ng-template>
            </app-data-table>
          </section>
        }
      </app-page-stack>

      <!-- ================= DIALOGS ================= -->

      <!-- MERGE DIALOG -->
      @if (mergeOpen()) {
        <app-dialog
          [title]="t('fights.mergeTitle')"
          [subtitle]="t('fights.mergeSubtitle')"
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-merge-form" class="space-y-3" (submit)="stageMerge($event)">
            <div>
              <label class="label" for="fight-merge-target">{{ t('fights.mergeTargetLabel') }}</label>
              <input
                id="fight-merge-target"
                class="input input--sm text-xs w-full"
                name="targetFightId"
                type="number"
                min="1"
                inputmode="numeric"
                [value]="mergeTargetId()"
                (input)="mergeTargetId.set(inputValue($event)); clearDialogError()"
                required
              />
            </div>

            <div>
              <label class="label" for="fight-merge-others">{{ t('fights.mergeOthersLabel') }}</label>
              <input
                id="fight-merge-others"
                class="input input--sm text-xs w-full"
                name="otherFightIds"
                inputmode="numeric"
                [placeholder]="t('fights.mergeOthersPlaceholder')"
                [value]="mergeOtherIds()"
                (input)="mergeOtherIds.set(inputValue($event)); clearDialogError()"
                required
              />
              <p class="hint">{{ t('fights.mergeCurrentIncluded', { id: detail.id }) }}</p>
            </div>

            @if (dialogError(); as error) {
              <p class="fight-feedback fight-feedback--error" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-merge-form">
              {{ t('fights.reviewMerge') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- SPLIT DIALOG -->
      @if (splitOpen()) {
        <app-dialog
          [title]="t('fights.splitTitle')"
          [subtitle]="t('fights.splitSubtitle')"
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-split-form" class="space-y-3" (submit)="stageSplit($event)">
            <p class="label">{{ t('fights.splitSelect') }}</p>
            <div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              @for (battleId of detail.battle_ids; track battleId) {
                <label class="filter-check">
                  <input
                    type="checkbox"
                    class="checkbox"
                    [checked]="isSplitSelected(battleId)"
                    (change)="toggleSplitBattle(battleId)"
                  />
                  <span class="font-mono font-semibold">{{ t('fights.battleNumber', { id: battleId }) }}</span>
                </label>
              }
            </div>

            @if (dialogError(); as error) {
              <p class="fight-feedback fight-feedback--error" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-split-form">
              {{ t('fights.reviewSplit') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- MOVE DIALOG -->
      @if (moveBattleId(); as battleId) {
        <app-dialog
          [title]="t('fights.moveTitle')"
          [subtitle]="t('fights.moveSubtitle', { id: battleId })"
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-move-form" class="space-y-3" (submit)="stageMove(battleId, $event)">
            <div>
              <label class="label" for="fight-move-target">{{ t('fights.moveTargetLabel') }}</label>
              <input
                id="fight-move-target"
                class="input input--sm text-xs w-full"
                name="targetFightId"
                type="number"
                min="1"
                inputmode="numeric"
                [value]="moveTargetId()"
                (input)="moveTargetId.set(inputValue($event)); clearDialogError()"
                required
              />
            </div>

            @if (dialogError(); as error) {
              <p class="fight-feedback fight-feedback--error" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-move-form">
              {{ t('fights.reviewMove') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- CONFIRM MUTATION DIALOG -->
      @if (pendingMutation(); as pending) {
        <app-dialog [title]="t('fights.confirmTitle')" size="sm" (closed)="cancelPendingMutation()">
          <p class="text-sm mb-2">{{ pending.description }}</p>
          <p class="hint">{{ t('fights.confirmPermanent') }}</p>

          @if (dialogError(); as error) {
            <p class="fight-feedback fight-feedback--error mt-3" role="alert">{{ error }}</p>
          }

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" [disabled]="mutating()" (click)="cancelPendingMutation()">
              {{ t('common.cancel') }}
            </button>
            <button type="button" class="btn btn--danger btn--sm" [disabled]="mutating()" (click)="confirmMutation()">
              {{ mutating() ? t('fights.applying') : t('fights.confirmChange') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- PLAYER DETAIL DIALOG -->
      @if (inspectedPlayer(); as p) {
        <app-dialog
          [title]="p.name"
          [subtitle]="p.guild_name + (p.alliance_name ? ' [' + p.alliance_name + ']' : '')"
          size="sm"
          (closed)="inspectedPlayer.set(null)"
        >
          <dl class="grid grid-cols-2 gap-2">
            <div class="surface p-2.5 rounded-lg">
              <dt class="hint">{{ t('battles.kills') }} / {{ t('battles.deaths') }}</dt>
              <dd class="num font-semibold">{{ p.kills }} / {{ p.deaths }}</dd>
            </div>
            <div class="surface p-2.5 rounded-lg">
              <dt class="hint">{{ t('fights.kdRatio') }}</dt>
              <dd class="num font-semibold">{{ formatDecimal(p.kdRatio) }}</dd>
            </div>
            <div class="surface p-2.5 rounded-lg">
              <dt class="hint">{{ t('battles.kill_fame') }}</dt>
              <dd class="num font-semibold">{{ formatCompact(p.kill_fame) }}</dd>
            </div>
            <div class="surface p-2.5 rounded-lg">
              <dt class="hint">{{ t('battles.item_power') }}</dt>
              <dd class="num font-semibold">{{ formatDecimal(p.item_power ?? 0) }}</dd>
            </div>
            <div class="surface p-2.5 rounded-lg col-span-2">
              <dt class="hint">{{ t('battles.estimated_value') }}</dt>
              <dd class="num font-semibold">{{ formatCompact(p.estimatedLoss) }}</dd>
            </div>
          </dl>

          <div dialogFooter>
            <button type="button" class="btn btn--outline btn--sm" (click)="inspectedPlayer.set(null)">
              {{ t('common.close') }}
            </button>
          </div>
        </app-dialog>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    @layer components {
      .fight-overview {
        display: grid;
        gap: var(--page-gap);
      }
      .fight-charts {
        display: grid;
        gap: var(--page-gap);
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
      }
      .fight-feedback {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-smallcards);
        font-size: var(--ui-text-sm);
        padding: 0.5rem 0.75rem;
      }
      .fight-feedback--error {
        background: var(--color-error-container);
        border-color: var(--color-error);
        color: var(--color-error);
      }
      .fight-feedback--success {
        background: var(--color-success-container);
        border-color: var(--color-success);
        color: var(--color-success);
      }
      .fight-row-button {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        min-width: 0;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        text-align: left;
        cursor: pointer;
        border-radius: var(--radius-badges);
      }
      .fight-row-button:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-ring-offset);
      }
    }
  `,
})
export class FightDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly translate = inject(TranslateService);

  readonly fightId = input.required<string>();

  protected readonly t = this.translate.t.bind(this.translate);
  protected readonly palette = computed(() => chartPalette(this.theme.isDark()));
  protected readonly chrome = computed(() => chartChrome(this.theme.isDark()));

  protected readonly fight = signal<FightDetail | null>(null);
  protected readonly tab = signal<FightTab>('overview');
  protected readonly canManageFights = computed(() => this.auth.hasPermission('fights.edit'));

  protected readonly trackGuildRow = (row: FightGuildRow) => row.id;
  protected readonly trackPlayerRow = (row: FightPlayerRow) => row.id;

  protected onTabChange(tabId: string): void {
    this.tab.set(tabId as FightTab);
  }

  // Mutation Dialog Signals
  protected readonly mergeOpen = signal(false);
  protected readonly splitOpen = signal(false);
  protected readonly moveBattleId = signal<number | null>(null);
  protected readonly mergeTargetId = signal('');
  protected readonly mergeOtherIds = signal('');
  protected readonly moveTargetId = signal('');
  protected readonly splitBattleIds = signal<number[]>([]);
  protected readonly pendingMutation = signal<PendingFightMutation | null>(null);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly mutationError = signal<string | null>(null);
  protected readonly mutationSuccess = signal<string | null>(null);
  protected readonly mutating = signal(false);

  // Loading signals
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);

  // Player inspect modal
  protected readonly inspectedPlayer = signal<FightPlayerRow | null>(null);

  // Search and Filter Signals
  protected readonly playerSideFilter = signal<'all' | 'allies' | 'enemies'>('all');
  protected readonly playerSearchQuery = signal('');
  protected readonly guildSearchQuery = signal('');

  // "Ours" is decided by the backend from the tenant's Albion scope
  // (`is_own` / `is_friendly`); the Discord server name is never compared.
  protected readonly ourGuild = computed<BattleGuildSummary | null>(() => {
    const fight = this.fight();
    if (!fight?.guilds) return null;
    return fight.guilds.find((g) => g.is_own) ?? fight.guilds.find((g) => g.is_friendly) ?? null;
  });

  protected readonly ourGuildName = computed(() => this.ourGuild()?.name ?? '');

  protected readonly ourAllianceName = computed<string | null>(() => {
    return this.ourGuild()?.alliance_name?.trim() || null;
  });

  protected readonly enrichedGuilds = computed<FightGuildRow[]>(() => {
    const fight = this.fight();
    if (!fight || !fight.guilds) return [];
    const lossesMap = new Map(
      fight.estimated_losses?.guilds?.map((l) => [l.guild_name.toLowerCase(), l.estimated_loss]) ?? [],
    );

    return fight.guilds.map((g) => {
      const isOurGuild = g.is_own === true;
      const isOurAlliance = g.is_friendly === true;
      const kdRatio = g.deaths > 0 ? g.kills / g.deaths : g.kills;
      const famePerPlayer = g.players > 0 ? Math.round(g.kill_fame / g.players) : 0;
      const estimatedLoss = lossesMap.get(g.name.toLowerCase()) ?? 0;
      return {
        ...g,
        isOurGuild,
        isOurAlliance,
        kdRatio,
        famePerPlayer,
        estimatedLoss,
      };
    });
  });

  protected readonly filteredGuildRows = computed<FightGuildRow[]>(() => {
    let list = this.enrichedGuilds();
    const q = this.guildSearchQuery().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) => g.name.toLowerCase().includes(q) || (g.alliance_name ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  });

  protected readonly enrichedPlayers = computed<FightPlayerRow[]>(() => {
    const fight = this.fight();
    if (!fight || !fight.players) return [];
    const ourName = this.ourGuildName().toLowerCase();
    const lossesMap = new Map(
      fight.estimated_losses?.players?.map((l) => [l.player_name.toLowerCase(), l.estimated_loss]) ?? [],
    );

    return fight.players.map((p) => {
      // `ourName` comes from the backend-flagged own guild, not from the tenant name.
      const isOurAlliance = p.is_friendly === true;
      const isOurGuild = isOurAlliance && ourName !== '' && (p.guild_name ?? '').toLowerCase() === ourName;
      const kdRatio = p.deaths > 0 ? p.kills / p.deaths : p.kills;
      const estimatedLoss = lossesMap.get(p.name.toLowerCase()) ?? 0;
      return {
        ...p,
        isOurGuild,
        isOurAlliance,
        kdRatio,
        role: 'other',
        estimatedLoss,
      };
    });
  });

  protected readonly filteredPlayerRows = computed<FightPlayerRow[]>(() => {
    let list = this.enrichedPlayers();
    const side = this.playerSideFilter();
    if (side === 'allies') {
      list = list.filter((p) => p.isOurAlliance);
    } else if (side === 'enemies') {
      list = list.filter((p) => !p.isOurAlliance);
    }
    const q = this.playerSearchQuery().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.guild_name ?? '').toLowerCase().includes(q) ||
          (p.alliance_name ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  });

  protected readonly allyPlayersCount = computed(() => {
    return this.enrichedPlayers().filter((p) => p.isOurAlliance).length;
  });

  protected readonly enemyPlayersCount = computed(() => {
    return this.enrichedPlayers().filter((p) => !p.isOurAlliance).length;
  });

  protected readonly alliances = computed<FightAllianceSummary[]>(() => {
    const guilds = this.enrichedGuilds();
    if (guilds.length === 0) return [];
    const map = new Map<string, FightGuildRow[]>();
    for (const g of guilds) {
      const key = g.alliance_name?.trim() || `[Solo] ${g.name}`;
      const list = map.get(key) ?? [];
      list.push(g);
      map.set(key, list);
    }

    return [...map.entries()]
      .map(([name, groupGuilds]) => {
        const isOurAlliance = groupGuilds.some((g) => g.isOurAlliance);
        const isSolo = name.startsWith('[Solo] ');
        const players = groupGuilds.reduce((sum, g) => sum + g.players, 0);
        const kills = groupGuilds.reduce((sum, g) => sum + g.kills, 0);
        const deaths = groupGuilds.reduce((sum, g) => sum + g.deaths, 0);
        const killFame = groupGuilds.reduce((sum, g) => sum + g.kill_fame, 0);
        const deathFame = groupGuilds.reduce((sum, g) => sum + (g.death_fame ?? 0), 0);
        const netFame = killFame - deathFame;
        const kdRatio = deaths > 0 ? kills / deaths : kills;
        const estimatedLoss = groupGuilds.reduce((sum, g) => sum + g.estimatedLoss, 0);

        return {
          name,
          isSolo,
          isOurAlliance,
          guilds: groupGuilds,
          players,
          kills,
          deaths,
          killFame,
          deathFame,
          netFame,
          kdRatio,
          avgIp: 0,
          estimatedLoss,
        };
      })
      .sort((a, b) => b.killFame - a.killFame);
  });

  protected readonly ourAlliance = computed(() => this.alliances().find((a) => a.isOurAlliance) ?? null);
  protected readonly topEnemyAlliance = computed(() => this.alliances().find((a) => !a.isOurAlliance) ?? null);

  protected readonly ourForcesPlayers = computed(() => {
    return (
      this.alliances()
        .filter((a) => a.isOurAlliance)
        .reduce((sum, a) => sum + a.players, 0) || (this.ourGuild()?.players ?? 0)
    );
  });

  protected readonly ourForcesKills = computed(() => {
    return (
      this.alliances()
        .filter((a) => a.isOurAlliance)
        .reduce((sum, a) => sum + a.kills, 0) || (this.ourGuild()?.kills ?? 0)
    );
  });

  protected readonly ourForcesDeaths = computed(() => {
    return (
      this.alliances()
        .filter((a) => a.isOurAlliance)
        .reduce((sum, a) => sum + a.deaths, 0) || (this.ourGuild()?.deaths ?? 0)
    );
  });

  protected readonly ourForcesKdRatio = computed(() => {
    const deaths = this.ourForcesDeaths();
    const kills = this.ourForcesKills();
    return deaths > 0 ? kills / deaths : kills;
  });

  protected readonly ourForcesKillFame = computed(() => {
    return (
      this.alliances()
        .filter((a) => a.isOurAlliance)
        .reduce((sum, a) => sum + a.killFame, 0) || (this.ourGuild()?.kill_fame ?? 0)
    );
  });

  protected readonly enemyForcesPlayers = computed(() => {
    return this.alliances()
      .filter((a) => !a.isOurAlliance)
      .reduce((sum, a) => sum + a.players, 0);
  });

  protected readonly enemyForcesKills = computed(() => {
    return this.alliances()
      .filter((a) => !a.isOurAlliance)
      .reduce((sum, a) => sum + a.kills, 0);
  });

  protected readonly enemyForcesDeaths = computed(() => {
    return this.alliances()
      .filter((a) => !a.isOurAlliance)
      .reduce((sum, a) => sum + a.deaths, 0);
  });

  protected readonly enemyForcesKdRatio = computed(() => {
    const deaths = this.enemyForcesDeaths();
    const kills = this.enemyForcesKills();
    return deaths > 0 ? kills / deaths : kills;
  });

  protected readonly enemyForcesKillFame = computed(() => {
    return this.alliances()
      .filter((a) => !a.isOurAlliance)
      .reduce((sum, a) => sum + a.killFame, 0);
  });

  // Core Metrics Computeds
  protected readonly totalFame = computed(() => {
    const f = this.fight();
    return f?.total_fame ?? f?.total_kill_fame ?? f?.stats?.total_fame ?? f?.stats?.total_kill_fame ?? 0;
  });

  protected readonly totalKills = computed(() => {
    const f = this.fight();
    return f?.total_kills ?? f?.stats?.total_kills ?? 0;
  });

  protected readonly totalDeaths = computed(() => {
    const f = this.fight();
    return f?.total_deaths ?? f?.stats?.total_deaths ?? this.enrichedGuilds().reduce((s, g) => s + g.deaths, 0);
  });

  protected readonly totalPlayersCount = computed(() => {
    const f = this.fight();
    return f?.total_players ?? f?.unique_players ?? f?.stats?.total_players ?? f?.stats?.players ?? 0;
  });

  protected readonly ourFameShare = computed(() => {
    const total = this.totalFame();
    if (total <= 0) return 0;
    return (this.ourForcesKillFame() / total) * 100;
  });

  protected readonly ourKillParticipation = computed(() => {
    const total = this.totalKills();
    if (total <= 0) return 0;
    return (this.ourForcesKills() / total) * 100;
  });

  protected readonly ourGuildKdRatio = computed(() => {
    const g = this.ourGuild();
    if (!g) return this.fight()?.kill_death_ratio ?? this.fight()?.stats?.kill_death_ratio ?? 0;
    return g.deaths > 0 ? g.kills / g.deaths : g.kills;
  });

  protected readonly ourGuildAvgIp = computed(() => {
    const friendly = this.fight()?.observed_friendly_players ?? [];
    if (friendly.length === 0) return 0;
    const sum = friendly.reduce((acc, p) => acc + (p.average_item_power || 0), 0);
    return Math.round(sum / friendly.length);
  });

  protected readonly fightAvgIp = computed(() => {
    const players = this.enrichedPlayers().filter((p) => (p.item_power ?? 0) > 0);
    if (players.length === 0) return this.ourGuildAvgIp();
    const sum = players.reduce((acc, p) => acc + (p.item_power ?? 0), 0);
    return Math.round(sum / players.length);
  });

  protected readonly totalEstimatedLoss = computed(() => {
    return this.fight()?.estimated_losses?.total_estimated_loss ?? 0;
  });

  protected readonly pricedItemsCount = computed(() => {
    return this.fight()?.estimated_losses?.priced_items ?? 0;
  });

  protected readonly totalItemsCount = computed(() => {
    return this.fight()?.estimated_losses?.total_items ?? 0;
  });

  /**
   * Renders the verdict the backend resolved. It does not compute one.
   *
   * There used to be two fallbacks here — the browser's own alliance-and-fame
   * heuristic, then a bare K/D threshold — which fired whenever the backend
   * answered `draw` or `unknown`. Both were silently overriding a deliberate
   * answer: `unknown` means the evidence does not identify our side, and
   * guessing from K/D turned "we don't know" into a confident badge.
   * `modules::battles::outcome` now tolerates partially hydrated fights, so
   * `unknown` is rare and honest when it happens.
   */
  protected readonly fightVerdict = computed<{ label: string; type: BattleOutcomeType }>(() => {
    const outcome = this.fight()?.outcome?.outcome ?? 'unknown';
    return { label: this.t(battleOutcomeLabel(outcome)), type: outcome };
  });

  // MVPs
  protected readonly mvpExecutioner = computed(() => {
    return [...this.enrichedPlayers()].sort((a, b) => b.kills - a.kills)[0] ?? null;
  });

  protected readonly mvpFameHunter = computed(() => {
    return [...this.enrichedPlayers()].sort((a, b) => b.kill_fame - a.kill_fame)[0] ?? null;
  });

  protected readonly mvpIronVanguard = computed(() => {
    return [...this.enrichedPlayers()].sort((a, b) => (b.item_power ?? 0) - (a.item_power ?? 0))[0] ?? null;
  });

  protected readonly mvpHeaviestLoss = computed(() => {
    return [...this.enrichedPlayers()].sort((a, b) => b.estimatedLoss - a.estimatedLoss)[0] ?? null;
  });

  // Tab options (counts are passed as data, not baked into the label)
  protected readonly tabOptions = computed<readonly TabOption[]>(() => {
    const fight = this.fight();
    const options: TabOption[] = [
      { id: 'overview', label: this.t('guild.tabs.overview') },
      { id: 'guilds', label: this.t('battles.guilds'), count: fight?.guilds?.length ?? 0 },
      { id: 'players', label: this.t('battles.players'), count: fight?.players?.length ?? 0 },
    ];
    if (this.hasRosterEvidence()) {
      options.push({ id: 'roster', label: this.t('fights.rosterTab') });
    }
    options.push({ id: 'segments', label: this.t('battles.segments'), count: fight?.battle_ids?.length ?? 0 });
    return options;
  });

  protected readonly hasRosterEvidence = computed(() => {
    const fight = this.fight();
    return Boolean(
      fight?.planned_comp ||
        fight?.planned_participants?.length ||
        fight?.observed_friendly_players?.length ||
        fight?.participant_coverage?.event_linked,
    );
  });

  // Table Columns Definitions
  protected readonly allGuildColumns: readonly DataTableColumn<FightGuildRow>[] = [
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
      key: 'loss',
      label: 'battles.silver_lost',
      sortable: true,
      accessor: (g) => g.estimatedLoss,
      comparator: (a, b) => a.estimatedLoss - b.estimatedLoss,
      align: 'right',
    },
  ];

  protected readonly allPlayerColumns: readonly DataTableColumn<FightPlayerRow>[] = [
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
      accessor: (p) => p.item_power ?? 0,
      comparator: (a, b) => (a.item_power ?? 0) - (b.item_power ?? 0),
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
      key: 'kill_death',
      label: 'battles.kill_death',
      sortable: true,
      accessor: (p) => p.kdRatio,
      comparator: (a, b) => a.kdRatio - b.kdRatio,
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
      key: 'loss',
      label: 'battles.silver_lost',
      sortable: true,
      accessor: (p) => p.estimatedLoss,
      comparator: (a, b) => a.estimatedLoss - b.estimatedLoss,
      align: 'right',
    },
  ];

  // Header menu: officer actions live here, never as header buttons.
  protected readonly menuItems = computed<EntityMenuItem[]>(() => {
    const fight = this.fight();
    if (!fight || !this.canManageFights()) return [];
    const busy = this.mutating();
    return [
      { id: 'merge', label: this.t('fights.merge'), disabled: busy },
      { id: 'split', label: this.t('fights.split'), disabled: busy || fight.battle_ids.length < 2 },
    ];
  });

  protected readonly segmentMenuItems = computed<EntityMenuItem[]>(() => [
    { id: 'move', label: this.t('fights.move'), disabled: this.mutating() },
  ]);

  protected onMenu(id: string): void {
    if (id === 'merge') {
      this.openMerge();
    } else if (id === 'split') {
      this.openSplit();
    }
  }

  protected onSideChange(id: string): void {
    if (id === 'all' || id === 'allies' || id === 'enemies') {
      this.playerSideFilter.set(id);
    }
  }

  protected clearPlayerFilters(): void {
    this.playerSideFilter.set('all');
    this.playerSearchQuery.set('');
  }

  protected readonly playerActiveCount = computed(
    () => (this.playerSideFilter() === 'all' ? 0 : 1) + (this.playerSearchQuery().trim() ? 1 : 0),
  );

  protected readonly sideOptions = computed<readonly TabOption[]>(() => [
    { id: 'all', label: this.t('common.all'), count: this.enrichedPlayers().length },
    { id: 'allies', label: this.t('battles.filter_allies'), count: this.allyPlayersCount() },
    { id: 'enemies', label: this.t('battles.filter_enemies'), count: this.enemyPlayersCount() },
  ]);

  protected readonly ourSideLabel = computed(() => {
    const guild = this.ourGuild()?.name || this.ourGuildName();
    const alliance = this.ourAllianceName();
    return alliance ? `[${alliance}] ${guild}` : guild;
  });

  protected readonly enemySideLabel = computed(() => {
    const enemy = this.topEnemyAlliance();
    if (!enemy) return this.t('fights.hostileCoalition');
    const lead = enemy.guilds[0]?.name || this.t('battles.filter_enemies');
    return enemy.isSolo ? lead : `[${enemy.name}] ${lead}`;
  });

  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => {
    const detail = this.fight();
    if (!detail) return [];
    return [
      {
        label: this.t('battles.total_fame'),
        value: this.formatCompact(this.totalFame()),
        hint: `${this.t('battles.guild_fame_vs_fight')}: ${this.formatDecimal(this.ourFameShare())}%`,
      },
      {
        label: `${this.t('battles.kills')} / ${this.t('battles.deaths')}`,
        value: `${this.formatAmount(this.totalKills())} / ${this.formatAmount(this.totalDeaths())}`,
        hint: `${this.t('fights.guildKd')} ${this.formatDecimal(this.ourGuildKdRatio())}`,
      },
      {
        label: this.t('battles.kill_participation'),
        value: `${this.formatDecimal(this.ourKillParticipation())}%`,
        hint: this.t('fights.ourKills', { count: this.ourGuild()?.kills ?? 0 }),
      },
      {
        label: this.t('battles.avg_ip'),
        value: this.formatDecimal(this.ourGuildAvgIp()),
        hint: `${this.t('fights.overallAvgIp')} ${this.formatDecimal(this.fightAvgIp())}`,
      },
      {
        label: this.t('battles.silver_lost'),
        value: this.formatCompact(this.totalEstimatedLoss()),
        hint: this.t('fights.pricedItems', { priced: this.pricedItemsCount(), total: this.totalItemsCount() }),
      },
      {
        label: this.t('fights.fightersAndSegments'),
        value: this.totalPlayersCount(),
        hint: this.t('fights.battleSegmentsCount', { count: detail.battle_ids.length }),
      },
    ];
  });

  protected readonly coverageItems = computed<readonly SummaryItem[]>(() => {
    const coverage = this.fight()?.participant_coverage;
    if (!coverage) return [];
    return [
      {
        label: this.t('fights.observedMembers'),
        value: `${coverage.observed_planned_participants} / ${coverage.matchable_planned_participants}`,
      },
      { label: this.t('fights.unmatchedMembers'), value: coverage.unmatched_planned_participants },
      { label: this.t('fights.unplannedObserved'), value: coverage.unplanned_observed_players },
      {
        label: this.t('fights.snapshotCoverage'),
        value: `${coverage.persisted_segments} / ${this.t('fights.segmentsCount', { count: coverage.total_segments })}`,
      },
    ];
  });

  protected readonly headToHeadRows = computed<readonly FightSideRow[]>(() => [
    {
      key: 'players',
      label: this.t('battles.players'),
      ours: this.formatAmount(this.ourForcesPlayers()),
      enemy: this.formatAmount(this.enemyForcesPlayers()),
    },
    {
      key: 'kills',
      label: `${this.t('battles.kills')} / ${this.t('battles.deaths')}`,
      ours: `${this.formatAmount(this.ourForcesKills())} / ${this.formatAmount(this.ourForcesDeaths())}`,
      enemy: `${this.formatAmount(this.enemyForcesKills())} / ${this.formatAmount(this.enemyForcesDeaths())}`,
    },
    {
      key: 'kd',
      label: this.t('fights.kdRatio'),
      ours: this.formatDecimal(this.ourForcesKdRatio()),
      enemy: this.formatDecimal(this.enemyForcesKdRatio()),
    },
    {
      key: 'fame',
      label: this.t('battles.kill_fame'),
      ours: this.formatCompact(this.ourForcesKillFame()),
      enemy: this.formatCompact(this.enemyForcesKillFame()),
    },
  ]);

  protected readonly honorRows = computed<readonly FightHonorRow[]>(() => {
    const killer = this.mvpExecutioner();
    const fame = this.mvpFameHunter();
    const ip = this.mvpIronVanguard();
    const loss = this.mvpHeaviestLoss();
    return [
      {
        id: 'killer',
        label: this.t('battles.mvp_killer'),
        player: killer,
        value: killer
          ? this.t('fights.mvpKillsKd', { kills: killer.kills, kd: this.formatDecimal(killer.kdRatio) })
          : '—',
        emptyText: this.t('fights.noKillsRecorded'),
      },
      {
        id: 'fame',
        label: this.t('battles.mvp_fame'),
        player: fame,
        value: fame ? this.t('fights.mvpFame', { fame: this.formatCompact(fame.kill_fame) }) : '—',
        emptyText: this.t('fights.noFameRecorded'),
      },
      {
        id: 'ip',
        label: this.t('battles.mvp_ip'),
        player: ip,
        value: ip ? `${this.formatDecimal(ip.item_power ?? 0)} IP` : '—',
        emptyText: '—',
      },
      {
        id: 'loss',
        label: this.t('battles.heaviest_loss'),
        player: loss,
        value: loss ? this.t('fights.mvpLost', { amount: this.formatCompact(loss.estimatedLoss) }) : '—',
        emptyText: this.t('fights.noEstimatedLosses'),
      },
    ];
  });

  protected readonly verdictTone = computed<'success' | 'warning' | 'error' | 'neutral'>(() => {
    switch (this.fightVerdict().type) {
      case 'victory':
        return 'success';
      case 'defeat':
        return 'error';
      case 'draw':
        return 'warning';
      default:
        return 'neutral';
    }
  });

  // One row per attached segment; stats come from the snapshot when the backend has them.
  protected readonly segmentRows = computed<FightSegmentRow[]>(() => {
    const fight = this.fight();
    if (!fight) return [];
    const stats = new Map((fight.segments ?? []).map((s) => [String(s.battle_id), s]));
    return fight.battle_ids.map((battleId, index) => {
      const segment = stats.get(String(battleId));
      return {
        battleId,
        index: index + 1,
        kills: segment?.total_kills ?? null,
        players: segment?.total_players ?? null,
      };
    });
  });

  protected readonly trackSegmentRow = (row: FightSegmentRow) => row.battleId;
  protected readonly trackPlannedRow = (row: PlannedFightParticipant) => row.user_id;
  protected readonly trackObservedRow = (row: ObservedFriendlyPlayer) => row.albion_player_id;

  protected readonly segmentColumns: readonly DataTableColumn<FightSegmentRow>[] = [
    {
      key: 'segment',
      label: 'fights.segment',
      sortable: true,
      accessor: (s) => s.index,
      comparator: (a, b) => a.index - b.index,
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      align: 'right',
      accessor: (s) => s.kills,
      comparator: (a, b) => (a.kills ?? 0) - (b.kills ?? 0),
    },
    {
      key: 'players',
      label: 'battles.players',
      sortable: true,
      align: 'right',
      accessor: (s) => s.players,
      comparator: (a, b) => (a.players ?? 0) - (b.players ?? 0),
    },
    { key: 'actions', label: '' },
  ];

  protected readonly plannedColumns: readonly DataTableColumn<PlannedFightParticipant>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      accessor: (p) => p.username,
      comparator: (a, b) => a.username.localeCompare(b.username),
    },
    { key: 'primary', label: 'events.detail.primary_build' },
    { key: 'secondary', label: 'events.detail.secondary_build' },
    {
      key: 'observation',
      label: 'fights.observationStatus',
      sortable: true,
      accessor: (p) => (p.observed ? 1 : 0),
      comparator: (a, b) => Number(a.observed) - Number(b.observed),
    },
  ];

  protected readonly observedColumns: readonly DataTableColumn<ObservedFriendlyPlayer>[] = [
    {
      key: 'name',
      label: 'common.player',
      sortable: true,
      accessor: (p) => p.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'guild',
      label: 'nav.guild',
      sortable: true,
      accessor: (p) => p.guild_name,
      comparator: (a, b) => a.guild_name.localeCompare(b.guild_name),
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      align: 'right',
      accessor: (p) => p.kills,
      comparator: (a, b) => a.kills - b.kills,
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      align: 'right',
      accessor: (p) => p.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
    },
    {
      key: 'kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      align: 'right',
      accessor: (p) => p.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
    },
    {
      key: 'avg_ip',
      label: 'battles.avg_ip',
      sortable: true,
      align: 'right',
      accessor: (p) => p.average_item_power,
      comparator: (a, b) => a.average_item_power - b.average_item_power,
    },
  ];

  // ECharts Options
  protected readonly fameDistributionOption = computed<EChartsOption>(() => {
    const guilds = [...this.enrichedGuilds()].sort((a, b) => b.kill_fame - a.kill_fame).slice(0, 6);
    if (guilds.length === 0) return {};
    return {
      aria: { enabled: true },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, left: 'center', type: 'scroll', textStyle: { color: this.chrome().axis } },
      series: [
        {
          name: this.t('battles.kill_fame'),
          type: 'pie',
          radius: ['42%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: false,
          itemStyle: { borderRadius: 4, borderColor: 'var(--color-surface)', borderWidth: 2 },
          label: { show: false },
          data: guilds.map((g) => ({
            value: g.kill_fame,
            name: g.name,
          })),
        },
      ],
    };
  });

  protected readonly fameDistributionTableHead = computed(() => [this.t('nav.guild'), this.t('battles.kill_fame')]);
  protected readonly fameDistributionTableRows = computed<ChartTableRow[]>(() => {
    return [...this.enrichedGuilds()]
      .sort((a, b) => b.kill_fame - a.kill_fame)
      .slice(0, 6)
      .map((g) => [g.name, this.formatCompact(g.kill_fame)]);
  });

  protected readonly topGuildsKdOption = computed<EChartsOption>(() => {
    const palette = this.palette();
    const chrome = this.chrome();
    const rows = [...this.enrichedGuilds()].sort((a, b) => b.kills - a.kills).slice(0, 6).reverse();
    if (rows.length === 0) return {};
    return {
      aria: { enabled: true },
      grid: { top: 12, bottom: 20, left: 80, right: 24 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: chrome.gridline } } },
      yAxis: {
        type: 'category',
        data: rows.map((g) => g.name),
        axisLabel: { width: 75, overflow: 'truncate' },
      },
      series: [
        {
          name: this.t('battles.kills'),
          type: 'bar',
          data: rows.map((g) => ({
            value: g.kills,
            itemStyle: {
              color: g.isOurGuild ? palette.ally : chrome.axis,
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 16,
        },
      ],
    };
  });

  protected readonly topGuildsKdTableHead = computed(() => [
    this.t('nav.guild'),
    this.t('fights.kdRatio'),
    this.t('battles.kills'),
    this.t('battles.deaths'),
  ]);
  protected readonly topGuildsKdTableRows = computed<ChartTableRow[]>(() => {
    return [...this.enrichedGuilds()]
      .sort((a, b) => b.kills - a.kills)
      .slice(0, 6)
      .map((g) => [
        g.name,
        this.formatDecimal(g.kdRatio),
        this.formatAmount(g.kills),
        this.formatAmount(g.deaths),
      ]);
  });

  protected readonly segmentsIntensityOption = computed<EChartsOption>(() => {
    const segments = this.fight()?.segments ?? [];
    if (segments.length === 0) return {};
    const palette = this.palette();
    const chrome = this.chrome();
    return {
      aria: { enabled: true },
      grid: { top: 32, bottom: 24, left: 45, right: 16 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, left: 'center', textStyle: { color: chrome.axis } },
      xAxis: {
        type: 'category',
        data: segments.map((s) => `#${s.battle_id}`),
      },
      yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: chrome.gridline } } },
      series: [
        {
          name: this.t('battles.kills'),
          type: 'bar',
          data: segments.map((s) => s.total_kills),
          itemStyle: { color: palette.ally, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 20,
        },
        {
          name: this.t('battles.players'),
          type: 'bar',
          data: segments.map((s) => s.total_players),
          itemStyle: { color: chrome.axis, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 20,
        },
      ],
    };
  });

  protected readonly segmentsIntensityTableHead = computed(() => [
    this.t('fights.segment'),
    this.t('battles.kills'),
    this.t('battles.players'),
  ]);
  protected readonly segmentsIntensityTableRows = computed<ChartTableRow[]>(() => {
    return (this.fight()?.segments ?? []).map((s) => [
      `#${s.battle_id}`,
      this.formatAmount(s.total_kills),
      this.formatAmount(s.total_players),
    ]);
  });

  constructor() {
    effect(() => {
      this.fightId();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const fightId = Number(this.fightId());
    if (!Number.isSafeInteger(fightId) || fightId <= 0) {
      this.notFound.set(true);
      this.loadFailed.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      this.fight.set(await firstValueFrom(this.api.get<FightDetail>(`api/fights/${fightId}`)));
    } catch (error: unknown) {
      this.fight.set(null);
      this.notFound.set(error instanceof ApiError && error.status === 404);
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // Officer Mutation Dialog Methods
  protected openMerge(): void {
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.mergeOpen.set(true);
  }

  protected openSplit(): void {
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.splitBattleIds.set([]);
    this.splitOpen.set(true);
  }

  protected openMove(battleId: string | number): void {
    const id = this.parsePositiveId(String(battleId));
    if (!id) return;
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.moveBattleId.set(id);
  }

  protected closeMutationDialog(): void {
    if (this.mutating()) return;
    this.mergeOpen.set(false);
    this.splitOpen.set(false);
    this.moveBattleId.set(null);
    this.dialogError.set(null);
  }

  protected clearDialogError(): void {
    this.dialogError.set(null);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected isSplitSelected(battleId: string | number): boolean {
    const id = this.parsePositiveId(String(battleId));
    return id !== null && this.splitBattleIds().includes(id);
  }

  protected toggleSplitBattle(battleId: string | number): void {
    const id = this.parsePositiveId(String(battleId));
    if (!id) return;
    this.splitBattleIds.update((ids) =>
      ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id],
    );
    this.clearDialogError();
  }

  protected stageMerge(event: SubmitEvent): void {
    event.preventDefault();
    const currentId = this.fight()?.id;
    const targetId = this.parsePositiveId(this.mergeTargetId());
    const otherIds = this.parseIdList(this.mergeOtherIds());
    if (!currentId || !targetId || otherIds === null) {
      this.dialogError.set(this.t('fights.mergeInvalid'));
      return;
    }
    const fightIds = [...new Set([currentId, targetId, ...otherIds])];
    if (fightIds.length < 2) {
      this.dialogError.set(this.t('fights.mergeNeedTwo'));
      return;
    }
    this.mergeOpen.set(false);
    this.pendingMutation.set({
      kind: 'merge',
      body: { target_fight_id: targetId, fight_ids: fightIds },
      description: this.t('fights.mergeDescription', {
        fights: fightIds.map((id) => this.t('fights.fightNumber', { id })).join(', '),
        target: targetId,
      }),
    });
  }

  protected stageSplit(event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const selected = this.splitBattleIds();
    const total = this.fight()?.battle_ids.length ?? 0;
    if (!sourceId || selected.length === 0 || selected.length >= total) {
      this.dialogError.set(this.t('fights.splitInvalid'));
      return;
    }
    this.splitOpen.set(false);
    this.pendingMutation.set({
      kind: 'split',
      body: { battle_ids: selected },
      description: this.t('fights.splitDescription', {
        battles: selected.map((id) => this.t('fights.battleNumber', { id })).join(', '),
      }),
    });
  }

  protected stageMove(battleId: number, event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const targetId = this.parsePositiveId(this.moveTargetId());
    if (!sourceId || !targetId || targetId === sourceId) {
      this.dialogError.set(this.t('fights.moveInvalid'));
      return;
    }
    this.moveBattleId.set(null);
    this.pendingMutation.set({
      kind: 'move',
      battleId,
      body: { battle_id: battleId, target_fight_id: targetId },
      description: this.t('fights.moveDescription', {
        battleId,
        sourceId,
        targetId,
      }),
    });
  }

  protected cancelPendingMutation(): void {
    if (this.mutating()) return;
    this.pendingMutation.set(null);
    this.dialogError.set(null);
  }

  protected async confirmMutation(): Promise<void> {
    const pending = this.pendingMutation();
    const sourceId = this.fight()?.id;
    if (!pending || !sourceId) return;
    this.mutating.set(true);
    this.dialogError.set(null);
    this.mutationError.set(null);
    try {
      const path =
        pending.kind === 'merge'
          ? 'api/fights/merge'
          : pending.kind === 'split'
            ? `api/fights/${sourceId}/split`
            : `api/fights/${sourceId}/move-battle`;
      const result = await firstValueFrom(this.api.post<FightMutationResult>(path, pending.body));
      this.pendingMutation.set(null);
      this.mutationSuccess.set(this.t('fights.mutationSuccess', { id: result.fight_id }));
      if (result.fight_id === sourceId) {
        await this.load();
      } else {
        await this.router.navigate(['/fights', result.fight_id]);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : this.t('fights.mutationFailed');
      this.dialogError.set(message);
      this.mutationError.set(message);
    } finally {
      this.mutating.set(false);
    }
  }

  // Format Helpers
  protected fightWindow(fight: FightDetail): string {
    const start = this.formatDate(fight.started_at);
    return fight.ended_at ? this.t('fights.windowRange', { start, end: this.formatDate(fight.ended_at) }) : start;
  }

  protected formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  protected formatAmount(value: number | undefined): string {
    return Intl.NumberFormat().format(value ?? 0);
  }

  protected formatCompact(value: number | undefined): string {
    if (value === undefined || value === null) return '0';
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return value.toLocaleString();
  }

  protected formatDecimal(value: number | undefined): string {
    return (value ?? 0).toFixed(2);
  }

  protected readonly formatConfidence = formatConfidence;
  protected readonly albionBattlesUrl = albionBattlesUrl;

  private parsePositiveId(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  private parseIdList(value: string): number[] | null {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const ids = parts.map((part) => this.parsePositiveId(part));
    return ids.every((id): id is number => id !== null) ? ids : null;
  }
}
