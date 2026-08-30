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
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

const PAGE_SIZE = 10;
const BATTLE_REFRESH_INTERVAL_SECONDS = 5 * 60;

type BattleTab = 'guild' | 'me';
type BattleOutcomeType = 'victory' | 'defeat' | 'contested';

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
 * Guild pages are hydrated from several AlbionBB pages, then filtered/sorted
 * by our API so table search and sort cover more than the visible page.
 */
@Component({
  selector: 'app-battles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, PageStack, DataTable, DataTableCell, StatCard, ViewToggle],
  template: `
    <app-page-header [title]="t('battles.title')" [subtitle]="t('battles.subtitle')">
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
        <span class="chip font-mono">
          {{ selectedBattleIds().length }} {{ t('battles.selected') }}
        </span>
        <button type="button" class="btn btn--primary btn--sm" (click)="openSelectedGroup()">
          {{ t('battles.group_selected') }}
        </button>
        <button type="button" class="btn btn--ghost btn--sm" (click)="clearSelection()">
          {{ t('common.cancel') }}
        </button>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      @if (!loading() || battles().length > 0) {
        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Battle totals">
          <app-stat-card
            [label]="t('battles.visible_battles')"
            [value]="scopeStats().battles.toString()"
            icon="shield"
          />
          <app-stat-card
            [label]="t('battles.total_fame')"
            [value]="formatCompact(scopeStats().fame)"
            icon="sparkles"
            tone="warning"
          />
          <app-stat-card
            [label]="t('battles.players')"
            [value]="formatAmount(scopeStats().players)"
            icon="users"
          />
          <app-stat-card
            [label]="t('battles.kills')"
            [value]="formatAmount(scopeStats().kills)"
            icon="swords"
            tone="success"
          />
          <app-stat-card
            [label]="t('battles.deaths')"
            [value]="formatAmount(scopeStats().deaths)"
            icon="alert"
            tone="danger"
          />
        </section>
      }

      @for (_ of [tab()]; track _) {
        <app-data-table
          [columns]="columns()"
          [rows]="tableRows()"
          [loading]="loading()"
          [trackBy]="trackBattle"
          [pageSize]="PAGE_SIZE"
          [serverMode]="true"
          [totalItems]="totalItems()"
          emptyIcon="shield"
          [rowClickable]="true"
          (rowClick)="openBattle($event.battle_id)"
          (pageChange)="onTableChange($event)"
        >
          <ng-template dataTableCell="select" let-row>
            <input
              type="checkbox"
              class="checkbox"
              [checked]="isSelected(row.battle_id)"
              (click)="$event.stopPropagation()"
              (change)="toggleSelection(row.battle_id); $event.stopPropagation()"
              [attr.aria-label]="t('battles.select') + ' #' + row.battle_id"
            />
          </ng-template>
          <ng-template dataTableCell="id" let-row>
            <span class="mono font-medium">#{{ row.battle_id }}</span>
          </ng-template>
          <ng-template dataTableCell="time" let-row>
            <span class="text-sm">{{ formatDate(row.start_time) }}</span>
            <span class="ml-1 text-xs" style="color: var(--color-text-secondary)">
              · {{ formatDuration(row) }}
            </span>
          </ng-template>
          <ng-template dataTableCell="outcome" let-row>
            @if (battleOutcome(row); as outcome) {
              <span
                class="chip text-xs py-0 font-semibold"
                [class.chip--success]="outcome.type === 'victory'"
                [class.chip--error]="outcome.type === 'defeat'"
                [class.chip--warning]="outcome.type === 'contested'"
              >
                {{ outcome.label }}
              </span>
            }
          </ng-template>
          <ng-template dataTableCell="fame" let-row>
            <span class="mono text-warning">{{ formatCompact(row.total_fame) }}</span>
          </ng-template>
          <ng-template dataTableCell="kills" let-row>
            <span class="mono">{{ formatAmount(row.total_kills) }}</span>
          </ng-template>
          <ng-template dataTableCell="deaths" let-row>
            <span class="mono">{{ formatAmount(battleDeaths(row)) }}</span>
          </ng-template>
          <ng-template dataTableCell="players" let-row>
            <span class="mono">{{ formatAmount(row.total_players) }}</span>
          </ng-template>
        </app-data-table>
      }
    </app-page-stack>
  `,
  styles: `
    @layer components {
      .battle-list__refresh-chip {
        font-variant-numeric: tabular-nums;
        font-family: var(--font-mono);
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

  protected readonly PAGE_SIZE = PAGE_SIZE;
  protected readonly battles = signal<BattleSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly tab = signal<BattleTab>('guild');
  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'guild', label: this.t('battles.guild') },
    { id: 'me', label: this.t('battles.my') },
  ]);
  protected readonly page = signal(1);
  protected readonly totalItems = signal(0);
  protected readonly selectedBattleIds = signal<number[]>([]);
  protected readonly scopeStats = signal<BattleScopeStats>(this.emptyScopeStats());
  protected readonly secondsUntilRefresh = signal(BATTLE_REFRESH_INTERVAL_SECONDS);
  protected readonly refreshCountdown = computed(() =>
    this.formatCountdown(this.secondsUntilRefresh()),
  );

  private readonly tableQuery = signal<DataTablePageChange>({
    page: 1,
    pageSize: PAGE_SIZE,
    search: '',
    sort: null,
    columnFilters: {},
  });

  protected readonly columns = computed<readonly DataTableColumn<BattleSummary>[]>(() => [
    { key: 'select', label: '' },
    {
      key: 'id',
      label: 'battles.id',
      sortable: true,
      searchable: true,
      accessor: (row) => row.battle_id,
      comparator: (a, b) => a.battle_id - b.battle_id,
    },
    {
      key: 'time',
      label: 'battles.time',
      sortable: true,
      accessor: (row) => row.start_time,
      comparator: (a, b) => a.start_time.localeCompare(b.start_time),
    },
    {
      key: 'outcome',
      label: 'battles.outcome',
      sortable: true,
      accessor: (row) => this.battleOutcome(row).type,
      comparator: (a, b) =>
        this.battleOutcome(a).type.localeCompare(this.battleOutcome(b).type),
      filterOptions: [
        { value: 'victory', label: this.t('battles.victory') },
        { value: 'defeat', label: this.t('battles.defeat') },
        { value: 'contested', label: this.t('battles.contested') },
      ],
    },
    {
      key: 'fame',
      label: 'battles.fame',
      sortable: true,
      accessor: (row) => row.total_fame,
      comparator: (a, b) => a.total_fame - b.total_fame,
      align: 'right',
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (row) => row.total_kills,
      comparator: (a, b) => a.total_kills - b.total_kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (row) => this.battleDeaths(row),
      comparator: (a, b) => this.battleDeaths(a) - this.battleDeaths(b),
      align: 'right',
    },
    {
      key: 'players',
      label: 'battles.players',
      sortable: true,
      searchable: true,
      accessor: (row) => row.total_players,
      comparator: (a, b) => a.total_players - b.total_players,
      align: 'right',
    },
  ]);

  protected readonly tableRows = computed(() => this.battles());

  protected readonly trackBattle = (battle: BattleSummary): unknown => battle.battle_id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    this.startRefreshTimer();
  }

  protected onTableChange(event: DataTablePageChange): void {
    this.tableQuery.set(event);
    this.page.set(event.page);
    void this.load();
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
    this.tableQuery.set({
      page: 1,
      pageSize: PAGE_SIZE,
      search: '',
      sort: null,
      columnFilters: {},
    });
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

  protected battleDeaths(battle: BattleSummary): number {
    return battle.guilds.reduce((sum, guild) => sum + guild.deaths, 0);
  }

  protected battleOutcome(battle: BattleSummary): { label: string; type: BattleOutcomeType } {
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

  private winnerGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.winner) ??
      [...battle.guilds].sort((left, right) => right.kill_fame - left.kill_fame)[0] ??
      null
    );
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
      const query = this.tableQuery();
      const params: Record<string, string | number> = {
        page: query.page,
        limit: query.pageSize,
      };
      if (isGuildTab) {
        params['min_players'] = 10;
      }
      if (query.search.trim()) {
        params['search'] = query.search.trim();
      }
      if (query.sort) {
        params['sort'] = query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const outcome = query.columnFilters['outcome'];
      if (outcome) {
        params['outcome'] = outcome;
      }
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BattleSummary>>(path, params),
      );
      this.battles.set(response.items);
      this.totalItems.set(response.total_items);
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
