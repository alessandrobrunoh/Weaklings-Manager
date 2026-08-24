import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  BattleDetail,
  BattleGuildSummary,
  BattleSummary,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

const PAGE_SIZE = 10;
const PREVIEW_GUILD_LIMIT = 3;
const BATTLE_REFRESH_INTERVAL_SECONDS = 5 * 60;

type BattleTab = 'guild' | 'me';

function isBattleTab(value: string): value is BattleTab {
  return value === 'guild' || value === 'me';
}

interface BattleScopeStats {
  readonly battles: number;
  readonly players: number;
  readonly kills: number;
  readonly deaths: number;
  readonly fame: number;
}

/**
 * Battle list for recent guild and personal fights.
 *
 * Cards stay intentionally lightweight and navigate to a dedicated detail route
 * so large charts/tables can use normal page scrolling instead of a constrained
 * modal overlay.
 *
 * @example
 * ```html
 * <app-battles />
 * ```
 */
@Component({
  selector: 'app-battles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading, ViewToggle],
  template: `
    <app-page-header
      [title]="t('battles.title')"
      [subtitle]="t('battles.subtitle')"
      [actions]="false"
    />

    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <app-view-toggle [options]="tabOptions()" [active]="tab()" (activeChange)="switchTab($event)" />
      <div class="flex flex-wrap items-center gap-2">
        <span class="chip battle-list__refresh-chip">
          {{ t('battles.next_refresh') }} {{ refreshCountdown() }}
        </span>
        <button
          type="button"
          class="btn btn--outline"
          [disabled]="loading()"
          (click)="refreshNow()"
        >
          {{ t('battles.refresh_now') }}
        </button>
        @if (selectedBattleIds().length > 0) {
          <span class="chip">{{ selectedBattleIds().length }} selected</span>
          <button type="button" class="btn btn--primary" (click)="openSelectedGroup()">
            {{ t('battles.group_selected') }}
          </button>
          <button type="button" class="btn btn--ghost" (click)="clearSelection()">
            {{ t('common.cancel') }}
          </button>
        }
      </div>
    </div>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (battles().length === 0) {
      <app-empty-state [message]="t('common.empty')" icon="shield" />
    } @else {
      <section class="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Battle totals">
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.visible_battles') }}</p>
          <p class="battle-list__value">{{ scopeStats().battles }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.total_fame') }}</p>
          <p class="battle-list__value">{{ formatCompact(scopeStats().fame) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.players') }}</p>
          <p class="battle-list__value">{{ formatAmount(scopeStats().players) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.kills') }}</p>
          <p class="battle-list__value">{{ formatAmount(scopeStats().kills) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.deaths') }}</p>
          <p class="battle-list__value">{{ formatAmount(scopeStats().deaths) }}</p>
        </article>
      </section>

      <section
        class="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3"
        aria-label="Battle list"
      >
        @for (battle of battles(); track battle.battle_id) {
          <article
            class="card battle-list__card p-5"
            role="button"
            tabindex="0"
            (click)="openBattle(battle.battle_id)"
            (keydown.enter)="openBattle(battle.battle_id)"
          >
            <header class="mb-4 flex items-start justify-between gap-3">
              <div class="flex items-start gap-3">
                <input
                  type="checkbox"
                  class="mt-1"
                  [checked]="isSelected(battle.battle_id)"
                  (click)="$event.stopPropagation()"
                  (change)="toggleSelection(battle.battle_id)"
                  [attr.aria-label]="'Select battle ' + battle.battle_id"
                />
                <div>
                  <h3 class="text-lg font-semibold" style="color: var(--color-text)">
                    #{{ battle.battle_id }}
                  </h3>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ formatDate(battle.start_time) }} · {{ formatDuration(battle) }}
                  </p>
                </div>
              </div>
              @if (winnerGuild(battle); as winner) {
                <span class="chip chip--success">{{ winner.name }}</span>
              }
            </header>

            <dl class="mb-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <div class="battle-list__metric">
                <dt>{{ t('battles.players') }}</dt>
                <dd>{{ formatAmount(battle.total_players) }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.guilds') }}</dt>
                <dd>{{ battle.guilds.length }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.kills') }}</dt>
                <dd>{{ formatAmount(battle.total_kills) }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.fame') }}</dt>
                <dd>{{ formatCompact(battle.total_fame) }}</dd>
              </div>
            </dl>

            <div class="space-y-2">
              @for (guild of previewGuilds(battle.guilds); track guildKey(guild)) {
                <div class="battle-list__guild-row">
                  <span class="truncate font-medium">{{ guild.name || t('common.none') }}</span>
                  <span>{{ formatCompact(guild.kill_fame) }}</span>
                  <span>{{ guild.kills }}/{{ guild.deaths }}</span>
                </div>
              }
            </div>
          </article>
        }
      </section>

      <footer class="mt-4 flex items-center justify-between">
        <p class="text-xs" style="color: var(--color-text-secondary)">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }} ·
          {{ formatAmount(totalItems()) }} {{ t('battles.total_results') }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </footer>
    }
  `,
  styles: `
    @layer components {
      .battle-list__label {
        color: var(--color-text-disabled);
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .battle-list__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.75rem);
        font-weight: 700;
      }
      .battle-list__refresh-chip {
        font-variant-numeric: tabular-nums;
      }
      .battle-list__card {
        cursor: pointer;
        transition:
          border-color 120ms ease,
          transform 120ms ease;
      }
      .battle-list__card:hover {
        transform: translateY(-2px);
      }
      .battle-list__metric {
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: 0.75rem 0.5rem;
      }
      .battle-list__metric dt {
        color: var(--color-text-disabled);
        font-size: 0.68rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .battle-list__metric dd {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
      }
      .battle-list__guild-row {
        align-items: center;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-secondary);
        display: grid;
        font-size: 0.8rem;
        gap: 0.75rem;
        grid-template-columns: minmax(0, 1fr) auto auto;
        padding: 0.55rem 0.75rem;
      }
    }
  `,
})
export class Battles {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly battles = signal<BattleSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly tab = signal<BattleTab>('guild');

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'guild', label: this.t('battles.guild') },
    { id: 'me', label: this.t('battles.my') },
  ]);
  protected readonly page = signal(1);
  protected readonly totalItems = signal(0);
  protected readonly totalPages = signal(1);
  protected readonly selectedBattleIds = signal<number[]>([]);
  protected readonly scopeStats = signal<BattleScopeStats>(this.emptyScopeStats());
  protected readonly secondsUntilRefresh = signal(BATTLE_REFRESH_INTERVAL_SECONDS);
  protected readonly refreshCountdown = computed(() =>
    this.formatCountdown(this.secondsUntilRefresh()),
  );

  protected readonly totalVisibleFame = computed(() =>
    this.battles().reduce((totalFame, battle) => totalFame + battle.total_fame, 0),
  );
  protected readonly totalVisiblePlayers = computed(() =>
    this.battles().reduce((totalPlayers, battle) => totalPlayers + battle.total_players, 0),
  );
  protected readonly totalVisibleKills = computed(() =>
    this.battles().reduce((totalKills, battle) => totalKills + battle.total_kills, 0),
  );
  protected readonly averageVisiblePlayers = computed(() =>
    this.battles().length === 0 ? 0 : this.totalVisiblePlayers() / this.battles().length,
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    this.startRefreshTimer();
  }

  /** Navigates to the full-page battle detail where heavy tables can scroll normally. */
  protected openBattle(battleId: number): void {
    void this.router.navigate(['/battles', battleId]);
  }

  /** Forces an immediate reload while keeping the automatic cadence predictable. */
  protected refreshNow(): void {
    this.resetRefreshTimer();
    void this.load();
  }

  /** Opens an aggregated page for the currently selected battles. */
  protected openSelectedGroup(): void {
    const ids = this.selectedBattleIds();
    if (ids.length === 0) {
      return;
    }
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }

  /** Adds or removes a battle id from the ad-hoc aggregation selection. */
  protected toggleSelection(battleId: number): void {
    this.selectedBattleIds.update((ids) =>
      ids.includes(battleId) ? ids.filter((id) => id !== battleId) : [...ids, battleId],
    );
  }

  /** Checks whether a battle is part of the current group selection. */
  protected isSelected(battleId: number): boolean {
    return this.selectedBattleIds().includes(battleId);
  }

  /** Clears the ad-hoc group selection. */
  protected clearSelection(): void {
    this.selectedBattleIds.set([]);
  }

  /** Changes source list and resets pagination to avoid stale pages between tabs. */
  protected switchTab(tab: string): void {
    if (!isBattleTab(tab) || this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    this.page.set(1);
    void this.load();
  }

  /** Uses the browser locale so users see familiar date ordering. */
  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  /** Formats exact integer metrics with locale separators. */
  protected formatAmount(value: number): string {
    return value.toLocaleString();
  }

  /** Makes large fame values readable in card labels. */
  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  /** Avoids noisy decimal precision from averaged page metrics. */
  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  }

  /** Calculates duration from server timestamps with a safe fallback. */
  protected formatDuration(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): string {
    const milliseconds =
      new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return this.t('battles.duration_unknown');
    }
    return `${Math.max(1, Math.round(milliseconds / 60000))}m`;
  }

  /** Provides a stable track key when AlbionBB omits guild ids. */
  protected guildKey(guild: BattleGuildSummary): string {
    return guild.id || guild.name;
  }

  /** Finds the winning or highest-fame guild for list badges. */
  protected winnerGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.winner) ?? this.sortedGuilds(battle.guilds)[0] ?? null
    );
  }

  /** Sorts guilds by fame without mutating signal-owned arrays. */
  protected sortedGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return [...guilds].sort((leftGuild, rightGuild) => rightGuild.kill_fame - leftGuild.kill_fame);
  }

  /** Limits card previews to the most relevant guilds. */
  protected previewGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return this.sortedGuilds(guilds).slice(0, PREVIEW_GUILD_LIMIT);
  }

  /** Moves to the next backend page only when pagination allows it. */
  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((currentPage) => currentPage + 1);
    await this.load();
  }

  /** Moves to the previous backend page while preserving page-one bounds. */
  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((currentPage) => currentPage - 1);
    await this.load();
  }

  /** Keeps the UI aligned with the backend refresh cadence without leaking timers. */
  private startRefreshTimer(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const timerId = window.setInterval(() => {
      const nextSeconds = this.secondsUntilRefresh() - 1;
      if (nextSeconds > 0) {
        this.secondsUntilRefresh.set(nextSeconds);
        return;
      }

      this.resetRefreshTimer();
      void this.load();
    }, 1000);

    this.destroyRef.onDestroy(() => window.clearInterval(timerId));
  }

  /** Restarts the countdown after manual or automatic refreshes. */
  private resetRefreshTimer(): void {
    this.secondsUntilRefresh.set(BATTLE_REFRESH_INTERVAL_SECONDS);
  }

  /** Presents the cron-aligned timer in compact mm:ss form. */
  private formatCountdown(totalSeconds: number): string {
    const safeSeconds = Math.max(0, totalSeconds);
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /** Fetches the active tab and stores pagination metadata for the footer. */
  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const isGuildTab = this.tab() === 'guild';
      const path = isGuildTab ? 'api/battles' : 'api/battles/me';
      const params: Record<string, string | number> = { page: this.page() };
      if (isGuildTab) {
        params['min_players'] = 10;
      } else {
        params['limit'] = PAGE_SIZE;
      }
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BattleSummary>>(path, params),
      );
      this.battles.set(response.items);
      this.totalItems.set(response.total_items);
      this.totalPages.set(response.total_pages);
      this.scopeStats.set(
        isGuildTab
          ? this.buildGuildScopeStats(response.items)
          : await this.buildPersonalScopeStats(response.items),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Creates an empty aggregate so cards never render stale numbers after tab changes. */
  private emptyScopeStats(): BattleScopeStats {
    return { battles: 0, players: 0, kills: 0, deaths: 0, fame: 0 };
  }

  /** Aggregates only the configured guild row from every visible battle card. */
  private buildGuildScopeStats(battles: readonly BattleSummary[]): BattleScopeStats {
    return battles.reduce<BattleScopeStats>((stats, battle) => {
      const guild = this.guildStatsForBattle(battle);
      if (!guild) {
        return stats;
      }
      return {
        battles: stats.battles + 1,
        players: stats.players + guild.players,
        kills: stats.kills + guild.kills,
        deaths: stats.deaths + guild.deaths,
        fame: stats.fame + guild.kill_fame,
      };
    }, this.emptyScopeStats());
  }

  /** Hydrates visible personal battles and aggregates only the linked character row. */
  private async buildPersonalScopeStats(
    battles: readonly BattleSummary[],
  ): Promise<BattleScopeStats> {
    const link = await firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me'));
    const linkedName = link.albion_player_name?.toLowerCase();
    if (!link.linked || !linkedName) {
      return this.emptyScopeStats();
    }

    const details = await Promise.all(
      battles.map((battle) =>
        firstValueFrom(this.api.get<BattleDetail>(`api/battles/${battle.battle_id}`)),
      ),
    );

    return details.reduce<BattleScopeStats>((stats, detail) => {
      const player = detail.players.find(
        (candidate) => candidate.name.toLowerCase() === linkedName,
      );
      if (!player) {
        return stats;
      }
      return {
        battles: stats.battles + 1,
        players: stats.players + 1,
        kills: stats.kills + player.kills,
        deaths: stats.deaths + player.deaths,
        fame: stats.fame + player.kill_fame,
      };
    }, this.emptyScopeStats());
  }

  /** Finds Weaklings in a battle, falling back to the strongest guild only if upstream omits the name. */
  private guildStatsForBattle(battle: BattleSummary): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.name.toLowerCase() === 'weaklings') ??
      this.winnerGuild(battle)
    );
  }
}
