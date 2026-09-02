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
  FightSegmentSummary,
  MergeFightsRequest,
  MoveBattleRequest,
  SplitFightRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { resolveBattleOutcome } from '../battles/battle-outcome';
import { Avatar } from '../../shared/components/avatar/avatar';
import { Chart, type ChartTableRow } from '../../shared/components/chart/chart';
import { chartChrome, chartPalette } from '../../shared/components/chart/chart-theme';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

const DEFAULT_OUR_GUILD_NAME = 'weaklings';

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
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed() || !fight()) {
      <app-error-state
        message="Impossibile caricare i dati di questo scontro."
        retryLabel="Riprova"
        (retry)="load()"
      />
    } @else if (fight(); as detail) {
      <a class="btn btn--ghost btn--sm mb-4 inline-flex items-center gap-1.5 no-underline" routerLink="/battles">
        ← {{ t('nav.battles') }}
      </a>

      <app-page-header
        [title]="'Fight #' + detail.id"
        [subtitle]="fightWindow(detail)"
      >
        @if (canManageFights()) {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="mutating()"
            (click)="openMerge()"
          >
            <app-icon name="refresh" size="0.75rem" />
            Merge Fights
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="mutating() || detail.battle_ids.length < 2"
            (click)="openSplit()"
          >
            <app-icon name="close" size="0.75rem" />
            Split Segments
          </button>
        }

        <app-view-toggle
          pageTabs
          [options]="tabOptions()"
          [active]="tab()"
          (activeChange)="onTabChange($event)"
        />
      </app-page-header>

      <app-page-stack>
        <!-- ================= STATUS BADGES BAR ================= -->
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="chip font-semibold"
            [class.chip--success]="fightVerdict().type === 'victory'"
            [class.chip--error]="fightVerdict().type === 'defeat'"
            [class.chip--warning]="fightVerdict().type === 'contested'"
          >
            {{ fightVerdict().label }}
          </span>

          <span class="chip chip--neutral font-mono text-xs capitalize">
            Raggruppamento: {{ detail.grouping_method }} ({{ formatPercent(detail.grouping_confidence) }})
          </span>

          @if (detail.needs_review) {
            <span class="chip chip--warning font-bold text-xs">
              Needs Review
            </span>
          }

          @if (ourAllianceName(); as allyName) {
            <span class="chip chip--info font-mono text-xs font-medium">
              [{{ allyName }}] {{ ourGuild()?.name || ourGuildName() }}
            </span>
          } @else {
            <span class="chip chip--info font-mono text-xs font-medium">
              {{ ourGuild()?.name || ourGuildName() }}
            </span>
          }

          @if (detail.event_id) {
            <a
              class="chip chip--info no-underline text-xs"
              [routerLink]="['/events', detail.event_id]"
              title="Visualizza l'evento programmato collegato"
            >
              Evento collegato #{{ detail.event_id }}
            </a>
          } @else {
            <span class="chip text-xs text-[var(--color-text-tertiary)]">
              Nessun evento collegato
            </span>
          }
        </div>

        <!-- ================= 6 CORE KPI METRIC CARDS ================= -->
        <section
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
          aria-label="Core Fight KPIs"
        >
          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">{{ t('battles.total_fame') }}</p>
            <p class="battle-detail__value text-warning">{{ formatCompact(totalFame()) }}</p>
            <p class="battle-detail__sub">
              Quota gilda: <strong class="mono text-white">{{ formatDecimal(ourFameShare()) }}%</strong>
            </p>
          </article>

          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">{{ t('battles.kills') }} / {{ t('battles.deaths') }}</p>
            <p class="battle-detail__value">
              {{ formatAmount(totalKills()) }} / {{ formatAmount(totalDeaths()) }}
            </p>
            <p class="battle-detail__sub">
              K/D gilda:
              <strong
                class="mono"
                [class.text-emerald-400]="ourGuildKdRatio() >= 1"
                [class.text-rose-400]="ourGuildKdRatio() < 1"
              >
                {{ formatDecimal(ourGuildKdRatio()) }}
              </strong>
            </p>
          </article>

          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">{{ t('battles.kill_participation') }}</p>
            <p class="battle-detail__value">{{ formatDecimal(ourKillParticipation()) }}%</p>
            <p class="battle-detail__sub">
              <span class="mono">{{ ourGuild()?.kills ?? 0 }}</span> uccisioni nostre
            </p>
          </article>

          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">{{ t('battles.avg_ip') }}</p>
            <p class="battle-detail__value">{{ formatDecimal(ourGuildAvgIp()) }}</p>
            <p class="battle-detail__sub">
              IP medio generale: <span class="mono">{{ formatDecimal(fightAvgIp()) }}</span>
            </p>
          </article>

          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">{{ t('battles.silver_lost') }}</p>
            <p class="battle-detail__value text-rose-400">
              {{ formatCompact(totalEstimatedLoss()) }}
            </p>
            <p class="battle-detail__sub">
              {{ pricedItemsCount() }} / {{ totalItemsCount() }} oggetti prezzati
            </p>
          </article>

          <article class="surface p-3.5 sm:p-4 rounded-xl border border-[var(--color-border)]">
            <p class="battle-detail__label">Fighters & Segmenti</p>
            <p class="battle-detail__value text-white">
              {{ totalPlayersCount() }}
            </p>
            <p class="battle-detail__sub">
              <span class="mono">{{ detail.battle_ids.length }}</span> segmenti di battaglia
            </p>
          </article>
        </section>

        <!-- ================= TAB CONTENT ================= -->

        <!-- TAB 1: OVERVIEW & MATCHUP -->
        @if (tab() === 'overview') {
          <!-- Tactical Faction Head-to-Head Banner -->
          <section class="card p-5 overflow-hidden border border-[var(--color-border)]">
            <h2 class="text-xs uppercase font-bold tracking-wider text-[var(--color-text-secondary)] mb-4">
              CONFRONTO TATTICO FORZE IN CAMPO
            </h2>
            <div class="grid gap-5 lg:grid-cols-11 lg:items-center">
              <!-- OUR FORCES -->
              <div class="lg:col-span-5 rounded-xl p-4 border border-emerald-500/30 bg-emerald-500/5">
                <div class="flex items-center justify-between mb-2">
                  <span class="chip chip--success font-semibold text-xs">
                    {{ ourAllianceName() ? '[' + ourAllianceName() + '] ' + (ourGuild()?.name || ourGuildName()) : (ourGuild()?.name || ourGuildName()) }}
                  </span>
                  <span class="text-xs text-secondary mono">{{ ourForcesPlayers() }} fighters</span>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-3 text-center">
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">Kills / Deaths</p>
                    <p class="font-bold text-sm mono text-white">
                      {{ ourForcesKills() }} / {{ ourForcesDeaths() }}
                    </p>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">K/D Ratio</p>
                    <p class="font-bold text-sm mono" [class.text-emerald-400]="ourForcesKdRatio() >= 1" [class.text-rose-400]="ourForcesKdRatio() < 1">
                      {{ formatDecimal(ourForcesKdRatio()) }}
                    </p>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">Kill Fame</p>
                    <p class="font-bold text-sm mono text-warning">
                      {{ formatCompact(ourForcesKillFame()) }}
                    </p>
                  </div>
                </div>
              </div>

              <!-- VS DIVIDER -->
              <div class="lg:col-span-1 text-center flex flex-col items-center justify-center">
                <span class="font-black font-mono text-xs px-2.5 py-1 rounded-full bg-white/10 text-white border border-white/10">
                  VS
                </span>
              </div>

              <!-- ENEMY FORCES -->
              <div class="lg:col-span-5 rounded-xl p-4 border border-rose-500/30 bg-rose-500/5">
                <div class="flex items-center justify-between mb-2">
                  <span class="chip chip--error font-semibold text-xs">
                    {{ topEnemyAlliance()?.name ? '[' + topEnemyAlliance()?.name + '] ' + (topEnemyAlliance()?.guilds?.[0]?.name || 'Enemies') : 'Hostile Coalition' }}
                  </span>
                  <span class="text-xs text-secondary mono">{{ enemyForcesPlayers() }} fighters</span>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-3 text-center">
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">Kills / Deaths</p>
                    <p class="font-bold text-sm mono text-white">
                      {{ enemyForcesKills() }} / {{ enemyForcesDeaths() }}
                    </p>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">K/D Ratio</p>
                    <p class="font-bold text-sm mono" [class.text-emerald-400]="enemyForcesKdRatio() >= 1" [class.text-rose-400]="enemyForcesKdRatio() < 1">
                      {{ formatDecimal(enemyForcesKdRatio()) }}
                    </p>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <p class="text-[10px] uppercase font-bold text-disabled">Kill Fame</p>
                    <p class="font-bold text-sm mono text-warning">
                      {{ formatCompact(enemyForcesKillFame()) }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Squad MVPs & Combat Honors -->
          <section aria-label="Combat MVPs">
            <h2 class="text-xs uppercase font-bold tracking-wider text-[var(--color-text-secondary)] mb-3">
              COMBAT MVPs & TACTICAL HONORS
            </h2>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <!-- Top Executioner -->
              <article class="card p-4 border-l-4 border-l-amber-400">
                <p class="text-[10px] text-disabled uppercase font-bold tracking-wider">TOP EXECUTIONER</p>
                <div class="mt-2 flex items-center gap-3">
                  @if (mvpExecutioner(); as player) {
                    <app-avatar [username]="player.name" size="md" />
                    <div class="truncate min-w-0">
                      <p class="font-bold text-sm truncate text-white">{{ player.name }}</p>
                      <p class="text-xs text-warning font-bold mono">{{ player.kills }} Kills ({{ formatDecimal(player.kdRatio) }} K/D)</p>
                      <p class="text-[10px] text-secondary truncate">{{ player.guild_name }}</p>
                    </div>
                  } @else {
                    <p class="text-xs text-secondary">Nessun kill registrato</p>
                  }
                </div>
              </article>

              <!-- Fame Hunter -->
              <article class="card p-4 border-l-4 border-l-yellow-400">
                <p class="text-[10px] text-disabled uppercase font-bold tracking-wider">FAME HUNTER</p>
                <div class="mt-2 flex items-center gap-3">
                  @if (mvpFameHunter(); as player) {
                    <app-avatar [username]="player.name" size="md" />
                    <div class="truncate min-w-0">
                      <p class="font-bold text-sm truncate text-white">{{ player.name }}</p>
                      <p class="text-xs text-warning font-bold mono">{{ formatCompact(player.kill_fame) }} Fame</p>
                      <p class="text-[10px] text-secondary truncate">{{ player.guild_name }}</p>
                    </div>
                  } @else {
                    <p class="text-xs text-secondary">Nessuna fame registrata</p>
                  }
                </div>
              </article>

              <!-- Iron Vanguard (Highest IP) -->
              <article class="card p-4 border-l-4 border-l-sky-400">
                <p class="text-[10px] text-disabled uppercase font-bold tracking-wider">IRON VANGUARD</p>
                <div class="mt-2 flex items-center gap-3">
                  @if (mvpIronVanguard(); as player) {
                    <app-avatar [username]="player.name" size="md" />
                    <div class="truncate min-w-0">
                      <p class="font-bold text-sm truncate text-white">{{ player.name }}</p>
                      <p class="text-xs text-primary font-bold mono">{{ formatDecimal(player.item_power ?? 0) }} IP</p>
                      <p class="text-[10px] text-secondary truncate">{{ player.guild_name }}</p>
                    </div>
                  } @else {
                    <p class="text-xs text-secondary">—</p>
                  }
                </div>
              </article>

              <!-- Heaviest Casualty -->
              <article class="card p-4 border-l-4 border-l-rose-400">
                <p class="text-[10px] text-disabled uppercase font-bold tracking-wider">HEAVIEST CASUALTY</p>
                <div class="mt-2 flex items-center gap-3">
                  @if (mvpHeaviestLoss(); as player) {
                    <app-avatar [username]="player.name" size="md" />
                    <div class="truncate min-w-0">
                      <p class="font-bold text-sm truncate text-white">{{ player.name }}</p>
                      <p class="text-xs text-rose-400 font-bold mono">{{ formatCompact(player.estimatedLoss) }} Lost</p>
                      <p class="text-[10px] text-secondary truncate">{{ player.guild_name }}</p>
                    </div>
                  } @else {
                    <p class="text-xs text-secondary">0 perdite stimate</p>
                  }
                </div>
              </article>
            </div>
          </section>

          <!-- Charts Row -->
          <section class="grid gap-4 lg:grid-cols-3">
            <!-- Fame Distribution -->
            <article class="card p-4 border border-[var(--color-border)]">
              <h3 class="text-xs uppercase font-bold tracking-wider text-[var(--color-text-secondary)] mb-2">
                Distribuzione Kill Fame
              </h3>
              <app-chart
                [option]="fameDistributionOption()"
                height="15rem"
                label="Distribuzione Kill Fame per gilda"
                [tableHead]="fameDistributionTableHead()"
                [tableRows]="fameDistributionTableRows()"
              />
            </article>

            <!-- Top Guilds K/D Leaders -->
            <article class="card p-4 border border-[var(--color-border)]">
              <h3 class="text-xs uppercase font-bold tracking-wider text-[var(--color-text-secondary)] mb-2">
                Top Guild per K/D Ratio
              </h3>
              <app-chart
                [option]="topGuildsKdOption()"
                height="15rem"
                label="Top Guild per K/D Ratio"
                [tableHead]="topGuildsKdTableHead()"
                [tableRows]="topGuildsKdTableRows()"
              />
            </article>

            <!-- Segments Combat Activity -->
            <article class="card p-4 border border-[var(--color-border)]">
              <h3 class="text-xs uppercase font-bold tracking-wider text-[var(--color-text-secondary)] mb-2">
                Attività per Segmento
              </h3>
              @if ((fight()?.segments?.length ?? 0) > 0) {
                <app-chart
                  [option]="segmentsIntensityOption()"
                  height="15rem"
                  label="Attività per segmento di battaglia"
                  [tableHead]="segmentsIntensityTableHead()"
                  [tableRows]="segmentsIntensityTableRows()"
                />
              } @else {
                <div class="h-48 flex items-center justify-center text-xs text-secondary text-center p-4">
                  Dati dei segmenti non disponibili per il grafico.
                </div>
              }
            </article>
          </section>

          <!-- Attached Battle Segments Cards -->
          <section class="card p-4 border border-[var(--color-border)]">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div>
                <h3 class="font-bold text-sm text-white">Segmenti di Battaglia Collegati</h3>
                <p class="text-xs text-secondary">
                  Questo scontro canonico aggrega {{ detail.battle_ids.length }} segmenti di battaglia Albion Online.
                </p>
              </div>
              <button type="button" class="btn btn--outline btn--sm text-xs" (click)="tab.set('segments')">
                Visualizza tutti ({{ detail.battle_ids.length }}) →
              </button>
            </div>

            <div class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              @for (battleId of detail.battle_ids.slice(0, 8); track battleId; let idx = $index) {
                <a
                  [routerLink]="['/battles', battleId]"
                  class="surface p-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-all flex items-center justify-between no-underline group"
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <span class="h-6 w-6 rounded bg-white/5 border border-white/10 font-mono text-xs font-bold flex items-center justify-center text-secondary group-hover:text-white">
                      {{ idx + 1 }}
                    </span>
                    <div class="min-w-0">
                      <p class="text-xs font-bold text-white group-hover:text-[var(--color-primary)] truncate">
                        Battaglia #{{ battleId }}
                      </p>
                      <span class="text-[10px] text-secondary">Visualizza report →</span>
                    </div>
                  </div>
                  <app-icon name="chevron-right" size="0.75rem" class="text-secondary group-hover:text-white transition-colors" />
                </a>
              }
            </div>
          </section>
        }

        <!-- TAB 2: GUILDS & ALLIANCES -->
        @if (tab() === 'guilds') {
          <!-- Alliance Summary Cards -->
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            @for (alliance of alliances().slice(0, 6); track alliance.name) {
              <article class="card p-4 border border-[var(--color-border)]" [class.border-l-4]="alliance.isOurAlliance" [class.border-l-emerald-500]="alliance.isOurAlliance">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <span class="chip font-bold text-xs" [class.chip--success]="alliance.isOurAlliance" [class.chip--neutral]="!alliance.isOurAlliance">
                    {{ alliance.name }}
                  </span>
                  <span class="text-xs font-mono text-secondary">{{ alliance.players }} fighters</span>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-2 text-center text-xs">
                  <div class="surface p-2 rounded-lg">
                    <span class="text-[10px] text-disabled block">K/D</span>
                    <strong class="mono text-white">{{ formatDecimal(alliance.kdRatio) }}</strong>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <span class="text-[10px] text-disabled block">Fame</span>
                    <strong class="mono text-warning">{{ formatCompact(alliance.killFame) }}</strong>
                  </div>
                  <div class="surface p-2 rounded-lg">
                    <span class="text-[10px] text-disabled block">Loss</span>
                    <strong class="mono text-rose-400">{{ formatCompact(alliance.estimatedLoss) }}</strong>
                  </div>
                </div>
              </article>
            }
          </div>

          <!-- Guilds DataTable -->
          <section class="card p-4 space-y-3 border border-[var(--color-border)]">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 class="text-sm font-bold text-white">Gilde Partecipanti</h2>
                <p class="text-xs text-secondary">Riepilogo delle statistiche aggregate per ogni gilda</p>
              </div>
              <div class="w-full sm:w-64">
                <input
                  type="search"
                  class="input input--sm text-xs w-full"
                  placeholder="Cerca gilda o alleanza..."
                  [value]="guildSearchQuery()"
                  (input)="guildSearchQuery.set(inputValue($event))"
                />
              </div>
            </div>

            <app-data-table
              [columns]="allGuildColumns"
              [rows]="filteredGuildRows()"
              [trackBy]="trackGuildRow"
              [pageSize]="10"
              [hideSearch]="true"
            >
              <ng-template dataTableCell="name" let-row>
                <div class="flex items-center gap-2">
                  <span class="font-bold text-white text-xs">{{ row.name }}</span>
                  @if (row.alliance_name) {
                    <span class="chip chip--neutral text-[10px] py-0 px-1 font-mono">
                      [{{ row.alliance_name }}]
                    </span>
                  }
                  @if (row.isOurGuild) {
                    <span class="chip chip--success text-[9px] py-0 px-1 font-bold">La nostra gilda</span>
                  }
                </div>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="font-mono text-xs font-bold" [class.text-emerald-400]="row.kdRatio >= 1" [class.text-rose-400]="row.kdRatio < 1">
                  {{ formatDecimal(row.kdRatio) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="font-mono text-xs text-warning font-semibold">
                  {{ formatCompact(row.kill_fame) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="loss" let-row>
                <span class="font-mono text-xs text-rose-400">
                  {{ formatCompact(row.estimatedLoss) }}
                </span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- TAB 3: PLAYERS & COMBATANTS -->
        @if (tab() === 'players') {
          <section class="card p-4 space-y-4 border border-[var(--color-border)]">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <!-- Side Filters -->
              <div class="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <button
                  type="button"
                  class="px-3 py-1 text-xs rounded-md font-medium transition-all"
                  [class.bg-white/10]="playerSideFilter() === 'all'"
                  [class.text-white]="playerSideFilter() === 'all'"
                  [class.text-secondary]="playerSideFilter() !== 'all'"
                  (click)="playerSideFilter.set('all')"
                >
                  Tutti i giocatori ({{ enrichedPlayers().length }})
                </button>
                <button
                  type="button"
                  class="px-3 py-1 text-xs rounded-md font-medium transition-all"
                  [class.bg-white/10]="playerSideFilter() === 'allies'"
                  [class.text-white]="playerSideFilter() === 'allies'"
                  [class.text-secondary]="playerSideFilter() !== 'allies'"
                  (click)="playerSideFilter.set('allies')"
                >
                  Solo alleati ({{ allyPlayersCount() }})
                </button>
                <button
                  type="button"
                  class="px-3 py-1 text-xs rounded-md font-medium transition-all"
                  [class.bg-white/10]="playerSideFilter() === 'enemies'"
                  [class.text-white]="playerSideFilter() === 'enemies'"
                  [class.text-secondary]="playerSideFilter() !== 'enemies'"
                  (click)="playerSideFilter.set('enemies')"
                >
                  Solo nemici ({{ enemyPlayersCount() }})
                </button>
              </div>

              <!-- Search input -->
              <div class="w-full sm:w-64">
                <input
                  type="search"
                  class="input input--sm text-xs w-full"
                  placeholder="Cerca giocatore o gilda..."
                  [value]="playerSearchQuery()"
                  (input)="playerSearchQuery.set(inputValue($event))"
                />
              </div>
            </div>

            <app-data-table
              [columns]="allPlayerColumns"
              [rows]="filteredPlayerRows()"
              [trackBy]="trackPlayerRow"
              [pageSize]="15"
              [hideSearch]="true"
            >
              <ng-template dataTableCell="name" let-row>
                <div class="flex items-center gap-2.5 cursor-pointer" (click)="inspectedPlayer.set(row)">
                  <app-avatar [username]="row.name" size="xs" />
                  <div class="min-w-0">
                    <span class="font-bold text-white text-xs block truncate hover:text-[var(--color-primary)]" [class.text-[var(--color-primary)]]="row.isOurGuild">
                      {{ row.name }}
                    </span>
                    <span class="text-[10px] text-secondary truncate block">
                      {{ row.guild_name }} @if (row.alliance_name) { [{{ row.alliance_name }}] }
                    </span>
                  </div>
                </div>
              </ng-template>

              <ng-template dataTableCell="item_power" let-row>
                <span class="font-mono text-xs text-white">
                  {{ formatDecimal(row.item_power ?? 0) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="kill_death" let-row>
                <span class="font-mono text-xs font-bold" [class.text-emerald-400]="row.kdRatio >= 1" [class.text-rose-400]="row.kdRatio < 1">
                  {{ formatDecimal(row.kdRatio) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="kill_fame" let-row>
                <span class="font-mono text-xs text-warning font-semibold">
                  {{ formatCompact(row.kill_fame) }}
                </span>
              </ng-template>

              <ng-template dataTableCell="loss" let-row>
                <span class="font-mono text-xs text-rose-400">
                  {{ formatCompact(row.estimatedLoss) }}
                </span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- TAB 4: ROSTER & PLANNING EVIDENCE -->
        @if (tab() === 'roster') {
          <div class="space-y-4">
            <!-- Coverage Metrics -->
            @if (detail.participant_coverage; as coverage) {
              <section class="card p-5 border border-[var(--color-border)]">
                <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <h2 class="text-sm font-bold text-white">Evidenza Pianificazione Evento</h2>
                    <p class="text-xs text-secondary">
                      Confronto tra i membri pianificati nel roster dell'evento e i giocatori rilevati negli snapshot di combattimento.
                    </p>
                  </div>
                  @if (detail.planned_comp; as comp) {
                    <span class="chip chip--info text-xs font-semibold">
                      Composizione: {{ comp.name || ('#' + comp.id) }}
                    </span>
                  }
                </div>

                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div class="surface p-3 rounded-lg border border-[var(--color-border)]">
                    <p class="text-[10px] text-disabled uppercase font-bold">Membri Osservati</p>
                    <p class="text-base font-bold mono text-emerald-400 mt-1">
                      {{ coverage.observed_planned_participants }} / {{ coverage.matchable_planned_participants }}
                    </p>
                  </div>
                  <div class="surface p-3 rounded-lg border border-[var(--color-border)]">
                    <p class="text-[10px] text-disabled uppercase font-bold">Non Identificabili</p>
                    <p class="text-base font-bold mono text-secondary mt-1">
                      {{ coverage.unmatched_planned_participants }}
                    </p>
                  </div>
                  <div class="surface p-3 rounded-lg border border-[var(--color-border)]">
                    <p class="text-[10px] text-disabled uppercase font-bold">Non Pianificati Rilevati</p>
                    <p class="text-base font-bold mono text-warning mt-1">
                      {{ coverage.unplanned_observed_players }}
                    </p>
                  </div>
                  <div class="surface p-3 rounded-lg border border-[var(--color-border)]">
                    <p class="text-[10px] text-disabled uppercase font-bold">Copertura Snapshot</p>
                    <p class="text-base font-bold mono text-white mt-1">
                      {{ coverage.persisted_segments }} / {{ coverage.total_segments }} segmenti
                    </p>
                  </div>
                </div>
              </section>
            }

            <!-- Planned Participants Table -->
            @if (detail.planned_participants?.length) {
              <section class="card p-4 space-y-3 border border-[var(--color-border)]">
                <h3 class="font-bold text-sm text-white">Partecipanti Pianificati</h3>
                <div class="overflow-x-auto">
                  <table class="table w-full">
                    <thead>
                      <tr>
                        <th class="text-left text-xs">Membro</th>
                        <th class="text-left text-xs">Build Primaria</th>
                        <th class="text-left text-xs">Build Secondaria</th>
                        <th class="text-left text-xs">Stato Osservazione</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of detail.planned_participants; track p.user_id) {
                        <tr class="hover:bg-[var(--color-surface-hover)]">
                          <td class="text-xs font-semibold text-white py-2">{{ p.username }}</td>
                          <td class="text-xs text-secondary py-2">{{ p.primary_build_name || ('Build #' + p.primary_build_id) }}</td>
                          <td class="text-xs text-secondary py-2">{{ p.secondary_build_name || 'Nessuna' }}</td>
                          <td class="py-2">
                            <span class="chip text-[10px] font-bold" [class.chip--success]="p.observed" [class.chip--warning]="!p.observed">
                              {{ p.observed ? 'Rilevato in battaglia' : (p.albion_player_id ? 'Assente dallo snapshot' : 'Nessun personaggio collegato') }}
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }

            <!-- Observed Friendly Players -->
            @if (detail.observed_friendly_players?.length) {
              <section class="card p-4 space-y-3 border border-[var(--color-border)]">
                <h3 class="font-bold text-sm text-white">Giocatori Alleati Rilevati</h3>
                <div class="overflow-x-auto">
                  <table class="table w-full">
                    <thead>
                      <tr>
                        <th class="text-left text-xs">Giocatore</th>
                        <th class="text-left text-xs">Gilda</th>
                        <th class="text-right text-xs">Segmenti</th>
                        <th class="text-right text-xs">K / D</th>
                        <th class="text-right text-xs">Kill Fame</th>
                        <th class="text-right text-xs">Avg IP</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (pl of detail.observed_friendly_players; track pl.albion_player_id) {
                        <tr class="hover:bg-[var(--color-surface-hover)]">
                          <td class="text-xs font-semibold text-white py-2">{{ pl.name }}</td>
                          <td class="text-xs text-secondary py-2">{{ pl.guild_name }}</td>
                          <td class="text-xs font-mono text-right py-2">{{ pl.segments_observed }}</td>
                          <td class="text-xs font-mono text-right py-2">{{ pl.kills }} / {{ pl.deaths }}</td>
                          <td class="text-xs font-mono text-right text-warning py-2">{{ formatAmount(pl.kill_fame) }}</td>
                          <td class="text-xs font-mono text-right py-2">{{ formatDecimal(pl.average_item_power) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }
          </div>
        }

        <!-- TAB 5: BATTLE SEGMENTS & OFFICER ACTIONS -->
        @if (tab() === 'segments') {
          <div class="space-y-4">
            <!-- Segments List -->
            <section class="card p-0 overflow-hidden border border-[var(--color-border)]">
              <header class="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
                <div>
                  <h2 class="text-sm font-bold text-white">Segmenti di Battaglia Albion Online</h2>
                  <p class="text-xs text-secondary">Ogni segmento corrisponde a un record di battaglia sincronizzato da AlbionBB.</p>
                </div>
                <span class="chip font-mono text-xs font-bold">{{ detail.battle_ids.length }} segmenti</span>
              </header>

              <ol class="divide-y divide-[var(--color-border)]">
                @for (battleId of detail.battle_ids; track battleId; let idx = $index) {
                  <li class="p-3.5 hover:bg-[var(--color-surface-hover)] transition-all flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="h-7 w-7 rounded-lg bg-white/5 border border-white/10 font-mono text-xs font-bold flex items-center justify-center text-white">
                        {{ idx + 1 }}
                      </span>
                      <div>
                        <div class="flex items-center gap-2">
                          <a [routerLink]="['/battles', battleId]" class="text-sm font-bold text-white hover:text-[var(--color-primary)] no-underline">
                            Battaglia #{{ battleId }}
                          </a>
                          <a
                            class="text-[10px] text-secondary hover:underline no-underline"
                            [href]="'https://albionbattles.com/battles/' + battleId"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            AlbionBB ↗
                          </a>
                        </div>
                        <p class="text-[11px] text-secondary">
                          Segmento aggregato nello scontro canonico #{{ detail.id }}
                        </p>
                      </div>
                    </div>

                    <div class="flex items-center gap-2">
                      <a [routerLink]="['/battles', battleId]" class="btn btn--outline btn--sm text-xs no-underline">
                        Visualizza report →
                      </a>
                      @if (canManageFights()) {
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm text-xs"
                          [disabled]="mutating()"
                          (click)="openMove(battleId)"
                        >
                          Sposta
                        </button>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>

            <!-- Officer Controls Banner -->
            @if (canManageFights()) {
              <section class="card p-5 border border-[var(--color-border)] space-y-3">
                <div>
                  <h3 class="text-sm font-bold text-white">Gestione Raggruppamento (Ufficiali)</h3>
                  <p class="text-xs text-secondary">
                    Il raggruppamento manuale dei fight è permanente. Fights aggregati devono appartenere allo stesso evento o essere entrambi indipendenti.
                  </p>
                </div>

                @if (mutationError(); as error) {
                  <p class="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-lg border border-rose-500/20" role="alert">
                    {{ error }}
                  </p>
                }
                @if (mutationSuccess(); as message) {
                  <p class="text-xs text-emerald-400 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/20" aria-live="polite">
                    {{ message }}
                  </p>
                }

                <div class="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    class="btn btn--outline btn--sm"
                    [disabled]="mutating()"
                    (click)="openMerge()"
                  >
                    <app-icon name="refresh" size="0.75rem" />
                    Merge Fights
                  </button>
                  <button
                    type="button"
                    class="btn btn--outline btn--sm"
                    [disabled]="mutating() || detail.battle_ids.length < 2"
                    (click)="openSplit()"
                  >
                    <app-icon name="close" size="0.75rem" />
                    Split Segments
                  </button>
                </div>
              </section>
            }
          </div>
        }
      </app-page-stack>

      <!-- ================= DIALOGS ================= -->

      <!-- MERGE DIALOG -->
      @if (mergeOpen()) {
        <app-dialog
          title="Unisci Scontri (Merge Fights)"
          subtitle="Scegli il Fight ID che rimarrà attivo, e specifica uno o più altri Fight ID da unire in esso."
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-merge-form" class="space-y-3" (submit)="stageMerge($event)">
            <div>
              <label class="text-xs font-bold text-white block mb-1" for="fight-merge-target">
                ID scontro sopravvissuto (Target)
              </label>
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
              <label class="text-xs font-bold text-white block mb-1" for="fight-merge-others">
                Altri Fight ID da incorporare (separati da virgola)
              </label>
              <input
                id="fight-merge-others"
                class="input input--sm text-xs w-full"
                name="otherFightIds"
                inputmode="numeric"
                placeholder="es. 42, 57"
                [value]="mergeOtherIds()"
                (input)="mergeOtherIds.set(inputValue($event)); clearDialogError()"
                required
              />
              <p class="text-[11px] text-secondary mt-1">Lo scontro corrente (#{{ detail.id }}) verrà incluso automaticamente.</p>
            </div>

            @if (dialogError(); as error) {
              <p class="text-xs text-rose-400 bg-rose-500/10 p-2 rounded-lg" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              Annulla
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-merge-form">
              Revisiona Unione
            </button>
          </div>
        </app-dialog>
      }

      <!-- SPLIT DIALOG -->
      @if (splitOpen()) {
        <app-dialog
          title="Separa Segmenti (Split Segments)"
          subtitle="I segmenti selezionati formeranno un nuovo scontro canonico indipendente."
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-split-form" class="space-y-3" (submit)="stageSplit($event)">
            <p class="text-xs font-bold text-white mb-2">Seleziona i segmenti da estrarre:</p>
            <div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              @for (battleId of detail.battle_ids; track battleId) {
                <label class="flex items-center gap-2 text-xs text-white p-2 rounded surface hover:bg-[var(--color-surface-hover)] cursor-pointer">
                  <input
                    type="checkbox"
                    class="checkbox"
                    [checked]="isSplitSelected(battleId)"
                    (change)="toggleSplitBattle(battleId)"
                  />
                  <span class="mono font-semibold">Battaglia #{{ battleId }}</span>
                </label>
              }
            </div>

            @if (dialogError(); as error) {
              <p class="text-xs text-rose-400 bg-rose-500/10 p-2 rounded-lg" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              Annulla
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-merge-form">
              Revisiona Separazione
            </button>
          </div>
        </app-dialog>
      }

      <!-- MOVE DIALOG -->
      @if (moveBattleId(); as battleId) {
        <app-dialog
          title="Sposta Segmento di Battaglia"
          [subtitle]="'Sposta la battaglia #' + battleId + ' in un altro scontro compatibile.'"
          size="sm"
          (closed)="closeMutationDialog()"
        >
          <form id="fight-move-form" class="space-y-3" (submit)="stageMove(battleId, $event)">
            <div>
              <label class="text-xs font-bold text-white block mb-1" for="fight-move-target">
                Fight ID di destinazione
              </label>
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
              <p class="text-xs text-rose-400 bg-rose-500/10 p-2 rounded-lg" role="alert">{{ error }}</p>
            }
          </form>

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">
              Annulla
            </button>
            <button type="submit" class="btn btn--primary btn--sm" form="fight-move-form">
              Revisiona Spostamento
            </button>
          </div>
        </app-dialog>
      }

      <!-- CONFIRM MUTATION DIALOG -->
      @if (pendingMutation(); as pending) {
        <app-dialog title="Conferma Modifica Scontro" size="sm" (closed)="cancelPendingMutation()">
          <p class="text-sm text-white mb-2">{{ pending.description }}</p>
          <p class="text-xs text-secondary">Questa operazione modifica i raggruppamenti del database in modo permanente.</p>

          @if (dialogError(); as error) {
            <p class="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-lg mt-3" role="alert">{{ error }}</p>
          }

          <div dialogFooter>
            <button type="button" class="btn btn--ghost btn--sm" [disabled]="mutating()" (click)="cancelPendingMutation()">
              Annulla
            </button>
            <button type="button" class="btn btn--danger btn--sm" [disabled]="mutating()" (click)="confirmMutation()">
              {{ mutating() ? 'Applicazione in corso…' : 'Conferma Modifica' }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- PLAYER DETAIL INSPECT DIALOG -->
      @if (inspectedPlayer(); as p) {
        <app-dialog
          [title]="p.name"
          [subtitle]="p.guild_name + (p.alliance_name ? ' [' + p.alliance_name + ']' : '')"
          size="sm"
          (closed)="inspectedPlayer.set(null)"
        >
          <div class="space-y-3">
            <div class="flex items-center gap-3 p-3 rounded-xl surface border border-[var(--color-border)]">
              <app-avatar [username]="p.name" size="md" />
              <div>
                <p class="text-sm font-bold text-white">{{ p.name }}</p>
                <p class="text-xs text-secondary">{{ p.guild_name }}</p>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 text-xs">
              <div class="surface p-2.5 rounded-lg">
                <span class="text-[10px] text-disabled block">Kills / Deaths</span>
                <strong class="mono text-white text-sm">{{ p.kills }} / {{ p.deaths }}</strong>
              </div>
              <div class="surface p-2.5 rounded-lg">
                <span class="text-[10px] text-disabled block">K/D Ratio</span>
                <strong class="mono text-sm" [class.text-emerald-400]="p.kdRatio >= 1" [class.text-rose-400]="p.kdRatio < 1">
                  {{ formatDecimal(p.kdRatio) }}
                </strong>
              </div>
              <div class="surface p-2.5 rounded-lg">
                <span class="text-[10px] text-disabled block">Kill Fame</span>
                <strong class="mono text-warning text-sm">{{ formatCompact(p.kill_fame) }}</strong>
              </div>
              <div class="surface p-2.5 rounded-lg">
                <span class="text-[10px] text-disabled block">Item Power</span>
                <strong class="mono text-white text-sm">{{ formatDecimal(p.item_power ?? 0) }}</strong>
              </div>
              <div class="surface p-2.5 rounded-lg col-span-2">
                <span class="text-[10px] text-disabled block">Perdite d'equipaggiamento stimate</span>
                <strong class="mono text-rose-400 text-sm">{{ formatCompact(p.estimatedLoss) }} Silver</strong>
              </div>
            </div>
          </div>

          <div dialogFooter>
            <button type="button" class="btn btn--outline btn--sm" (click)="inspectedPlayer.set(null)">
              Chiudi
            </button>
          </div>
        </app-dialog>
      }
    }
  `,
  styles: `
    @layer components {
      .battle-detail__label {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .battle-detail__value {
        color: var(--color-text);
        font-family: var(--font-geistmono, monospace);
        font-size: clamp(1.25rem, 2vw, 1.5rem);
        font-weight: 600;
        letter-spacing: -0.02em;
        margin-top: 0.25rem;
      }
      .battle-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .eyebrow {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        font-size: 0.6875rem;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .mono {
        font-family: var(--font-geistmono, monospace);
      }
      .numeric {
        font-family: var(--font-geistmono, monospace);
        text-align: right;
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

  // Player inspect modal
  protected readonly inspectedPlayer = signal<FightPlayerRow | null>(null);

  // Search and Filter Signals
  protected readonly playerSideFilter = signal<'all' | 'allies' | 'enemies'>('all');
  protected readonly playerSearchQuery = signal('');
  protected readonly guildSearchQuery = signal('');

  protected readonly ourGuildName = computed(() => {
    const profile = this.auth.profile();
    if (profile && 'guild_name' in profile && typeof profile.guild_name === 'string' && profile.guild_name.trim()) {
      return profile.guild_name.trim();
    }
    return DEFAULT_OUR_GUILD_NAME;
  });

  protected readonly ourGuild = computed<BattleGuildSummary | null>(() => {
    const fight = this.fight();
    if (!fight?.guilds) return null;
    const target = this.ourGuildName().toLowerCase();
    return fight.guilds.find((g) => g.name.toLowerCase() === target) ?? null;
  });

  protected readonly ourAllianceName = computed<string | null>(() => {
    return this.ourGuild()?.alliance_name?.trim() || null;
  });

  protected readonly enrichedGuilds = computed<FightGuildRow[]>(() => {
    const fight = this.fight();
    if (!fight || !fight.guilds) return [];
    const ourName = this.ourGuildName().toLowerCase();
    const ourAlly = this.ourAllianceName()?.toLowerCase() ?? null;
    const lossesMap = new Map(
      fight.estimated_losses?.guilds?.map((l) => [l.guild_name.toLowerCase(), l.estimated_loss]) ?? [],
    );

    return fight.guilds.map((g) => {
      const isOurGuild = g.name.toLowerCase() === ourName;
      const isOurAlliance = Boolean(ourAlly && g.alliance_name?.toLowerCase() === ourAlly) || isOurGuild;
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
    const ourAlly = this.ourAllianceName()?.toLowerCase() ?? null;
    const lossesMap = new Map(
      fight.estimated_losses?.players?.map((l) => [l.player_name.toLowerCase(), l.estimated_loss]) ?? [],
    );

    return fight.players.map((p) => {
      const isOurGuild = (p.guild_name ?? '').toLowerCase() === ourName;
      const isOurAlliance = Boolean(ourAlly && (p.alliance_name ?? '').toLowerCase() === ourAlly) || isOurGuild;
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

  protected readonly fightVerdict = computed<{ label: string; type: 'victory' | 'defeat' | 'contested' }>(() => {
    const fight = this.fight();
    if (!fight) return { label: 'Contested', type: 'contested' };

    if (fight.outcome?.outcome) {
      switch (fight.outcome.outcome) {
        case 'victory':
          return { label: this.t('battles.victory'), type: 'victory' };
        case 'defeat':
          return { label: this.t('battles.defeat'), type: 'defeat' };
        case 'draw':
        case 'unknown':
        default:
          break;
      }
    }

    if (fight.guilds && fight.guilds.length > 0) {
      const outcome = resolveBattleOutcome({
        guilds: fight.guilds,
        totalFame: this.totalFame(),
        ourGuildName: this.ourGuildName(),
      });
      return {
        label: this.t(`battles.${outcome}` as TranslationKey),
        type: outcome,
      };
    }

    const kd = fight.kill_death_ratio ?? fight.stats?.kill_death_ratio ?? 1;
    if (kd >= 1.2) return { label: this.t('battles.victory'), type: 'victory' };
    if (kd <= 0.8) return { label: this.t('battles.defeat'), type: 'defeat' };
    return { label: this.t('battles.contested'), type: 'contested' };
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

  // Tab options
  protected readonly tabOptions = computed<readonly ViewToggleOption[]>(() => {
    const fight = this.fight();
    const options: ViewToggleOption[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'guilds', label: `Gilde (${fight?.guilds?.length ?? 0})` },
      { id: 'players', label: `Giocatori (${fight?.players?.length ?? 0})` },
    ];
    if (this.hasRosterEvidence()) {
      options.push({ id: 'roster', label: 'Roster & Evento' });
    }
    options.push({ id: 'segments', label: `Segmenti (${fight?.battle_ids?.length ?? 0})` });
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
          name: 'Kill Fame',
          type: 'pie',
          radius: ['42%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: false,
          itemStyle: { borderRadius: 4, borderColor: '#0f1011', borderWidth: 2 },
          label: { show: false },
          data: guilds.map((g) => ({
            value: g.kill_fame,
            name: g.name,
          })),
        },
      ],
    };
  });

  protected readonly fameDistributionTableHead = computed(() => ['Gilda', 'Kill Fame']);
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
          name: 'Kills',
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

  protected readonly topGuildsKdTableHead = computed(() => ['Gilda', 'K/D Ratio', 'Kills', 'Deaths']);
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
          name: 'Kills',
          type: 'bar',
          data: segments.map((s) => s.total_kills),
          itemStyle: { color: palette.ally, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 20,
        },
        {
          name: 'Giocatori',
          type: 'bar',
          data: segments.map((s) => s.total_players),
          itemStyle: { color: chrome.axis, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 20,
        },
      ],
    };
  });

  protected readonly segmentsIntensityTableHead = computed(() => ['Segmento', 'Kills', 'Giocatori']);
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
      this.loadFailed.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      this.fight.set(await firstValueFrom(this.api.get<FightDetail>(`api/fights/${fightId}`)));
    } catch {
      this.fight.set(null);
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
      this.dialogError.set('Inserisci un target Fight ID valido e un elenco di Fight ID separati da virgola.');
      return;
    }
    const fightIds = [...new Set([currentId, targetId, ...otherIds])];
    if (fightIds.length < 2) {
      this.dialogError.set('Seleziona almeno due diversi scontri da unire.');
      return;
    }
    this.mergeOpen.set(false);
    this.pendingMutation.set({
      kind: 'merge',
      body: { target_fight_id: targetId, fight_ids: fightIds },
      description: `Unione di ${fightIds.map((id) => `scontro #${id}`).join(', ')}. Lo scontro #${targetId} rimarrà attivo.`,
    });
  }

  protected stageSplit(event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const selected = this.splitBattleIds();
    const total = this.fight()?.battle_ids.length ?? 0;
    if (!sourceId || selected.length === 0 || selected.length >= total) {
      this.dialogError.set('Seleziona almeno un segmento, ma lasciane almeno uno nello scontro attuale.');
      return;
    }
    this.splitOpen.set(false);
    this.pendingMutation.set({
      kind: 'split',
      body: { battle_ids: selected },
      description: `Separa ${selected.map((id) => `battaglia #${id}`).join(', ')} in un nuovo scontro.`,
    });
  }

  protected stageMove(battleId: number, event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const targetId = this.parsePositiveId(this.moveTargetId());
    if (!sourceId || !targetId || targetId === sourceId) {
      this.dialogError.set('Inserisci un Fight ID di destinazione valido e diverso.');
      return;
    }
    this.moveBattleId.set(null);
    this.pendingMutation.set({
      kind: 'move',
      battleId,
      body: { battle_id: battleId, target_fight_id: targetId },
      description: `Sposta la battaglia #${battleId} dallo scontro #${sourceId} allo scontro #${targetId}.`,
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
      this.mutationSuccess.set(`Raggruppamento aggiornato con successo. Fight risultante: #${result.fight_id}.`);
      if (result.fight_id === sourceId) {
        await this.load();
      } else {
        await this.router.navigate(['/fights', result.fight_id]);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Impossibile aggiornare il raggruppamento.';
      this.dialogError.set(message);
      this.mutationError.set(message);
    } finally {
      this.mutating.set(false);
    }
  }

  // Format Helpers
  protected fightWindow(fight: FightDetail): string {
    return `${this.formatDate(fight.started_at)}${fight.ended_at ? ` al ${this.formatDate(fight.ended_at)}` : ''}`;
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

  protected formatPercent(value: number | undefined): string {
    const v = value ?? 0;
    return `${(v <= 1 ? v * 100 : v).toFixed(0)}%`;
  }

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
