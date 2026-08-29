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
const PREVIEW_GUILD_LIMIT = 4;
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
 * Cards provide high-level combat indicators with alliance tags and direct
 * navigation to the full-page war room analytics view.
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
          class="btn btn--outline btn--sm"
          [disabled]="loading()"
          (click)="refreshNow()"
        >
          {{ t('battles.refresh_now') }}
        </button>
        @if (selectedBattleIds().length > 0) {
          <span class="chip font-mono">{{ selectedBattleIds().length }} selected</span>
          <button type="button" class="btn btn--primary btn--sm" (click)="openSelectedGroup()">
            {{ t('battles.group_selected') }}
          </button>
          <button type="button" class="btn btn--ghost btn--sm" (click)="clearSelection()">
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
      <!-- Scope Aggregates -->
      <section class="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Battle totals">
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.visible_battles') }}</p>
          <p class="battle-list__value mono">{{ scopeStats().battles }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.total_fame') }}</p>
          <p class="battle-list__value mono text-warning">{{ formatCompact(scopeStats().fame) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.players') }}</p>
          <p class="battle-list__value mono">{{ formatAmount(scopeStats().players) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.kills') }}</p>
          <p class="battle-list__value mono text-success">{{ formatAmount(scopeStats().kills) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-list__label">{{ t('battles.deaths') }}</p>
          <p class="battle-list__value mono text-error">{{ formatAmount(scopeStats().deaths) }}</p>
        </article>
      </section>

      <!-- Search Toolbar -->
      <div class="mb-4 flex items-center justify-between gap-3">
        <div class="w-full sm:w-80">
          <input
            type="text"
            class="input input--sm"
            placeholder="Filter by guild, alliance or battle ID..."
            [value]="filterQuery()"
            (input)="onFilterQueryChange($event)"
          />
        </div>
        <span class="text-xs text-secondary mono">
          {{ filteredBattles().length }} of {{ battles().length }} fights shown
        </span>
      </div>

      <!-- Battles Grid -->
      <section
        class="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
        aria-label="Battle list"
      >
        @for (battle of filteredBattles(); track battle.battle_id) {
          <article
            class="card battle-list__card p-5"
            [class.battle-list__card--selected]="isSelected(battle.battle_id)"
            role="button"
            tabindex="0"
            (click)="openBattle(battle.battle_id)"
            (keydown.enter)="openBattle(battle.battle_id)"
          >
            <header class="mb-4 flex items-start justify-between gap-3">
              <div class="flex items-start gap-3">
                <input
                  type="checkbox"
                  class="mt-1 checkbox"
                  [checked]="isSelected(battle.battle_id)"
                  (click)="$event.stopPropagation()"
                  (change)="toggleSelection(battle.battle_id)"
                  [attr.aria-label]="'Select battle ' + battle.battle_id"
                />
                <div>
                  <div class="flex items-center gap-2">
                    <h2 class="text-lg font-bold tracking-tight" style="color: var(--color-text)">
                      #{{ battle.battle_id }}
                    </h2>
                    @if (battleOutcome(battle); as outcome) {
                      <span
                        class="chip text-xs py-0 font-semibold"
                        [class.chip--success]="outcome.type === 'victory'"
                        [class.chip--error]="outcome.type === 'defeat'"
                        [class.chip--warning]="outcome.type === 'contested'"
                      >
                        {{ outcome.label }}
                      </span>
                    }
                  </div>
                  <p class="text-xs text-secondary mt-0.5">
                    {{ formatDate(battle.start_time) }} · {{ formatDuration(battle) }}
                  </p>
                </div>
              </div>

              @if (winnerGuild(battle); as winner) {
                <span class="chip chip--success text-xs py-0.5 font-medium shrink-0">
                  {{ winner.name }}
                </span>
              }
            </header>

            <!-- Metrics Grid -->
            <dl class="mb-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <div class="battle-list__metric">
                <dt>{{ t('battles.players') }}</dt>
                <dd class="mono">{{ formatAmount(battle.total_players) }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.guilds') }}</dt>
                <dd class="mono">{{ battle.guilds.length }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.kills') }}</dt>
                <dd class="mono">{{ formatAmount(battle.total_kills) }}</dd>
              </div>
              <div class="battle-list__metric">
                <dt>{{ t('battles.total_fame') }}</dt>
                <dd class="mono text-warning">{{ formatCompact(battle.total_fame) }}</dd>
              </div>
            </dl>

            <!-- Top Guild Rows -->
            <div class="space-y-1.5">
              @for (guild of previewGuilds(battle.guilds); track guildKey(guild)) {
                <div
                  class="battle-list__guild-row"
                  [class.battle-list__guild-row--our]="isOurGuild(guild)"
                >
                  <div class="truncate flex items-center gap-1.5">
                    <span class="truncate font-medium" [class.text-primary]="isOurGuild(guild)">
                      {{ guild.name || t('common.none') }}
                    </span>
                    @if (guild.alliance_name) {
                      <span class="chip text-xs py-0 px-1 font-mono text-disabled">
                        [{{ guild.alliance_name }}]
                      </span>
                    }
                  </div>
                  <span class="mono text-warning">{{ formatCompact(guild.kill_fame) }}</span>
                  <span class="mono text-xs font-semibold">
                    <span class="text-success">{{ guild.kills }}</span>/<span class="text-error">{{ guild.deaths }}</span>
                  </span>
                </div>
              }
            </div>
          </article>
        }
      </section>

      <!-- Pagination Footer -->
      <footer class="mt-5 flex items-center justify-between border-t pt-4" style="border-color: var(--color-border)">
        <p class="text-xs text-secondary">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }} ·
          {{ formatAmount(totalItems()) }} {{ t('battles.total_results') }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline btn--sm" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm"
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
        font-size: 0.72rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .battle-list__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.65rem);
        font-weight: 700;
      }
      .battle-list__refresh-chip {
        font-variant-numeric: tabular-nums;
        font-family: var(--font-mono);
      }
      .battle-list__card {
        cursor: pointer;
        transition:
          border-color 120ms ease,
          transform 120ms ease;
      }
      .battle-list__card:hover {
        transform: translateY(-2px);
        border-color: var(--color-border-strong);
      }
      .battle-list__card--selected {
        outline: 2px solid var(--color-primary);
      }
      .battle-list__metric {
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: 0.65rem 0.5rem;
      }
      .battle-list__metric dt {
        color: var(--color-text-disabled);
        font-size: 0.68rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .battle-list__metric dd {
        color: var(--color-text);
        font-size: 0.95rem;
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
        padding: 0.45rem 0.65rem;
      }
      .battle-list__guild-row--our {
        background: color-mix(in srgb, var(--color-primary-container) 35%, var(--color-surface));
        border-color: color-mix(in srgb, var(--color-primary) 30%, var(--color-border));
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
  protected readonly filterQuery = signal<string>('');

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

  protected readonly filteredBattles = computed(() => {
    const list = this.battles();
    const query = this.filterQuery().trim().toLowerCase();
    if (!query) return list;
    return list.filter((b) => {
      const idMatch = String(b.battle_id).includes(query);
      const guildMatch = b.guilds.some(
        (g) =>
          g.name.toLowerCase().includes(query) ||
          (g.alliance_name && g.alliance_name.toLowerCase().includes(query)),
      );
      return idMatch || guildMatch;
    });
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    this.startRefreshTimer();
  }

  protected onFilterQueryChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filterQuery.set(input.value);
  }

  protected openBattle(battleId: number): void {
    void this.router.navigate(['/battles', battleId]);
  }

  protected refreshNow(): void {
    this.resetRefreshTimer();
    void this.load();
  }

  protected openSelectedGroup(): void {
    const ids = this.selectedBattleIds();
    if (ids.length === 0) return;
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }

  protected toggleSelection(battleId: number): void {
    this.selectedBattleIds.update((ids) =>
      ids.includes(battleId) ? ids.filter((id) => id !== battleId) : [...ids, battleId],
    );
  }

  protected isSelected(battleId: number): boolean {
    return this.selectedBattleIds().includes(battleId);
  }

  protected clearSelection(): void {
    this.selectedBattleIds.set([]);
  }

  protected switchTab(tab: string): void {
    if (!isBattleTab(tab) || this.tab() === tab) return;
    this.tab.set(tab);
    this.page.set(1);
    void this.load();
  }

  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString();
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDuration(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): string {
    const ms = new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return this.t('battles.duration_unknown');
    return `${Math.max(1, Math.round(ms / 60000))}m`;
  }

  protected guildKey(guild: BattleGuildSummary): string {
    return guild.id || guild.name;
  }

  protected isOurGuild(guild: BattleGuildSummary): boolean {
    return guild.name.toLowerCase() === 'weaklings';
  }

  protected winnerGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.winner) ?? this.sortedGuilds(battle.guilds)[0] ?? null
    );
  }

  protected battleOutcome(battle: BattleSummary): { label: string; type: 'victory' | 'defeat' | 'contested' } {
    const ourG = battle.guilds.find((g) => g.name.toLowerCase() === 'weaklings');
    if (!ourG) {
      const top = this.winnerGuild(battle);
      return { label: top?.name ?? 'BATTLE', type: 'contested' };
    }
    if (ourG.winner || (ourG.kills > ourG.deaths && ourG.kill_fame >= battle.total_fame * 0.35)) {
      return { label: this.t('battles.victory'), type: 'victory' };
    }
    if (ourG.deaths > ourG.kills && ourG.kill_fame < battle.total_fame * 0.25) {
      return { label: this.t('battles.defeat'), type: 'defeat' };
    }
    return { label: this.t('battles.contested'), type: 'contested' };
  }

  protected sortedGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return [...guilds].sort((left, right) => right.kill_fame - left.kill_fame);
  }

  protected previewGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return this.sortedGuilds(guilds).slice(0, PREVIEW_GUILD_LIMIT);
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) return;
    this.page.update((c) => c + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) return;
    this.page.update((c) => c - 1);
    await this.load();
  }

  private startRefreshTimer(): void {
    if (!isPlatformBrowser(this.platformId)) return;

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

  private resetRefreshTimer(): void {
    this.secondsUntilRefresh.set(BATTLE_REFRESH_INTERVAL_SECONDS);
  }

  private formatCountdown(totalSeconds: number): string {
    const safeSeconds = Math.max(0, totalSeconds);
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

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

  private emptyScopeStats(): BattleScopeStats {
    return { battles: 0, players: 0, kills: 0, deaths: 0, fame: 0 };
  }

  private buildGuildScopeStats(battles: readonly BattleSummary[]): BattleScopeStats {
    return battles.reduce<BattleScopeStats>((stats, battle) => {
      const guild = this.guildStatsForBattle(battle);
      if (!guild) return stats;
      return {
        battles: stats.battles + 1,
        players: stats.players + guild.players,
        kills: stats.kills + guild.kills,
        deaths: stats.deaths + guild.deaths,
        fame: stats.fame + guild.kill_fame,
      };
    }, this.emptyScopeStats());
  }

  private async buildPersonalScopeStats(
    battles: readonly BattleSummary[],
  ): Promise<BattleScopeStats> {
    const link = await firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me'));
    const linkedName = link.albion_player_name?.toLowerCase();
    if (!link.linked || !linkedName) return this.emptyScopeStats();

    const details = await Promise.all(
      battles.map((battle) =>
        firstValueFrom(this.api.get<BattleDetail>(`api/battles/${battle.battle_id}`)),
      ),
    );

    return details.reduce<BattleScopeStats>((stats, detail) => {
      const player = detail.players.find(
        (candidate) => candidate.name.toLowerCase() === linkedName,
      );
      if (!player) return stats;
      return {
        battles: stats.battles + 1,
        players: stats.players + 1,
        kills: stats.kills + player.kills,
        deaths: stats.deaths + player.deaths,
        fame: stats.fame + player.kill_fame,
      };
    }, this.emptyScopeStats());
  }

  private guildStatsForBattle(battle: BattleSummary): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.name.toLowerCase() === 'weaklings') ??
      this.winnerGuild(battle)
    );
  }
}
