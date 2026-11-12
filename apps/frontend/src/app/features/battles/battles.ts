import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  PLATFORM_ID,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, Router, RouterLink, type Params } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  BattleDetail,
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
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { battleOutcomeLabel, type BattleOutcomeType } from './battle-outcome';
import { winRatePercent } from './battle-metrics';
import {
  buildGuildScopeStats,
  emptyScopeStats,
  type BattleScopeStats,
} from './battle-scope-stats';

const PAGE_SIZE = 10;
const BATTLE_REFRESH_INTERVAL_SECONDS = 5 * 60;
const SEARCH_DEBOUNCE_MS = 300;
const OUTCOME_PARAM = 'outcome';
const TAB_PARAM = 'tab';
const OUTCOMES: readonly BattleOutcomeType[] = ['victory', 'defeat', 'draw', 'unknown'];

type BattleTab = 'guild' | 'me';
type BattleListRow = BattleSummary | FightListItem;

function isBattleTab(value: string): value is BattleTab {
  return value === 'guild' || value === 'me';
}

function isOutcome(value: string): value is BattleOutcomeType {
  return (OUTCOMES as readonly string[]).includes(value);
}

/**
 * Battle list for recent guild and personal fights.
 *
 * The page reads its state from the URL: the tab (`tab`), the search (`search`), the outcome
 * (`outcome`) and the table's page, size and sort. The data table writes the last three, the
 * filter bar and tabs write the rest, and every change reloads the list.
 *
 * The guild tab reads canonical Fight aggregates; the personal tab retains
 * the raw AlbionBB battle view for per-battle detail and grouping workflows.
 */
