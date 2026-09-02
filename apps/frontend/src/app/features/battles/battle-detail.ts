import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { resolveBattleOutcome, type BattleOutcomeType } from './battle-outcome';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

const ALBION_RENDER_ITEM_BASE_URL = 'https://render.albiononline.com/v1/item';
const DEFAULT_OUR_GUILD_NAME = 'weaklings';

type DetailTab = 'overview' | 'guild_alliance' | 'guilds' | 'players' | 'timeline';

type KillFeedFilter = 'all' | 'our_kills' | 'our_deaths' | 'high_fame' | 'solo';
type PlayerSideFilter = 'all' | 'allies' | 'enemies';
type KillSide = 'killer' | 'victim';

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
    DataTable,
    DataTableCell,
    EquipmentGrid,
    ErrorState,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (battle(); as detail) {
      <button type="button" class="btn btn--ghost btn--sm mb-4" (click)="backToBattles()">
        ← {{ t('nav.battles') }}
      </button>

      <app-page-header [title]="'#' + detail.battle_id" [subtitle]="battleSubtitle(detail)">
        <button
          type="button"
          class="btn btn--outline btn--sm"
          (click)="copyBattleLink()"
          [title]="t('battles.copy_link')"
        >
          {{ t('battles.copy_link') }}
        </button>
        <a
          class="btn btn--ghost btn--sm no-underline"
          [href]="'https://albionbattles.com/battles/' + detail.battle_id"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('battles.view_on_albionbb') }} ↗
        </a>
        <app-view-toggle
          pageTabs
          [options]="tabOptions()"
          [active]="tab()"
          (activeChange)="switchTab($event)"
        />
      </app-page-header>

      <app-page-stack>
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="chip font-semibold"
          [class.chip--success]="battleVerdict().type === 'victory'"
          [class.chip--error]="battleVerdict().type === 'defeat'"
          [class.chip--warning]="battleVerdict().type === 'contested'"
        >
          {{ battleVerdict().label }}
        </span>

        @if (ourGuildAllianceName(); as allyName) {
          <span class="chip chip--info font-mono font-medium">
            [{{ allyName }}] {{ ourGuild()?.name || t('battles.allies') }}
          </span>
        } @else if (ourGuild()?.name; as gName) {
          <span class="chip chip--info font-mono font-medium">
            {{ gName }}
          </span>
        }

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
      </div>

      <!-- ================= 6 CORE KPI METRIC CARDS ================= -->
      <section
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
        aria-label="Core Battle KPIs"
      >
        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.total_fame') }}</p>
          <p class="battle-detail__value text-warning">{{ formatCompact(detail.total_fame) }}</p>
          <p class="battle-detail__sub">
            Our share: <strong class="mono">{{ formatDecimal(ourAllianceFameShare()) }}%</strong>
          </p>
        </article>

        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.kills') }} / {{ t('battles.deaths') }}</p>
          <p class="battle-detail__value">
            {{ formatAmount(detail.total_kills) }} / {{ formatAmount(totalBattleDeaths()) }}
          </p>
          <p class="battle-detail__sub">
            Our K/D:
            <strong
              class="mono"
              [class.text-success]="ourGuildKdRatio() >= 1"
              [class.text-error]="ourGuildKdRatio() < 1"
            >
              {{ formatDecimal(ourGuildKdRatio()) }}
            </strong>
          </p>
        </article>

        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.kill_participation') }}</p>
          <p class="battle-detail__value">{{ formatDecimal(ourKillParticipation()) }}%</p>
          <p class="battle-detail__sub">
            <span class="mono">{{ ourGuild()?.kills ?? 0 }}</span> our kills
          </p>
        </article>

        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.avg_ip') }}</p>
          <p class="battle-detail__value">{{ formatDecimal(ourGuildAvgIp()) }}</p>
          <p class="battle-detail__sub">
            Battle avg: <span class="mono">{{ formatDecimal(battleAvgIp()) }}</span>
          </p>
        </article>

        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.silver_lost') }}</p>
          <p class="battle-detail__value text-error">
            {{ formatCompact(detail.estimated_losses.total_estimated_loss) }}
          </p>
          <p class="battle-detail__sub">
            {{ detail.estimated_losses.priced_items }} /
            {{ detail.estimated_losses.total_items }} items priced
          </p>
        </article>

        <article class="surface p-4">
          <p class="battle-detail__label">{{ t('battles.survival_rate') }}</p>
          <p class="battle-detail__value">{{ formatDecimal(ourSurvivalRate()) }}%</p>
          <p class="battle-detail__sub">
            <span class="mono">{{ ourSurvivingCount() }} / {{ ourGuild()?.players ?? 0 }}</span> survived
          </p>
        </article>
      </section>

      <!-- ================= TAB CONTENT ================= -->

      <!-- TAB 1: OVERVIEW & MATCHUP -->
      @if (tab() === 'overview') {
        <!-- Faction Head-to-Head Banner -->
        <section class="mt-5 card p-5 overflow-hidden">
          <h2 class="eyebrow mb-4">TACTICAL FACTION MATCHUP</h2>
          <div class="grid gap-6 lg:grid-cols-11 lg:items-center">
            <!-- OUR FORCES -->
            <div class="lg:col-span-5 rounded-lg p-4 battle-detail__faction-card battle-detail__faction-card--allies">
              <div class="flex items-center justify-between mb-2">
                <span class="chip chip--success font-semibold">
                  {{ ourGuildAllianceName() ? '[' + ourGuildAllianceName() + '] ' + (ourGuild()?.name || 'Allies') : (ourGuild()?.name || 'Our Guild') }}
                </span>
                <span class="text-xs text-secondary mono">{{ ourAlliance()?.players ?? ourGuild()?.players ?? 0 }} fighters</span>
              </div>
              <div class="grid grid-cols-3 gap-2 mt-3 text-center">
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">Kills / Deaths</p>
                  <p class="font-bold text-base mono">
                    {{ ourAlliance()?.kills ?? ourGuild()?.kills ?? 0 }} / {{ ourAlliance()?.deaths ?? ourGuild()?.deaths ?? 0 }}
                  </p>
                </div>
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">K/D Ratio</p>
                  <p class="font-bold text-base mono" [class.text-success]="(ourAlliance()?.kdRatio ?? 1) >= 1">
                    {{ formatDecimal(ourAlliance()?.kdRatio ?? ourGuildKdRatio()) }}
                  </p>
                </div>
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">Kill Fame</p>
                  <p class="font-bold text-base mono text-warning">
                    {{ formatCompact(ourAlliance()?.killFame ?? ourGuild()?.kill_fame ?? 0) }}
                  </p>
                </div>
              </div>
            </div>

            <!-- VS DIVIDER -->
            <div class="lg:col-span-1 text-center flex flex-col items-center justify-center">
              <span class="battle-detail__vs-badge">VS</span>
            </div>

            <!-- ENEMY FORCES -->
            <div class="lg:col-span-5 rounded-lg p-4 battle-detail__faction-card battle-detail__faction-card--enemies">
              <div class="flex items-center justify-between mb-2">
                <span class="chip chip--error font-semibold">
                  {{ topEnemyAlliance()?.name ? '[' + topEnemyAlliance()?.name + '] ' + (topEnemyAlliance()?.guilds?.[0]?.name || 'Enemies') : (topEnemyGuild()?.name || 'Hostile Coalition') }}
                </span>
                <span class="text-xs text-secondary mono">{{ enemyForcesPlayers() }} fighters</span>
              </div>
              <div class="grid grid-cols-3 gap-2 mt-3 text-center">
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">Kills / Deaths</p>
                  <p class="font-bold text-base mono">
                    {{ enemyForcesKills() }} / {{ enemyForcesDeaths() }}
                  </p>
                </div>
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">K/D Ratio</p>
                  <p class="font-bold text-base mono">
                    {{ formatDecimal(enemyForcesKdRatio()) }}
                  </p>
                </div>
                <div class="surface p-2 rounded">
                  <p class="text-xs text-disabled">Kill Fame</p>
                  <p class="font-bold text-base mono text-warning">
                    {{ formatCompact(enemyForcesKillFame()) }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Interactive Timeline Skirmish Chart -->
        <section class="mt-5 surface p-5">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 class="battle-detail__panel-title mb-0">{{ t('battles.timeline_density') }}</h2>
              <p class="text-xs text-secondary">
                Minute-by-minute combat intensity. Click any minute column to filter the kill feed.
              </p>
            </div>
            @if (selectedTimelineMinute() !== null) {
              <div class="flex items-center gap-2">
                <span class="chip chip--info font-mono">
                  Filtered: {{ selectedTimelineMinute() }}m
                </span>
                <button type="button" class="btn btn--ghost btn--sm" (click)="clearTimelineMinuteFilter()">
                  Clear
                </button>
              </div>
            }
          </div>

          <div class="battle-detail__timeline-container scrollbar-thin">
            <div class="battle-detail__timeline-bars">
              @for (bucket of timelineBuckets(); track bucket.minute) {
                <div
                  class="battle-detail__timeline-col"
                  [class.battle-detail__timeline-col--active]="selectedTimelineMinute() === bucket.minute"
                  (click)="toggleTimelineMinute(bucket.minute)"
                  tabindex="0"
                  role="button"
                  [attr.aria-label]="'Minute ' + bucket.minute + ': ' + bucket.totalKills + ' kills'"
                >
                  <div class="battle-detail__timeline-bar-wrapper">
                    <!-- Our Kills Stack -->
                    @if (bucket.ourKills > 0) {
                      <div
                        class="battle-detail__timeline-stack battle-detail__timeline-stack--allies"
                        [style.height.%]="percentage(bucket.ourKills, maxTimelineKills())"
                        [title]="'Our Kills: ' + bucket.ourKills"
                      ></div>
                    }
                    <!-- Enemy Kills Stack -->
                    @if (bucket.enemyKills > 0) {
                      <div
                        class="battle-detail__timeline-stack battle-detail__timeline-stack--enemies"
                        [style.height.%]="percentage(bucket.enemyKills, maxTimelineKills())"
                        [title]="'Enemy Kills: ' + bucket.enemyKills"
                      ></div>
                    }
                  </div>
                  <span class="battle-detail__timeline-label mono">{{ bucket.label }}</span>
                  <span class="battle-detail__timeline-value mono">{{ bucket.totalKills }}</span>
                </div>
              } @empty {
                <p class="text-sm text-secondary">No kill timestamps recorded.</p>
              }
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between text-xs text-secondary border-t pt-2" style="border-color: var(--color-border)">
            <div class="flex items-center gap-4">
              <span class="inline-flex items-center gap-1.5">
                <span class="inline-block w-3 h-3 rounded-full bg-success"></span>
                Our Guild / Alliance Kills
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span class="inline-block w-3 h-3 rounded-full bg-error"></span>
                Enemy Kills
              </span>
            </div>
            <span>Total Kills: <strong class="mono">{{ detail.total_kills }}</strong></span>
          </div>
        </section>

        <!-- Charts Row -->
        <section class="mt-5 grid gap-4 lg:grid-cols-3">
          <!-- Alliance & Guild Fame Distribution -->
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Fame Distribution by Alliance</h2>
            @for (ally of alliances(); track ally.name) {
              <div class="battle-detail__bar-row">
                <span class="truncate font-medium" [class.text-success]="ally.isOurAlliance">
                  {{ ally.isSolo ? ally.name : '[' + ally.name + ']' }}
                </span>
                <div class="battle-detail__bar" [class.battle-detail__bar--allies]="ally.isOurAlliance">
                  <span [style.width.%]="percentage(ally.killFame, detail.total_fame)"></span>
                </div>
                <strong class="mono">{{ formatCompact(ally.killFame) }}</strong>
              </div>
            }
          </article>

          <!-- Top Guilds K/D Leaders -->
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Top Guilds by K/D Ratio</h2>
            @for (guild of topKdGuilds(); track guild.id || guild.name) {
              <div class="battle-detail__bar-row">
                <span class="truncate" [class.font-bold]="guild.isOurGuild">
                  {{ guild.name }}
                </span>
                <div class="battle-detail__bar battle-detail__bar--kills">
                  <span [style.width.%]="percentage(guild.kdRatio, maxGuildKd())"></span>
                </div>
                <strong class="mono">{{ formatDecimal(guild.kdRatio) }}</strong>
              </div>
            }
          </article>

          <!-- Weapon Role Distribution -->
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.class_breakdown') }}</h2>
            @for (roleStat of roleDistribution(); track roleStat.role) {
              <div class="battle-detail__bar-row">
                <span class="capitalize">{{ formatRoleName(roleStat.role) }}</span>
                <div class="battle-detail__bar battle-detail__bar--players">
                  <span [style.width.%]="percentage(roleStat.count, detail.players.length)"></span>
                </div>
                <strong class="mono">{{ roleStat.count }} ({{ formatDecimal(percentage(roleStat.count, detail.players.length)) }}%)</strong>
              </div>
            }
          </article>
        </section>
      }

      <!-- TAB 2: MY GUILD & ALLIANCE DEEP DIVE -->
      @else if (tab() === 'guild_alliance') {
        <!-- Alliance & Guild Command Overview -->
        @if (ourGuild(); as guild) {
          <section class="mt-5 grid gap-4 lg:grid-cols-3">
            <!-- Our Guild Performance Verdict Card -->
            <article class="surface p-5 lg:col-span-2 border-l-4" [style.border-left-color]="'var(--color-primary)'">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 class="text-xl font-bold" style="color: var(--color-text)">
                  {{ guild.name }} Performance Report
                </h2>
                @if (ourGuildAllianceName(); as allyName) {
                  <span class="chip chip--info font-mono">
                    Alliance: [{{ allyName }}]
                  </span>
                }
              </div>
              <p class="text-sm text-secondary mb-4">
                {{ guild.players }} guild members engaged in this battle, achieving
                {{ guild.kills }} kills and {{ guild.deaths }} deaths.
              </p>

              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div class="surface p-3 rounded">
                  <p class="text-xs text-disabled uppercase">{{ t('battles.fame_efficiency') }}</p>
                  <p class="text-lg font-bold mono text-warning">
                    {{ formatCompact(safeDivide(guild.kill_fame, guild.players)) }}
                  </p>
                  <p class="text-xs text-secondary">per player</p>
                </div>
                <div class="surface p-3 rounded">
                  <p class="text-xs text-disabled uppercase">{{ t('battles.net_fame') }}</p>
                  <p class="text-lg font-bold mono" [class.text-success]="ourGuildNetFame() >= 0" [class.text-error]="ourGuildNetFame() < 0">
                    {{ ourGuildNetFame() >= 0 ? '+' : '' }}{{ formatCompact(ourGuildNetFame()) }}
                  </p>
                  <p class="text-xs text-secondary">earned - lost</p>
                </div>
                <div class="surface p-3 rounded">
                  <p class="text-xs text-disabled uppercase">{{ t('battles.kill_death') }}</p>
                  <p class="text-lg font-bold mono" [class.text-success]="ourGuildKdRatio() >= 1">
                    {{ formatDecimal(ourGuildKdRatio()) }}
                  </p>
                  <p class="text-xs text-secondary">{{ guild.kills }}K / {{ guild.deaths }}D</p>
                </div>
                <div class="surface p-3 rounded">
                  <p class="text-xs text-disabled uppercase">{{ t('battles.silver_lost') }}</p>
                  <p class="text-lg font-bold mono text-error">
                    {{ formatCompact(ourGuildEstimatedLoss()) }}
                  </p>
                  <p class="text-xs text-secondary">estimated gear</p>
                </div>
              </div>
            </article>

            <!-- Alliance Share Donut / Gauge -->
            <article class="surface p-5 flex flex-col justify-between">
              <h2 class="battle-detail__panel-title mb-2">Our Alliance Battle Share</h2>
              <div class="flex items-center justify-center my-auto py-2">
                <svg class="battle-detail__donut" viewBox="0 0 42 42" role="img" aria-label="Alliance fame share">
                  <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--color-surface-2)" stroke-width="6"></circle>
                  <circle
                    cx="21"
                    cy="21"
                    r="15.9"
                    fill="transparent"
                    stroke="var(--color-primary)"
                    stroke-width="6"
                    [attr.stroke-dasharray]="allianceDonutDashArray()"
                    stroke-dashoffset="25"
                  ></circle>
                  <text x="21" y="22.5" text-anchor="middle" class="font-bold">
                    {{ formatDecimal(ourAllianceFameShare()) }}%
                  </text>
                </svg>
              </div>
              <p class="text-xs text-center text-secondary mt-2">
                [{{ ourGuildAllianceName() || 'Allies' }}] accounted for {{ formatDecimal(ourAllianceFameShare()) }}% of total battle kill fame.
              </p>
            </article>
          </section>
        }

        <!-- Squad MVPs & Tactical Honors -->
        <section class="mt-5" aria-label="Guild MVPs">
          <h2 class="eyebrow mb-3">SQUAD MVPs & NOTABLE HONORS</h2>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <!-- Top Killer MVP -->
            <article class="card p-4 border-l-4" style="border-left-color: var(--color-warning)">
              <p class="text-xs text-disabled uppercase font-semibold">TOP EXECUTIONER</p>
              <div class="mt-2 flex items-center gap-3">
                @if (guildMvpKiller(); as player) {
                  <img [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')" alt="" class="w-10 h-10 rounded bg-surface-2 p-1" />
                  <div class="truncate">
                    <p class="font-bold text-sm truncate" style="color: var(--color-text)">{{ player.name }}</p>
                    <p class="text-xs text-warning font-bold mono">{{ player.kills }} Kills</p>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">No kills recorded</p>
                }
              </div>
            </article>

            <!-- Top Fame Hunter -->
            <article class="card p-4 border-l-4" style="border-left-color: var(--color-accent-gold)">
              <p class="text-xs text-disabled uppercase font-semibold">FAME HUNTER</p>
              <div class="mt-2 flex items-center gap-3">
                @if (guildMvpFame(); as player) {
                  <img [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')" alt="" class="w-10 h-10 rounded bg-surface-2 p-1" />
                  <div class="truncate">
                    <p class="font-bold text-sm truncate" style="color: var(--color-text)">{{ player.name }}</p>
                    <p class="text-xs text-warning font-bold mono">{{ formatCompact(player.kill_fame) }} Fame</p>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">No fame recorded</p>
                }
              </div>
            </article>

            <!-- Iron Vanguard (Highest IP) -->
            <article class="card p-4 border-l-4" style="border-left-color: var(--color-primary)">
              <p class="text-xs text-disabled uppercase font-semibold">IRON VANGUARD</p>
              <div class="mt-2 flex items-center gap-3">
                @if (guildMvpHighestIp(); as player) {
                  <img [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')" alt="" class="w-10 h-10 rounded bg-surface-2 p-1" />
                  <div class="truncate">
                    <p class="font-bold text-sm truncate" style="color: var(--color-text)">{{ player.name }}</p>
                    <p class="text-xs text-primary font-bold mono">{{ formatDecimal(player.item_power) }} IP</p>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">—</p>
                }
              </div>
            </article>

            <!-- Top Survivor -->
            <article class="card p-4 border-l-4" style="border-left-color: var(--color-success)">
              <p class="text-xs text-disabled uppercase font-semibold">APEX SURVIVOR</p>
              <div class="mt-2 flex items-center gap-3">
                @if (guildMvpSurvivor(); as player) {
                  <img [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')" alt="" class="w-10 h-10 rounded bg-surface-2 p-1" />
                  <div class="truncate">
                    <p class="font-bold text-sm truncate" style="color: var(--color-text)">{{ player.name }}</p>
                    <p class="text-xs text-success font-bold mono">0 Deaths ({{ player.kills }}K)</p>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">—</p>
                }
              </div>
            </article>

            <!-- Heaviest Loss -->
            <article class="card p-4 border-l-4" style="border-left-color: var(--color-error)">
              <p class="text-xs text-disabled uppercase font-semibold">HEAVIEST CASUALTY</p>
              <div class="mt-2 flex items-center gap-3">
                @if (guildHeaviestLoss(); as player) {
                  <img [src]="itemIconUrl(player.weaponType || 'T4_MAIN_SWORD')" alt="" class="w-10 h-10 rounded bg-surface-2 p-1" />
                  <div class="truncate">
                    <p class="font-bold text-sm truncate" style="color: var(--color-text)">{{ player.name }}</p>
                    <p class="text-xs text-error font-bold mono">{{ formatCompact(player.estimatedLoss) }} Lost</p>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">0 losses</p>
                }
              </div>
            </article>
          </div>
        </section>

        <!-- Our Guild Roster Table -->
        <section class="mt-5 surface overflow-hidden">
          <header class="p-4 border-b flex flex-wrap items-center justify-between gap-3" style="border-color: var(--color-border)">
            <div>
              <h2 class="font-bold text-base" style="color: var(--color-text)">
                {{ ourGuild()?.name || 'Guild' }} Roster & Individual Contributions
              </h2>
              <p class="text-xs text-secondary">
                {{ ourGuildPlayers().length }} guild members who participated in this battle
              </p>
            </div>
            <div class="w-full sm:w-64">
              <input
                type="text"
                class="input input--sm"
                [placeholder]="t('battles.search_players')"
                [value]="playerSearchQuery()"
                (input)="onPlayerSearch($event)"
              />
            </div>
          </header>

          <app-data-table
            [columns]="guildRosterColumns"
            [rows]="filteredGuildRosterRows()"
            [error]="loadFailed()"
            [trackBy]="trackPlayerRow"
            [pageSize]="15"
            [hideSearch]="true"
            (retry)="load()"
          >
            <ng-template dataTableCell="player" let-row>
              <div class="flex items-center gap-2.5">
                <img
                  [src]="itemIconUrl(row.weaponType || 'T4_MAIN_SWORD')"
                  alt=""
                  class="w-7 h-7 rounded bg-surface-2 object-contain p-0.5"
                  loading="lazy"
                />
                <div>
                  <span class="font-medium block text-sm" style="color: var(--color-text)">{{ row.name }}</span>
                  <span class="chip text-xs py-0 px-1.5 capitalize font-mono text-secondary">
                    {{ formatRoleName(row.role) }}
                  </span>
                </div>
              </div>
            </ng-template>

            <ng-template dataTableCell="item_power" let-row>
              <span class="mono font-medium">{{ formatDecimal(row.item_power) }}</span>
            </ng-template>

            <ng-template dataTableCell="kills_deaths" let-row>
              <span class="mono">
                <strong class="text-success">{{ row.kills }}</strong> /
                <strong class="text-error">{{ row.deaths }}</strong>
              </span>
            </ng-template>

            <ng-template dataTableCell="kill_fame" let-row>
              <span class="mono text-warning font-medium">{{ formatCompact(row.kill_fame) }}</span>
            </ng-template>

            <ng-template dataTableCell="net_fame" let-row>
              <span class="mono font-medium" [class.text-success]="row.netFame >= 0" [class.text-error]="row.netFame < 0">
                {{ row.netFame >= 0 ? '+' : '' }}{{ formatCompact(row.netFame) }}
              </span>
            </ng-template>

            <ng-template dataTableCell="estimated_loss" let-row>
              <span class="mono" [class.text-error]="row.estimatedLoss > 0">
                {{ row.estimatedLoss > 0 ? formatCompact(row.estimatedLoss) : '—' }}
              </span>
            </ng-template>
          </app-data-table>
        </section>
      }

      <!-- TAB 3: ALLIANCES & GUILDS -->
      @else if (tab() === 'guilds') {
        <!-- Alliance Summary Cards -->
        <section class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Alliances in battle">
          @for (ally of alliances(); track ally.name) {
            <article class="card p-5" [class.border-2]="ally.isOurAlliance" [style.border-color]="ally.isOurAlliance ? 'var(--color-primary)' : 'var(--color-border)'">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <h3 class="text-lg font-bold" style="color: var(--color-text)">
                    {{ ally.isSolo ? ally.name : '[' + ally.name + ']' }}
                  </h3>
                  <p class="text-xs text-secondary">{{ ally.guilds.length }} {{ ally.guilds.length === 1 ? 'guild' : 'guilds' }} · {{ ally.players }} fighters</p>
                </div>
                @if (ally.isOurAlliance) {
                  <span class="chip chip--success">Our Alliance</span>
                }
              </div>

              <dl class="grid grid-cols-3 gap-2 text-center my-3">
                <div class="surface p-2 rounded">
                  <dt class="text-xs text-disabled">K / D</dt>
                  <dd class="font-bold mono text-sm">{{ ally.kills }} / {{ ally.deaths }}</dd>
                </div>
                <div class="surface p-2 rounded">
                  <dt class="text-xs text-disabled">K/D Ratio</dt>
                  <dd class="font-bold mono text-sm" [class.text-success]="ally.kdRatio >= 1">
                    {{ formatDecimal(ally.kdRatio) }}
                  </dd>
                </div>
                <div class="surface p-2 rounded">
                  <dt class="text-xs text-disabled">Fame</dt>
                  <dd class="font-bold mono text-sm text-warning">{{ formatCompact(ally.killFame) }}</dd>
                </div>
              </dl>

              <div class="mt-3 space-y-1 text-xs">
                <p class="text-disabled font-semibold">MEMBER GUILDS:</p>
                <div class="flex flex-wrap gap-1">
                  @for (g of ally.guilds; track g.id || g.name) {
                    <span class="chip chip--info text-xs py-0.5">
                      {{ g.name }} ({{ g.players }}p)
                    </span>
                  }
                </div>
              </div>
            </article>
          }
        </section>

        <!-- Full Guilds Data Table -->
        <article class="mt-5 surface overflow-hidden">
          <header class="p-4 border-b flex items-center justify-between" style="border-color: var(--color-border)">
            <h2 class="font-bold text-base" style="color: var(--color-text)">All Guilds in Battle</h2>
            <span class="text-xs text-secondary mono">{{ detail.guilds.length }} guilds</span>
          </header>

          <app-data-table
            [columns]="allGuildColumns"
            [rows]="enrichedGuildRows()"
            [error]="loadFailed()"
            [trackBy]="trackGuildRow"
            [pageSize]="12"
            (retry)="load()"
          >
            <ng-template dataTableCell="name" let-row>
              <div class="flex items-center gap-2">
                <span class="font-medium" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
                @if (row.alliance_name) {
                  <span class="chip text-xs py-0 px-1 font-mono">[{{ row.alliance_name }}]</span>
                }
                @if (row.winner) {
                  <span class="chip chip--success text-xs py-0">{{ t('battles.winner') }}</span>
                }
              </div>
            </ng-template>

            <ng-template dataTableCell="kill_fame" let-row>
              <span class="mono text-warning font-medium">{{ formatCompact(row.kill_fame) }}</span>
            </ng-template>

            <ng-template dataTableCell="kill_death" let-row>
              <span class="mono" [class.text-success]="row.kdRatio >= 1">
                {{ formatDecimal(row.kdRatio) }}
              </span>
            </ng-template>

            <ng-template dataTableCell="fame_per_player" let-row>
              <span class="mono">{{ formatCompact(row.famePerPlayer) }}</span>
            </ng-template>
          </app-data-table>
        </article>
      }

      <!-- TAB 4: PLAYERS & LEADERBOARDS -->
      @else if (tab() === 'players') {
        <!-- Player Filters & Search Toolbar -->
        <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="playerFilterSide() === 'all'"
              [class.btn--outline]="playerFilterSide() !== 'all'"
              (click)="setPlayerFilterSide('all')"
            >
              {{ t('battles.filter_all') }} ({{ detail.players.length }})
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="playerFilterSide() === 'allies'"
              [class.btn--outline]="playerFilterSide() !== 'allies'"
              (click)="setPlayerFilterSide('allies')"
            >
              {{ t('battles.filter_allies') }} ({{ allyPlayersCount() }})
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="playerFilterSide() === 'enemies'"
              [class.btn--outline]="playerFilterSide() !== 'enemies'"
              (click)="setPlayerFilterSide('enemies')"
            >
              {{ t('battles.filter_enemies') }} ({{ enemyPlayersCount() }})
            </button>
          </div>

          <div class="w-full sm:w-72">
            <input
              type="text"
              class="input input--sm"
              [placeholder]="t('battles.search_players')"
              [value]="playerSearchQuery()"
              (input)="onPlayerSearch($event)"
            />
          </div>
        </div>

        <!-- Full Players Data Table -->
        <article class="mt-4 surface overflow-hidden">
          <app-data-table
            [columns]="allPlayerColumns"
            [rows]="filteredAllPlayerRows()"
            [error]="loadFailed()"
            [trackBy]="trackPlayerRow"
            [pageSize]="20"
            [hideSearch]="true"
            (retry)="load()"
          >
            <ng-template dataTableCell="name" let-row>
              <div class="flex items-center gap-2">
                <img
                  [src]="itemIconUrl(row.weaponType || 'T4_MAIN_SWORD')"
                  alt=""
                  class="w-7 h-7 rounded bg-surface-2 object-contain p-0.5"
                  loading="lazy"
                />
                <div>
                  <span class="font-medium block text-sm" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
                  <span class="text-xs text-secondary">{{ row.guild_name }}</span>
                  @if (row.alliance_name) {
                    <span class="text-xs text-disabled mono"> [{{ row.alliance_name }}]</span>
                  }
                </div>
              </div>
            </ng-template>

            <ng-template dataTableCell="item_power" let-row>
              <span class="mono font-medium">{{ formatDecimal(row.item_power) }}</span>
            </ng-template>

            <ng-template dataTableCell="kills" let-row>
              <span class="mono font-bold" [class.text-success]="row.kills > 0">{{ row.kills }}</span>
            </ng-template>

            <ng-template dataTableCell="deaths" let-row>
              <span class="mono" [class.text-error]="row.deaths > 0">{{ row.deaths }}</span>
            </ng-template>

            <ng-template dataTableCell="kill_fame" let-row>
              <span class="mono text-warning font-medium">{{ formatCompact(row.kill_fame) }}</span>
            </ng-template>

            <ng-template dataTableCell="death_fame" let-row>
              <span class="mono text-error">{{ formatCompact(row.death_fame) }}</span>
            </ng-template>
          </app-data-table>
        </article>
      }

      <!-- TAB 5: KILL FEED & TIMELINE -->
      @else {
        <!-- Filter Toolbar -->
        <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="killFeedFilter() === 'all'"
              [class.btn--outline]="killFeedFilter() !== 'all'"
              (click)="setKillFeedFilter('all')"
            >
              {{ t('battles.filter_all') }} ({{ detail.kills.length }})
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="killFeedFilter() === 'our_kills'"
              [class.btn--outline]="killFeedFilter() !== 'our_kills'"
              (click)="setKillFeedFilter('our_kills')"
            >
              {{ t('battles.filter_our_kills') }} ({{ ourKillCount() }})
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="killFeedFilter() === 'our_deaths'"
              [class.btn--outline]="killFeedFilter() !== 'our_deaths'"
              (click)="setKillFeedFilter('our_deaths')"
            >
              {{ t('battles.filter_our_deaths') }} ({{ ourDeathCount() }})
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [class.btn--primary]="killFeedFilter() === 'high_fame'"
              [class.btn--outline]="killFeedFilter() !== 'high_fame'"
              (click)="setKillFeedFilter('high_fame')"
            >
              {{ t('battles.filter_high_fame') }} (>250k)
            </button>
          </div>

          <div class="w-full sm:w-72">
            <input
              type="text"
              class="input input--sm"
              placeholder="Search killer or victim..."
              [value]="killSearchQuery()"
              (input)="onKillSearch($event)"
            />
          </div>
        </div>

        @if (selectedTimelineMinute() !== null) {
          <div class="mt-3 p-3 bg-surface-1 rounded-lg border flex items-center justify-between text-xs" style="border-color: var(--color-border)">
            <span>Showing kills occurring during <strong>Minute {{ selectedTimelineMinute() }}</strong> of the fight.</span>
            <button type="button" class="btn btn--ghost btn--sm" (click)="clearTimelineMinuteFilter()">
              Show All Minutes
            </button>
          </div>
        }

        <!-- Kill Event Feed Rows -->
        <section class="mt-4 space-y-3" aria-label="Kill Events">
          @for (kill of filteredKillRows(); track kill.event_id) {
            <article
              class="card p-4 battle-detail__kill-card"
              [class.battle-detail__kill-card--our-kill]="isOurGuildParticipant(kill.killer)"
              [class.battle-detail__kill-card--our-death]="isOurGuildParticipant(kill.victim)"
            >
              <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <!-- Timestamp & Combat Offset -->
                <div class="flex items-center gap-2 text-xs text-secondary shrink-0">
                  <span class="mono font-bold" style="color: var(--color-text)">
                    {{ formatTimeOffset(kill.time, detail.start_time) }}
                  </span>
                  <span>·</span>
                  <span class="mono">{{ formatTime(kill.time) }}</span>
                </div>

                <!-- Combatants: Killer -> Victim -->
                <div class="flex flex-wrap items-center gap-4 flex-1 justify-center">
                  <!-- Killer -->
                  <div class="flex items-center gap-2 text-left min-w-44">
                    <img
                      [src]="participantWeaponIcon(kill, 'killer')"
                      alt=""
                      class="w-9 h-9 rounded bg-surface-2 object-contain p-0.5 shrink-0"
                      loading="lazy"
                    />
                    <div class="truncate">
                      <p class="font-bold text-sm truncate" [class.text-success]="isOurGuildParticipant(kill.killer)" style="color: var(--color-text)">
                        {{ kill.killer.name }}
                      </p>
                      <p class="text-xs text-secondary truncate">
                        {{ kill.killer.guild_name || t('common.none') }}
                        @if (resolveParticipantAlliance(kill.killer); as ally) {
                          <span class="mono text-disabled"> [{{ ally }}]</span>
                        }
                      </p>
                    </div>
                  </div>

                  <!-- VS & Bounty Badge -->
                  <div class="flex flex-col items-center gap-1 shrink-0 px-2">
                    <span class="chip chip--warning text-xs font-mono font-bold py-0.5">
                      +{{ formatCompact(kill.total_kill_fame) }} Fame
                    </span>
                    <span class="text-xs text-disabled mono">
                      {{ formatDecimal(kill.killer_item_power) }} IP → {{ formatDecimal(kill.victim_item_power) }} IP
                    </span>
                  </div>

                  <!-- Victim -->
                  <div class="flex items-center gap-2 text-left min-w-44">
                    <img
                      [src]="participantWeaponIcon(kill, 'victim')"
                      alt=""
                      class="w-9 h-9 rounded bg-surface-2 object-contain p-0.5 shrink-0"
                      loading="lazy"
                    />
                    <div class="truncate">
                      <p class="font-bold text-sm truncate" [class.text-error]="isOurGuildParticipant(kill.victim)" style="color: var(--color-text)">
                        {{ kill.victim.name }}
                      </p>
                      <p class="text-xs text-secondary truncate">
                        {{ kill.victim.guild_name || t('common.none') }}
                        @if (resolveParticipantAlliance(kill.victim); as ally) {
                          <span class="mono text-disabled"> [{{ ally }}]</span>
                        }
                      </p>
                    </div>
                  </div>
                </div>

                <!-- Loadout Toggle Action -->
                <div class="shrink-0 text-right">
                  <button
                    type="button"
                    class="btn btn--outline btn--sm"
                    [attr.aria-expanded]="expandedKill() === kill.event_id"
                    (click)="toggleKillLoadout(kill.event_id)"
                  >
                    {{ expandedKill() === kill.event_id ? t('battles.hideGear') : t('battles.showGear') }}
                  </button>
                </div>
              </div>

              <!-- Expanded Gear Inspector (Victim & Killer) -->
              @if (expandedKill() === kill.event_id) {
                <div class="mt-4 border-t pt-4 grid gap-6 md:grid-cols-2" style="border-color: var(--color-border)">
                  <!-- Victim Lost Loadout -->
                  <div class="surface p-4 rounded-lg">
                    <div class="flex items-center justify-between mb-3">
                      <h4 class="text-xs font-bold uppercase text-error">
                        {{ t('battles.lostGear') }} — {{ kill.victim.name }}
                      </h4>
                      <span class="mono text-xs text-secondary">
                        {{ kill.victim.guild_name || '' }}
                      </span>
                    </div>
                    <app-equipment-grid [items]="participantLoadout(kill, 'victim')" />
                  </div>

                  <!-- Killer Loadout -->
                  <div class="surface p-4 rounded-lg">
                    <div class="flex items-center justify-between mb-3">
                      <h4 class="text-xs font-bold uppercase text-success">
                        {{ t('battles.killer_loadout') }} — {{ kill.killer.name }}
                      </h4>
                      <span class="mono text-xs text-secondary">
                        {{ kill.killer.guild_name || '' }}
                      </span>
                    </div>
                    <app-equipment-grid [items]="participantLoadout(kill, 'killer')" />
                  </div>
                </div>
              }
            </article>
          } @empty {
            <p class="p-8 text-center text-sm text-secondary surface rounded-lg">
              {{ t('battles.no_matching_kills') }}
            </p>
          }
        </section>
      }
      </app-page-stack>
    } @else {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    }
  `,
  styles: `
    @layer components {
      .battle-detail__label {
        color: var(--color-text-disabled);
        font-size: 0.72rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .battle-detail__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.65rem);
        font-weight: 700;
        font-family: var(--font-mono);
      }
      .battle-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .battle-detail__panel-title {
        color: var(--color-text);
        font-size: 0.95rem;
        font-weight: 700;
        margin-bottom: 1rem;
      }
      .battle-detail__faction-card {
        border: 1px solid var(--color-border);
      }
      .battle-detail__faction-card--allies {
        background: color-mix(in srgb, var(--color-success-container) 40%, var(--color-surface));
        border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border));
      }
      .battle-detail__faction-card--enemies {
        background: color-mix(in srgb, var(--color-error-container) 40%, var(--color-surface));
        border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border));
      }
      .battle-detail__vs-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        border-radius: var(--radius-full);
        background: var(--color-surface-2);
        color: var(--color-text-secondary);
        font-weight: 800;
        font-size: 0.8rem;
        border: 1px solid var(--color-border-strong);
      }
      .battle-detail__donut {
        display: block;
        height: 12rem;
        max-width: 12rem;
        width: 100%;
        margin: 0 auto;
      }
      .battle-detail__donut text {
        fill: var(--color-text);
        font-size: 0.35rem;
        font-family: var(--font-mono);
      }
      .battle-detail__bar-row {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(6rem, 1.2fr) minmax(6rem, 2fr) auto;
        margin-top: 0.75rem;
      }
      .battle-detail__bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.65rem;
        overflow: hidden;
      }
      .battle-detail__bar span {
        background: var(--color-primary);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
      }
      .battle-detail__bar--allies span {
        background: var(--color-success);
      }
      .battle-detail__bar--kills span {
        background: var(--color-warning);
      }
      .battle-detail__bar--danger span {
        background: var(--color-error);
      }
      .battle-detail__bar--players span {
        background: var(--color-primary);
      }

      /* Interactive Timeline Skirmish Graph */
      .battle-detail__timeline-container {
        overflow-x: auto;
        padding-bottom: 0.5rem;
      }
      .battle-detail__timeline-bars {
        display: flex;
        align-items: flex-end;
        gap: 0.5rem;
        height: 9rem;
        min-width: max-content;
        padding-top: 1rem;
      }
      .battle-detail__timeline-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 2.2rem;
        cursor: pointer;
        padding: 0.25rem;
        border-radius: var(--radius-sm);
        transition: background-color 120ms ease;
      }
      .battle-detail__timeline-col:hover {
        background: var(--color-surface-hover);
      }
      .battle-detail__timeline-col--active {
        background: var(--color-surface-2);
        outline: 1px solid var(--color-primary);
      }
      .battle-detail__timeline-bar-wrapper {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        width: 100%;
        height: 6rem;
        background: var(--color-surface-2);
        border-radius: var(--radius-sm);
        overflow: hidden;
        gap: 1px;
      }
      .battle-detail__timeline-stack {
        width: 100%;
        min-height: 2px;
        transition: height 150ms ease;
      }
      .battle-detail__timeline-stack--allies {
        background: var(--color-success);
      }
      .battle-detail__timeline-stack--enemies {
        background: var(--color-error);
      }
      .battle-detail__timeline-label {
        font-size: 0.65rem;
        color: var(--color-text-secondary);
        margin-top: 0.25rem;
      }
      .battle-detail__timeline-value {
        font-size: 0.7rem;
        font-weight: 700;
        color: var(--color-text);
      }

      /* Kill Feed Cards */
      .battle-detail__kill-card {
        border-left: 3px solid transparent;
        transition: border-color 120ms ease;
      }
      .battle-detail__kill-card--our-kill {
        border-left-color: var(--color-success);
        background: color-mix(in srgb, var(--color-success-container) 15%, var(--color-surface));
      }
      .battle-detail__kill-card--our-death {
        border-left-color: var(--color-error);
        background: color-mix(in srgb, var(--color-error-container) 15%, var(--color-surface));
      }
    }
  `,
})
export class BattleDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly battle = signal<BattleDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly tab = signal<DetailTab>('overview');

  // Filter signals
  protected readonly selectedTimelineMinute = signal<number | null>(null);
  protected readonly killFeedFilter = signal<KillFeedFilter>('all');
  protected readonly killSearchQuery = signal<string>('');
  protected readonly playerFilterSide = signal<PlayerSideFilter>('all');
  protected readonly playerSearchQuery = signal<string>('');
  protected readonly expandedKill = signal<number | null>(null);

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'overview', label: this.t('battles.overview') },
    { id: 'guild_alliance', label: this.t('battles.my_guild_alliance') },
    { id: 'guilds', label: this.t('battles.alliances_guilds') },
    { id: 'players', label: this.t('battles.top_players') },
    { id: 'timeline', label: this.t('battles.kill_feed') },
  ]);

  // Our guild identifier
  protected readonly ourGuild = computed<BattleGuildSummary | null>(() => {
    const detail = this.battle();
    if (!detail) return null;
    return (
      detail.guilds.find((g) => g.name.toLowerCase() === DEFAULT_OUR_GUILD_NAME) ??
      detail.guilds.find((g) => g.winner) ??
      detail.guilds[0] ??
      null
    );
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
    const ourGuildName = this.ourGuild()?.name.toLowerCase();
    const ourAlly = this.ourGuildAllianceName();
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
      const isOurAlliance = guilds.some(
        (g) => g.name.toLowerCase() === ourGuildName || (ourAlly && g.alliance_name === ourAlly),
      );

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
    const ourGuildName = this.ourGuild()?.name.toLowerCase();
    const detail = this.battle();
    if (!detail) return null;
    return (
      detail.guilds
        .filter((g) => g.name.toLowerCase() !== ourGuildName)
        .sort((a, b) => b.kill_fame - a.kill_fame)[0] ?? null
    );
  });

  // Battle Verdict computation
  // Shares `resolveBattleOutcome` with the battles list's own outcome badge so
  // the same battle can't read "Victory" there and "Contested" here.
  protected readonly battleVerdict = computed<{ label: string; type: 'victory' | 'defeat' | 'contested' }>(() => {
    const detail = this.battle();
    if (!detail) return { label: 'BATTLE', type: 'contested' };

    const type = resolveBattleOutcome({
      guilds: detail.guilds,
      totalFame: detail.total_fame,
      ourGuildName: DEFAULT_OUR_GUILD_NAME,
    });
    const labels: Record<BattleOutcomeType, TranslationKey> = {
      victory: 'battles.victory',
      defeat: 'battles.defeat',
      contested: 'battles.contested',
    };
    return { label: this.t(labels[type]), type };
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
    const ourGuildName = this.ourGuild()?.name.toLowerCase();
    const ourAllyName = this.ourGuildAllianceName()?.toLowerCase();

    const minuteMap = new Map<number, { ourKills: number; ourDeaths: number; enemyKills: number; fame: number }>();

    for (const kill of detail.kills) {
      const killTime = new Date(kill.time).getTime();
      const minute = Math.max(0, Math.floor((killTime - startTime) / 60000));
      const killerAlly = this.resolveParticipantAlliance(kill.killer)?.toLowerCase();
      const victimAlly = this.resolveParticipantAlliance(kill.victim)?.toLowerCase();

      const isOurKiller = (kill.killer.guild_name?.toLowerCase() === ourGuildName) ||
        (Boolean(ourAllyName) && killerAlly === ourAllyName);
      const isOurVictim = (kill.victim.guild_name?.toLowerCase() === ourGuildName) ||
        (Boolean(ourAllyName) && victimAlly === ourAllyName);

      const bucket = minuteMap.get(minute) ?? { ourKills: 0, ourDeaths: 0, enemyKills: 0, fame: 0 };
      if (isOurKiller) {
        bucket.ourKills += 1;
      } else {
        bucket.enemyKills += 1;
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
      const data = minuteMap.get(m) ?? { ourKills: 0, ourDeaths: 0, enemyKills: 0, fame: 0 };
      result.push({
        minute: m,
        label: `${m}m`,
        ourKills: data.ourKills,
        ourDeaths: data.ourDeaths,
        enemyKills: data.enemyKills,
        totalKills: data.ourKills + data.enemyKills,
        fame: data.fame,
      });
    }

    return result;
  });

  protected readonly maxTimelineKills = computed(() => {
    return Math.max(...this.timelineBuckets().map((b) => b.totalKills), 1);
  });

  // Top Guilds sorted by KD
  protected readonly topKdGuilds = computed<GuildEnrichedRow[]>(() => {
    return [...this.enrichedGuildRows()]
      .sort((a, b) => b.kdRatio - a.kdRatio)
      .slice(0, 8);
  });

  protected readonly maxGuildKd = computed(() => {
    return Math.max(...this.topKdGuilds().map((g) => (Number.isFinite(g.kdRatio) ? g.kdRatio : 0)), 1);
  });

  // Role distribution across all players
  protected readonly roleDistribution = computed<Array<{ role: CombatRole; count: number }>>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const counts: Record<CombatRole, number> = {
      tank: 0,
      healer: 0,
      support: 0,
      melee_dps: 0,
      ranged_dps: 0,
      other: 0,
    };

    for (const player of detail.players) {
      const role = this.inferPlayerRole(player.name, detail.kills);
      counts[role] = (counts[role] ?? 0) + 1;
    }

    return (Object.entries(counts) as Array<[CombatRole, number]>)
      .filter(([_, count]) => count > 0)
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count);
  });

  // Enriched Guild Rows
  protected readonly enrichedGuildRows = computed<GuildEnrichedRow[]>(() => {
    const detail = this.battle();
    if (!detail) return [];
    const ourGuildName = this.ourGuild()?.name.toLowerCase();
    const ourAllyName = this.ourGuildAllianceName();
    const allyMap = this.guildAllianceMap();

    return detail.guilds.map((g) => {
      const isOurGuild = g.name.toLowerCase() === ourGuildName;
      const alliance_name = g.alliance_name?.trim() || allyMap.get(g.name.toLowerCase()) || null;
      const isOurAlliance = Boolean(ourAllyName && alliance_name === ourAllyName);
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
    const ourAllyName = this.ourGuildAllianceName();
    const allyMap = this.guildAllianceMap();

    return detail.players.map((p) => {
      const isOurGuild = p.guild_name.toLowerCase() === ourGuildName;
      const alliance_name = p.alliance_name?.trim() || allyMap.get(p.guild_name.toLowerCase()) || null;
      const isOurAlliance = Boolean(ourAllyName && alliance_name === ourAllyName);
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

  protected readonly filteredGuildRosterRows = computed<PlayerEnrichedRow[]>(() => {
    const query = this.playerSearchQuery().trim().toLowerCase();
    const rows = this.ourGuildPlayers();
    if (!query) return rows;
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.weaponName.toLowerCase().includes(query) ||
        p.role.toLowerCase().includes(query),
    );
  });

  // Filtered All Players
  protected readonly filteredAllPlayerRows = computed<PlayerEnrichedRow[]>(() => {
    let rows = this.enrichedPlayerRows();
    const side = this.playerFilterSide();
    if (side === 'allies') {
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
      kills = kills.filter((k) => k.total_kill_fame >= 250000);
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

  protected readonly ourGuildNetFame = computed(() => {
    const players = this.ourGuildPlayers();
    return players.reduce((sum, p) => sum + p.netFame, 0);
  });

  protected readonly ourGuildEstimatedLoss = computed(() => {
    return this.battle()?.estimated_losses.total_estimated_loss ?? 0;
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

  // Table Columns
  protected readonly guildRosterColumns: readonly DataTableColumn<PlayerEnrichedRow>[] = [
    {
      key: 'player',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (p) => p.name,
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
      key: 'kills_deaths',
      label: 'battles.kills',
      sortable: true,
      accessor: (p) => p.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'center',
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

  protected readonly allGuildColumns: readonly DataTableColumn<GuildEnrichedRow>[] = [
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

  protected readonly allPlayerColumns: readonly DataTableColumn<PlayerEnrichedRow>[] = [
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
  ];

  protected readonly trackPlayerRow = (p: PlayerEnrichedRow): unknown => p.id || p.name;
  protected readonly trackGuildRow = (g: GuildEnrichedRow): unknown => g.id || g.name;

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected backToBattles(): void {
    void this.router.navigate(['/battles']);
  }

  protected switchTab(tab: string): void {
    this.tab.set(tab as DetailTab);
  }

  protected setKillFeedFilter(filter: KillFeedFilter): void {
    this.killFeedFilter.set(filter);
  }

  protected onKillSearch(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.killSearchQuery.set(input.value);
  }

  protected setPlayerFilterSide(side: PlayerSideFilter): void {
    this.playerFilterSide.set(side);
  }

  protected onPlayerSearch(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.playerSearchQuery.set(input.value);
  }

  protected toggleTimelineMinute(minute: number): void {
    this.selectedTimelineMinute.update((curr) => (curr === minute ? null : minute));
  }

  protected clearTimelineMinuteFilter(): void {
    this.selectedTimelineMinute.set(null);
  }

  protected toggleKillLoadout(eventId: number): void {
    this.expandedKill.update((curr) => (curr === eventId ? null : eventId));
  }

  protected async copyBattleLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      this.toasts.success(this.t('battles.link_copied'));
    } catch {
      this.toasts.error('Failed to copy link.');
    }
  }

  protected allianceDonutDashArray(): string {
    const share = this.ourAllianceFameShare();
    return `${share} ${100 - share}`;
  }

  // Formatters
  protected battleSubtitle(detail: BattleDetail): string {
    return [
      this.formatDate(detail.start_time),
      this.formatDuration(detail),
      `${detail.total_players} ${this.t('battles.players')}`,
      `${detail.guilds.length} ${this.t('battles.guilds')}`,
    ].join(' · ');
  }

  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  protected formatTime(isoDate: string): string {
    return new Date(isoDate).toLocaleTimeString();
  }

  protected formatTimeOffset(killIso: string, startIso: string): string {
    const offsetMs = Math.max(0, new Date(killIso).getTime() - new Date(startIso).getTime());
    const totalSec = Math.floor(offsetMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `+${m}:${s.toString().padStart(2, '0')}`;
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString();
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
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
        return 'Combatant';
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

  protected isOurGuildParticipant(participant: { guild_name?: string | null }): boolean {
    const ourG = this.ourGuild()?.name.toLowerCase();
    return Boolean(participant.guild_name && participant.guild_name.toLowerCase() === ourG);
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

  protected async load(): Promise<void> {
    const battleId = Number(this.route.snapshot.paramMap.get('battleId'));
    if (battleId <= 0) {
      this.toasts.error(this.t('common.error'));
      this.backToBattles();
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      this.battle.set(await firstValueFrom(this.api.get<BattleDetail>(`api/battles/${battleId}`)));
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
