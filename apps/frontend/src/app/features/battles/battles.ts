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
  FightListItem,
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
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { resolveBattleOutcome } from './battle-outcome';

const PAGE_SIZE = 10;
const BATTLE_REFRESH_INTERVAL_SECONDS = 5 * 60;

type BattleTab = 'guild' | 'me';
type BattleOutcomeType = 'victory' | 'defeat' | 'contested' | 'draw' | 'unknown';
type BattleListRow = BattleSummary | FightListItem;

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
 * The guild tab reads canonical Fight aggregates; the personal tab retains
 * the raw AlbionBB battle view for per-battle detail and grouping workflows.
 */
@Component({
  selector: 'app-battles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeader,
    PageStack,
    DataTable,
    DataTableCell,
    TooltipDirective,
    ViewToggle,
    Icon,
  ],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .outcome-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .outcome-pill--victory {
      background: var(--color-success-container);
      color: var(--color-success);
      border: 1px solid var(--color-success);
    }
    .outcome-pill--defeat {
      background: var(--color-error-container);
      color: var(--color-error);
      border: 1px solid var(--color-error);
    }
    .outcome-pill--contested {
      background: var(--color-warning-container);
      color: var(--color-warning);
      border: 1px solid var(--color-warning);
    }
    .outcome-pill--draw {
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      border: 1px solid var(--color-border-strong);
    }
    .battle-list__refresh-chip {
      font-variant-numeric: tabular-nums;
      font-family: var(--font-mono);
    }
  `,
  template: `
    <app-page-header [title]="t('battles.title')" [subtitle]="t('battles.subtitle')">
      <span
        class="chip battle-list__refresh-chip"
        [appTooltip]="t('battles.next_refresh')"
        tooltipPosition="bottom"
      >
        {{ t('battles.next_refresh') }} {{ refreshCountdown() }}
      </span>
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('battles.refresh_now')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('battles.refresh_now') }}
      </button>
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      @if (!loading() || battles().length > 0) {
        <section class="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-5" aria-label="Battle totals">
          <!-- Card 1: Visible Battles -->
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('battles.visible_battles') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-[var(--color-text)] mt-1">
                  {{ scopeStats().battles }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Loaded engagements
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-primary-container)] text-[var(--color-primary)] border border-[var(--color-primary)]">
                <app-icon name="shield" size="1.25rem" />
              </div>
            </div>
          </article>

          <!-- Card 2: Total Fame -->
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('battles.total_fame') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-warning mt-1">
                  {{ formatCompact(scopeStats().fame) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Kill fame generated
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
                <app-icon name="sparkles" size="1.25rem" />
              </div>
            </div>
          </article>

          <!-- Card 3: Total Kills -->
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('battles.kills') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-success mt-1">
                  {{ formatAmount(scopeStats().kills) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Enemies dispatched
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
                <app-icon name="swords" size="1.25rem" />
              </div>
            </div>
          </article>

          <!-- Card 4: Deaths / Segments -->
          @if (tab() === 'me') {
            <article class="kpi-card">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                    {{ t('battles.deaths') }}
                  </p>
                  <p class="font-mono text-2xl font-bold tracking-tight text-error mt-1">
                    {{ formatAmount(scopeStats().deaths) }}
                  </p>
                  <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                    Casualties suffered
                  </p>
                </div>
                <div class="icon-capsule bg-[var(--color-error-container)] text-error border border-[var(--color-error)]">
                  <app-icon name="alert" size="1.25rem" />
                </div>
              </div>
            </article>
          } @else {
            <article class="kpi-card">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                    Guild K/D
                  </p>
                  <p class="font-mono text-2xl font-bold tracking-tight text-[var(--color-text)] mt-1">
                    {{ scopeStats().deaths > 0 ? (scopeStats().kills / scopeStats().deaths).toFixed(2) : scopeStats().kills }}
                  </p>
                  <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                    Ratio in loaded battles
                  </p>
                </div>
                <div class="icon-capsule bg-[var(--color-primary-container)] text-[var(--color-primary)] border border-[var(--color-primary)]">
                  <app-icon name="coins" size="1.25rem" />
                </div>
              </div>
            </article>
          }

          <!-- Card 5: Total Players -->
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('battles.players') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-[var(--color-text)] mt-1">
                  {{ formatAmount(scopeStats().players) }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Total participants
                </p>
              </div>
              <div class="icon-capsule bg-[var(--color-info-container)] text-[var(--color-info)] border border-[var(--color-info)]">
                <app-icon name="users" size="1.25rem" />
              </div>
            </div>
          </article>
        </section>
      }

      @for (_ of [tab()]; track _) {
        <app-data-table
          [columns]="columns()"
          [rows]="tableRows()"
          [loading]="loading()"
          [error]="loadFailed()"
          [trackBy]="trackBattle"
          [pageSize]="PAGE_SIZE"
          [serverMode]="true"
          [totalItems]="totalItems()"
          emptyIcon="shield"
          [rowClickable]="true"
          (rowClick)="openRow($event)"
          (pageChange)="onTableChange($event)"
          (retry)="refreshNow()"
        >
          <ng-template dataTableCell="select" let-row>
            @if (isBattle(row)) {
              <input
                type="checkbox"
                class="checkbox"
                [checked]="isSelected(row.battle_id)"
                (click)="$event.stopPropagation()"
                (change)="toggleSelection(row.battle_id); $event.stopPropagation()"
                [attr.aria-label]="t('battles.select') + ' #' + row.battle_id"
              />
            }
          </ng-template>

          <ng-template dataTableCell="id" let-row>
            <span class="font-mono font-medium text-xs text-[var(--color-text)]">#{{ rowId(row) }}</span>
          </ng-template>

          <ng-template dataTableCell="time" let-row>
            <div class="flex items-center gap-1.5 text-xs text-[var(--color-text)]">
              <span>{{ formatDate(rowStartTime(row)) }}</span>
              <span class="text-[var(--color-text-tertiary)]">
                &middot; {{ formatDuration(row) }}
              </span>
            </div>
          </ng-template>

          <ng-template dataTableCell="outcome" let-row>
            @if (rowOutcome(row); as outcome) {
              @switch (outcome.type) {
                @case ('victory') {
                  <span class="outcome-pill outcome-pill--victory">
                    {{ outcome.label }}
                  </span>
                }
                @case ('defeat') {
                  <span class="outcome-pill outcome-pill--defeat">
                    {{ outcome.label }}
                  </span>
                }
                @case ('contested') {
                  <span class="outcome-pill outcome-pill--contested">
                    {{ outcome.label }}
                  </span>
                }
                @default {
                  <span class="outcome-pill outcome-pill--draw">
                    {{ outcome.label }}
                  </span>
                }
              }
            }
          </ng-template>

          <ng-template dataTableCell="fame" let-row>
            <span class="font-mono text-xs font-medium text-warning">{{ formatCompact(row.total_fame) }}</span>
          </ng-template>

          <ng-template dataTableCell="kills" let-row>
            <span class="font-mono text-xs font-semibold text-success">{{ formatAmount(row.total_kills) }}</span>
          </ng-template>

          <ng-template dataTableCell="deaths" let-row>
            @if (isBattle(row)) {
              <span class="font-mono text-xs text-error">{{ formatAmount(battleDeaths(row)) }}</span>
            }
          </ng-template>

          <ng-template dataTableCell="players" let-row>
            <span class="font-mono text-xs text-[var(--color-text-secondary)]">{{ formatAmount(row.total_players) }}</span>
          </ng-template>

          <ng-template dataTableCell="segments" let-row>
            @if (isFight(row)) {
              <span class="font-mono text-xs text-[var(--color-text-secondary)]">{{ formatAmount(row.segment_count) }}</span>
            }
          </ng-template>
        </app-data-table>
      }

      @if (tab() === 'me' && selectedBattleIds().length > 0) {
        <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl backdrop-blur">
          <span class="font-mono text-xs font-bold text-[var(--color-text)] bg-[var(--color-info-container)] text-[var(--color-info)] border border-[var(--color-info)] px-2 py-0.5 rounded-full">
            {{ selectedBattleIds().length }} {{ t('battles.selected') }}
          </span>
          <button
            type="button"
            class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
            (click)="openSelectedGroup()"
          >
            <app-icon name="swords" size="0.75rem" />
            {{ t('battles.group_selected') }}
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm text-xs"
            (click)="clearSelection()"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      }
    </app-page-stack>
  `,
})
export class Battles {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  /**
   * Bumped on every `load()` call so a stale response — from a tab switch,
   * sort/page change, or the auto-refresh timer racing a manual refresh —
   * can detect it's superseded and discard itself instead of overwriting the
   * table with a different tab's mismatched row shape.
   */
  private loadGeneration = 0;

  protected readonly PAGE_SIZE = PAGE_SIZE;
  protected readonly battles = signal<BattleListRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
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

  protected readonly columns = computed<readonly DataTableColumn<BattleListRow>[]>(() => {
    const shared: DataTableColumn<BattleListRow>[] = [
      {
        key: 'id',
        label: 'battles.id',
        sortable: true,
        searchable: true,
        accessor: (row) => this.rowId(row),
        comparator: (a, b) => this.rowId(a) - this.rowId(b),
      },
      {
        key: 'time',
        label: 'battles.time',
        sortable: true,
        accessor: (row) => this.rowStartTime(row),
        comparator: (a, b) => this.rowStartTime(a).localeCompare(this.rowStartTime(b)),
      },
      {
        key: 'outcome',
        label: 'battles.outcome',
        sortable: true,
        accessor: (row) => this.rowOutcome(row).type,
        comparator: (a, b) => this.rowOutcome(a).type.localeCompare(this.rowOutcome(b).type),
        filterOptions:
          this.tab() === 'guild'
            ? [
                { value: 'victory', label: this.t('battles.victory') },
                { value: 'defeat', label: this.t('battles.defeat') },
                { value: 'draw', label: this.t('battles.draw') },
                { value: 'unknown', label: this.t('battles.unknown') },
              ]
            : [
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
        key: 'players',
        label: 'battles.players',
        sortable: true,
        searchable: true,
        accessor: (row) => row.total_players,
        comparator: (a, b) => a.total_players - b.total_players,
        align: 'right',
      },
    ];

    if (this.tab() === 'guild') {
      return [
        ...shared,
        {
          key: 'segments',
          label: 'battles.segments',
          sortable: true,
          accessor: (row) => (this.isFight(row) ? row.segment_count : 0),
          comparator: (a, b) =>
            (this.isFight(a) ? a.segment_count : 0) - (this.isFight(b) ? b.segment_count : 0),
          align: 'right',
        },
      ];
    }

    return [
      { key: 'select', label: '' },
      ...shared.slice(0, 5),
      {
        key: 'deaths',
        label: 'battles.deaths',
        sortable: true,
        accessor: (row) => (this.isBattle(row) ? this.battleDeaths(row) : 0),
        comparator: (a, b) =>
          (this.isBattle(a) ? this.battleDeaths(a) : 0) -
          (this.isBattle(b) ? this.battleDeaths(b) : 0),
        align: 'right',
      },
      shared[5],
    ];
  });

  protected readonly tableRows = computed(() => this.battles());

  protected readonly trackBattle = (battle: BattleListRow): unknown => this.rowId(battle);

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

  protected openRow(row: BattleListRow): void {
    void this.router.navigate(
      this.isFight(row) ? ['/fights', row.id] : ['/battles', row.battle_id],
    );
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

  protected formatDuration(row: BattleListRow): string {
    const endedAt = this.isFight(row) ? row.ended_at : row.end_time;
    if (!endedAt) return this.t('battles.duration_unknown');
    const ms = new Date(endedAt).getTime() - new Date(this.rowStartTime(row)).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return this.t('battles.duration_unknown');
    return `${Math.max(1, Math.round(ms / 60000))}m`;
  }

  protected isBattle(row: BattleListRow): row is BattleSummary {
    return 'battle_id' in row;
  }

  protected isFight(row: BattleListRow): row is FightListItem {
    return !this.isBattle(row);
  }

  protected rowId(row: BattleListRow): number {
    return this.isFight(row) ? row.id : row.battle_id;
  }

  protected rowStartTime(row: BattleListRow): string {
    return this.isFight(row) ? row.started_at : row.start_time;
  }

  protected rowOutcome(row: BattleListRow): { label: string; type: BattleOutcomeType } {
    if (this.isBattle(row)) return this.battleOutcome(row);
    const labels: Record<FightListItem['outcome']['outcome'], TranslationKey> = {
      victory: 'battles.victory',
      defeat: 'battles.defeat',
      draw: 'battles.draw',
      unknown: 'battles.unknown',
    };
    return { label: this.t(labels[row.outcome.outcome]), type: row.outcome.outcome };
  }

  protected battleDeaths(battle: BattleSummary): number {
    return battle.guilds.reduce((sum, guild) => sum + guild.deaths, 0);
  }

  /** Shares `resolveBattleOutcome` with the battle detail page's own verdict badge. */
  protected battleOutcome(battle: BattleSummary): { label: string; type: BattleOutcomeType } {
    const ourG = battle.guilds.find((g) => g.name.toLowerCase() === 'weaklings');
    if (!ourG) {
      const top = this.winnerGuild(battle);
      return { label: top?.name ?? 'BATTLE', type: 'contested' };
    }
    const type = resolveBattleOutcome({
      guilds: battle.guilds,
      totalFame: battle.total_fame,
      ourGuildName: 'weaklings',
    });
    const labels: Record<'victory' | 'defeat' | 'contested', TranslationKey> = {
      victory: 'battles.victory',
      defeat: 'battles.defeat',
      contested: 'battles.contested',
    };
    return { label: this.t(labels[type]), type };
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
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const isGuildTab = this.tab() === 'guild';
      const path = isGuildTab ? 'api/fights' : 'api/battles/me';
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
      if (isGuildTab) {
        const response = await firstValueFrom(
          this.api.get<PaginatedData<FightListItem>>(path, params),
        );
        if (generation !== this.loadGeneration) return;
        this.battles.set(response.items);
        this.totalItems.set(response.total_items);
        this.scopeStats.set(this.buildGuildScopeStats(response.items));
      } else {
        const response = await firstValueFrom(
          this.api.get<PaginatedData<BattleSummary>>(path, params),
        );
        if (generation !== this.loadGeneration) return;
        this.battles.set(response.items);
        this.totalItems.set(response.total_items);
        const scopeStats = await this.buildPersonalScopeStats(response.items);
        if (generation !== this.loadGeneration) return;
        this.scopeStats.set(scopeStats);
      }
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      if (generation === this.loadGeneration) {
        this.loading.set(false);
      }
    }
  }

  private emptyScopeStats(): BattleScopeStats {
    return { battles: 0, players: 0, kills: 0, deaths: 0, fame: 0 };
  }

  private buildGuildScopeStats(fights: readonly FightListItem[]): BattleScopeStats {
    return fights.reduce<BattleScopeStats>(
      (stats, fight) => ({
        battles: stats.battles + 1,
        players: stats.players + fight.total_players,
        kills: stats.kills + fight.total_kills,
        deaths: stats.deaths,
        fame: stats.fame + fight.total_fame,
      }),
      this.emptyScopeStats(),
    );
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