@Component({
  selector: 'app-battles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    FilterBar,
    Icon,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    .battles-scope {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .battles-scope__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .battle-date {
      white-space: nowrap;
    }
    .battle-duration {
      display: block;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
    }
    .battles-selection {
      position: fixed;
      inset-inline: var(--page-gap);
      bottom: max(1rem, env(safe-area-inset-bottom));
      z-index: 50;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    @media (min-width: 40rem) {
      .battles-scope {
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
      }
      .battles-selection {
        inset-inline: auto;
        left: 50%;
        transform: translateX(-50%);
        justify-content: center;
      }
    }
  `,
  template: `
    <app-page-header [title]="t('battles.title')" [subtitle]="t('battles.subtitle')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="refreshNow()">
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('battles.refresh_now') }}
      </button>
      <app-tabs
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      @if (!loading() || battles().length > 0) {
        <app-summary-band [ariaLabel]="t('battles.summaryLabel')" [items]="summaryItems()" />
      }

      <div class="battles-scope">
        <div class="min-w-0">
          <h2 class="section-title">
            {{ t(tab() === 'guild' ? 'battles.scope.guildTitle' : 'battles.scope.personalTitle') }}
          </h2>
          <p class="hint" aria-live="polite">
            {{ t(tab() === 'guild' ? 'battles.scope.guildDescription' : 'battles.scope.personalDescription') }}
          </p>
          @if (tab() === 'me') {
            <p class="hint">{{ t('battles.scope.selectHint') }}</p>
          }
        </div>
        <div class="battles-scope__meta">
          @if (tab() === 'guild') {
            <a routerLink="/fights/trends" class="btn btn--ghost btn--sm">
              <app-icon name="chart" size="0.875rem" />
              {{ t('battles.scope.reviewTrends') }}
            </a>
          }
          <span class="hint num">{{ t('battles.next_refresh') }} {{ refreshCountdown() }}</span>
        </div>
      </div>

      <app-filter-bar
        [searchLabel]="t('battles.search')"
        [searchPlaceholder]="t('battles.search')"
        [query]="search()"
        [activeCount]="activeFilterCount()"
        (queryChange)="onSearch($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('battles.outcome') }}</span>
          <select class="select select--sm" [value]="outcome()" (change)="onOutcome($event)">
            <option value="">{{ t('common.all') }}</option>
            @for (option of outcomeOptions(); track option.value) {
              <option [value]="option.value">{{ option.label }}</option>
            }
          </select>
        </label>
      </app-filter-bar>

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
          [hideSearch]="true"
          [ariaLabel]="t('battles.title')"
          emptyIcon="shield"
          [rowClickable]="true"
          (rowClick)="openRow($event)"
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

          <ng-template dataTableCell="time" let-row>
            <span class="battle-date">{{ formatDate(rowStartTime(row)) }}</span>
            <span class="battle-duration">{{ formatDuration(row) }}</span>
          </ng-template>

          <ng-template dataTableCell="outcome" let-row>
            @if (rowOutcome(row); as outcome) {
              <app-status-chip
                [value]="outcome.type"
                [label]="outcome.label"
                [toneOverride]="outcomeTone(outcome.type)"
              />
            }
          </ng-template>

          <ng-template dataTableCell="kills" let-row>
            <span class="num">{{ formatAmount(row.total_kills) }}</span>
          </ng-template>

          <ng-template dataTableCell="deaths" let-row>
            @if (isBattle(row)) {
              <span class="num">{{ formatAmount(battleDeaths(row)) }}</span>
            }
          </ng-template>

          <ng-template dataTableCell="fame" let-row>
            <span class="num">{{ formatCompact(row.total_fame) }}</span>
          </ng-template>

          <ng-template dataTableCell="players" let-row>
            <span class="num">{{ formatAmount(row.total_players) }}</span>
          </ng-template>

          <ng-template dataTableCell="segments" let-row>
            @if (isFight(row)) {
              <span class="num">{{ formatAmount(row.segment_count) }}</span>
            }
          </ng-template>
        </app-data-table>
      }

      @if (tab() === 'me' && selectedBattleIds().length > 0) {
        <div class="card battles-selection">
          <span class="num text-sm font-medium">
            {{ selectedBattleIds().length }} {{ t('battles.selected') }}
          </span>
          <div class="flex items-center gap-2">
            <button type="button" class="btn btn--primary btn--sm inline-flex items-center gap-1.5" (click)="openSelectedGroup()">
              <app-icon name="swords" size="0.75rem" />
              {{ t('battles.group_selected') }}
            </button>
            <button type="button" class="btn btn--ghost btn--sm" (click)="clearSelection()">
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>
      }
    </app-page-stack>
  `,
})
export class Battles {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly route = inject(ActivatedRoute);
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
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly PAGE_SIZE = PAGE_SIZE;
  protected readonly battles = signal<BattleListRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly totalItems = signal(0);
  protected readonly selectedBattleIds = signal<number[]>([]);
  protected readonly scopeStats = signal<BattleScopeStats>(this.emptyScopeStats());
  protected readonly secondsUntilRefresh = signal(BATTLE_REFRESH_INTERVAL_SECONDS);
  protected readonly refreshCountdown = computed(() =>
    this.formatCountdown(this.secondsUntilRefresh()),
  );

  /** Query params, the single source of the list state. */
  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  /** Page, size, search and sort. The data table writes these keys to the URL. */
  protected readonly query = computed(() =>
    parseDataTableQuery(this.params(), { defaultPageSize: PAGE_SIZE }),
  );
  protected readonly tab = computed<BattleTab>(() => {
    const raw = this.params().get(TAB_PARAM) ?? 'guild';
    return isBattleTab(raw) ? raw : 'guild';
  });
  protected readonly search = computed(() => this.query().search);
  protected readonly outcome = computed<BattleOutcomeType | ''>(() => {
    const raw = this.params().get(OUTCOME_PARAM) ?? '';
    return isOutcome(raw) ? raw : '';
  });
  protected readonly activeFilterCount = computed(
    () => (this.search().trim() ? 1 : 0) + (this.outcome() ? 1 : 0),
  );

  protected readonly tabOptions = computed<TabOption[]>(() => [
    { id: 'guild', label: this.t('battles.guild') },
    { id: 'me', label: this.t('battles.my') },
  ]);
  protected readonly outcomeOptions = computed(() =>
    OUTCOMES.map((value) => ({ value, label: this.t(battleOutcomeLabel(value)) })),
  );

  /** Any change to what the server is asked for reloads the list. */
  private readonly requestKey = computed(() => {
    const query = this.query();
    return JSON.stringify([
      this.tab(),
      query.page,
      query.pageSize,
      query.search,
      query.sort,
      this.outcome(),
    ]);
  });

  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => {
    const stats = this.scopeStats();
    const onPage = this.t('battles.scope.onPage');
    const items: SummaryItem[] = [
      { label: this.t('battles.visible_battles'), value: stats.battles, hint: onPage },
      { label: this.t('battles.total_fame'), value: this.formatCompact(stats.fame), hint: onPage },
      { label: this.t('battles.kills'), value: this.formatAmount(stats.kills), hint: onPage },
    ];
    if (this.tab() === 'me') {
      items.push(
        { label: this.t('battles.deaths'), value: this.formatAmount(stats.deaths), hint: onPage },
        { label: this.t('battles.players'), value: this.formatAmount(stats.players), hint: onPage },
      );
      return items;
    }
    if (stats.deaths > 0) {
      items.push({
        label: this.t('battles.kill_death'),
        value: (stats.kills / stats.deaths).toFixed(2),
        hint: onPage,
      });
    } else {
      items.push({
        label: this.t('events.detail.win_rate'),
        value: this.winRateLabel(),
        hint: this.t('battles.scope.winRateSub', { wins: stats.victories, losses: stats.defeats }),
      });
    }
    items.push({
      label: this.t('battles.scope.largestFight'),
      value: this.formatAmount(stats.peakPlayers),
      hint: this.t('battles.participants'),
    });
    return items;
  });

  /**
   * Server mode: the API sorts and searches, so the columns carry no accessor or comparator. An
   * accessor would make the table filter the server's page again on the client, which hides
   * matches the server found on a field the table does not show (a player name, for one).
   */
  protected readonly columns = computed<readonly DataTableColumn<BattleListRow>[]>(() => {
    const isPersonal = this.tab() === 'me';
    const columns: DataTableColumn<BattleListRow>[] = [];
    if (isPersonal) {
      columns.push({ key: 'select', label: '' });
    }
    columns.push(
      {
        key: 'time',
        label: 'common.date',
        sortable: true,
      },
      {
        key: 'outcome',
        label: 'battles.outcome',
        sortable: true,
      },
      {
        key: 'kills',
        label: 'battles.kills',
        sortable: true,
        align: 'right',
      },
    );
    if (isPersonal) {
      columns.push({
        key: 'deaths',
        label: 'battles.deaths',
        sortable: true,
        align: 'right',
      });
    }
    columns.push(
      { key: 'fame', label: 'battles.fame', sortable: true, align: 'right' },
      { key: 'players', label: 'battles.participants', sortable: true, align: 'right' },
    );
    if (!isPersonal) {
      columns.push({ key: 'segments', label: 'battles.segments', sortable: true, align: 'right' });
    }
    return columns;
  });

  protected readonly tableRows = computed(() => this.battles());

  protected readonly trackBattle = (battle: BattleListRow): unknown => this.rowId(battle);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    effect(() => {
      this.requestKey();
      untracked(() => void this.load());
    });
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
    this.startRefreshTimer();
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
    // Clearing sort, search and outcome with the tab keeps the new scope's list at its first page.
    this.updateQuery({ [TAB_PARAM]: tab, page: '1', search: '', sort: '', [OUTCOME_PARAM]: null });
  }

  protected onSearch(value: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      // An empty string, not null: the data table keeps its last search when the key is absent.
      this.updateQuery({ search: value.trim(), page: '1' });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onOutcome(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.updateQuery({ [OUTCOME_PARAM]: isOutcome(value) ? value : null, page: '1' });
  }

  protected clearFilters(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.updateQuery({ search: '', [OUTCOME_PARAM]: null, page: '1' });
  }

  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString(this.translate.locale());
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString(this.translate.locale());
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(this.translate.locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(
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
    const type = this.isBattle(row) ? (row.outcome ?? 'unknown') : row.outcome.outcome;
    return { label: this.t(battleOutcomeLabel(type)), type };
  }

  /** Victory and defeat carry colour; a draw or an unknown result is neutral, never a loss. */
  protected outcomeTone(outcome: BattleOutcomeType): 'success' | 'error' | 'neutral' {
    switch (outcome) {
      case 'victory':
        return 'success';
      case 'defeat':
        return 'error';
      default:
        return 'neutral';
    }
  }

  protected battleDeaths(battle: BattleSummary): number {
    return battle.guilds.reduce((sum, guild) => sum + guild.deaths, 0);
  }

  /** wins / (wins + losses) of the loaded fights; "—" when none was decided. */
  protected winRateLabel(): string {
    const stats = this.scopeStats();
    const rate = winRatePercent(stats.victories, stats.defeats);
    return rate === null ? '—' : `${Math.round(rate)}%`;
  }

  private updateQuery(changes: Params): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: changes,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
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
      const query = this.query();
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
        params['sort'] = query.sort.columnKey === 'time' ? 'start_time' : query.sort.columnKey;
        params['order'] = query.sort.direction;
      }
      const outcome = this.outcome();
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
        this.scopeStats.set(buildGuildScopeStats(response.items));
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
    return emptyScopeStats();
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
        ...stats,
        battles: stats.battles + 1,
        players: stats.players + 1,
        kills: stats.kills + player.kills,
        deaths: stats.deaths + player.deaths,
        fame: stats.fame + player.kill_fame,
      };
    }, this.emptyScopeStats());
  }
}
