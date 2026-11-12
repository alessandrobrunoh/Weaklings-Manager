import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  LeaderboardEntry as BoardEntry,
  PaginatedData,
  ProgressionLeaderboardEntry,
  ProgressionMeView,
  ProgressionSeasonView,
  ReportLeaderboards,
  ReportOperations,
  ReportOverview,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import {
  DataTable,
  type DataTableColumn,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import type { TranslationKey } from '../../i18n/en';

/** Identifier matching every supported Intel leaderboard. */
type IntelLeaderboardKey =
  | 'payout'
  | 'deaths'
  | 'kills'
  | 'attendance'
  | 'killfame'
  | 'deathfame'
  | 'siphoned';

type LeaderboardKey = IntelLeaderboardKey | 'season';

const INTEL_KEYS: readonly IntelLeaderboardKey[] = [
  'kills',
  'killfame',
  'attendance',
  'payout',
  'deaths',
  'siphoned',
  'deathfame',
];

/** Single row in any leaderboard: a labelled performer and their metric. */
interface LeaderboardEntry {
  readonly name: string;
  readonly value: number;
}

/** Static descriptor used to render a tab and its hint. */
interface LeaderboardTab {
  readonly key: LeaderboardKey;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
  /** Translation key for the value's unit label shown next to each figure. */
  readonly unitKey: TranslationKey;
}

/** Which board backs each tab. */
const BOARD_FOR_TAB: Record<IntelLeaderboardKey, (b: ReportLeaderboards) => BoardEntry[]> = {
  payout: (b) => b.split_earnings,
  deaths: (b) => b.silver_lost,
  kills: (b) => b.kills,
  attendance: (b) => b.attendance,
  killfame: (b) => b.kill_fame,
  deathfame: (b) => b.death_fame,
  siphoned: (b) => b.siphoned,
};

/** Loading state held per leaderboard so tabs feel instant after first load. */
interface TabState {
  readonly entries: ReadonlyArray<LeaderboardEntry>;
  readonly isLoading: boolean;
  readonly hasError: boolean;
}

const EMPTY_STATE: TabState = { entries: [], isLoading: false, hasError: false };
const LOADING_STATE: TabState = { entries: [], isLoading: true, hasError: false };
const ERROR_STATE: TabState = { entries: [], isLoading: false, hasError: true };

interface RankedRow {
  readonly rank: number;
  readonly name: string;
  readonly value: number;
}

/**
 * Season overview: the active season's timeline, season totals, the caller's
 * standing, and category rankings across guild activity.
 *
 * Intel boards and the report are scoped to the active season's window. When
 * no season is known the backend default (the last 30 days) applies, and the
 * page says so.
 */
@Component({
  selector: 'app-season-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    Stat,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  template: `
    <app-page-header
      [title]="t('season.title')"
      [subtitle]="t('season.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="refreshing()"
        (click)="reloadAll()"
      >
        <app-icon name="refresh" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="season" aria-labelledby="season-heading">
        <div class="season__header">
          <div class="season__identity">
            <p class="hint">{{ t('season.hero.active') }}</p>
            <h2 id="season-heading" class="section-title">
              {{ activeSeason()?.name || t('season.hero.noActive') }}
            </h2>
          </div>

          <div class="season__chips">
            @if (timeline(); as tl) {
              @if (tl.isLive) {
                <app-status-chip value="live" [toneOverride]="'success'" [label]="t('season.hero.status.live')" />
              } @else if (tl.isUpcoming) {
                <app-status-chip value="upcoming" [toneOverride]="'info'" [label]="t('season.hero.status.upcoming')" />
              } @else {
                <app-status-chip value="ended" [toneOverride]="'neutral'" [label]="t('season.hero.status.ended')" />
              }
            }
            <span class="chip">{{ multiplierLabel() }}</span>
          </div>
        </div>

        @if (timeline(); as tl) {
          <div class="season__timeline">
            <div class="season__timeline-labels">
              <span>
                {{ t('season.hero.progress') }}
                <span class="num font-semibold">{{ tl.percent }}%</span>
              </span>
              <span class="season__timeline-dates">
                {{ tl.startFormatted }} – {{ tl.endFormatted }}
                <span aria-hidden="true">·</span>
                @if (tl.isLive) {
                  @if (tl.daysRemaining > 1) {
                    {{ t('season.hero.daysRemaining', { days: tl.daysRemaining }) }}
                  } @else {
                    {{ t('season.hero.hoursRemaining', { hours: tl.hoursRemaining }) }}
                  }
                } @else if (tl.isUpcoming) {
                  {{ t('season.hero.startsIn', { days: tl.daysRemaining }) }}
                } @else {
                  {{ t('season.hero.endedAgo', { date: tl.endFormatted }) }}
                }
              </span>
            </div>
            <div
              class="season__track"
              role="progressbar"
              [attr.aria-label]="t('season.hero.progress')"
              [attr.aria-valuenow]="tl.percent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="season__fill" [style.width.%]="tl.percent"></div>
            </div>
          </div>
        } @else {
          <p class="hint">{{ t('season.hero.noActiveDesc') }}</p>
        }

        @if (summaryLoading()) {
          <app-loading variant="summary" [label]="t('common.loading')" />
        } @else {
          <app-summary-band [ariaLabel]="t('season.summary.label')">
            <app-stat [label]="t('season.hero.totalXp')" [value]="formatCompact(totalSeasonXp())" />
            <app-stat [label]="t('season.hero.participants')" [value]="activeParticipantsCount()" />
            <app-stat [label]="t('season.hero.totalBattles')" [value]="totalBattlesCount()" />
            <app-stat [label]="t('season.hero.totalFame')" [value]="formatCompact(totalFameGained())" />
          </app-summary-band>
          <p class="hint">{{ t('season.period.showing', { period: periodText() }) }}</p>
        }

        @if (myStanding(); as standing) {
          <section class="season-standing" [attr.aria-label]="t('season.hero.myStanding')">
            <div class="season-standing__body">
              <p class="season-standing__title">{{ t('season.hero.myStanding') }}</p>
              <p class="season-standing__meta">
                @if (standing.rank) {
                  <span class="font-semibold">{{ t('season.hero.myRank', { rank: standing.rank }) }}</span>
                } @else {
                  <span>{{ t('season.hero.unranked') }}</span>
                }
                <span aria-hidden="true">·</span>
                <span>{{ t('season.hero.myLevel', { level: standing.level }) }}</span>
                @if (progressionMe()?.guild_rank; as guildRank) {
                  <span aria-hidden="true">·</span>
                  <span>{{ t('season.hero.guildRank', { rank: guildRank.name }) }}</span>
                }
              </p>
              <p class="hint">
                @if (standing.xpToNext > 0) {
                  {{ t('season.hero.myNextLevel', { xp: formatValue(standing.xpToNext), next: standing.level + 1 }) }}
                } @else {
                  {{ formatValue(standing.xp) }} XP
                }
              </p>
            </div>
            <div class="season-standing__lifetime">
              <span class="hint">{{ t('season.hero.lifetimeXp') }}</span>
              <span class="num font-semibold">{{ formatValue(standing.lifetimeXp) }} XP</span>
            </div>
          </section>
        }
      </section>

      <section class="rankings" aria-labelledby="rankings-heading">
        <h2 id="rankings-heading" class="section-title">{{ t('season.rankings.title') }}</h2>
        <p class="hint">{{ t('season.rankings.subtitle') }}</p>

        <app-tabs
          [options]="tabOptions()"
          [active]="activeTab()"
          [ariaLabel]="t('season.rankings.title')"
          (activeChange)="selectTab($event)"
        />

        <p class="hint">{{ t(activeTabDef().hintKey) }}</p>

        @if (activeState().isLoading) {
          <app-loading variant="table" [label]="t('common.loading')" />
        } @else if (activeState().hasError) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="reloadActive()"
          />
        } @else if (activeEntries().length === 0) {
          <app-empty-state icon="chart" [message]="emptyMessage()" [hint]="emptyHint()" />
        } @else {
          <app-data-table
            [columns]="rankingColumns"
            [rows]="rankedRows()"
            [trackBy]="trackRankedRow"
            [pageSize]="10"
            [ariaLabel]="t(activeTabDef().labelKey)"
          >
            <ng-template dataTableCell="rank" let-row>
              <span class="num">{{ row.rank }}</span>
            </ng-template>
            <ng-template dataTableCell="value" let-row>
              <span class="num">{{ formatValue(row.value) }}</span>
              <span class="hint"> {{ unitLabel() }}</span>
            </ng-template>
          </app-data-table>
        }
      </section>
    </app-page-stack>
  `,
  styles: [
    `
      :host {
        display: block;
        color: var(--color-text);
      }

      .season,
      .rankings {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .season__header {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
      }

      .season__identity {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .season__chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }

      .season__timeline {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .season__timeline-labels {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0.5rem;
        font-size: var(--ui-text-sm);
      }

      .season__timeline-dates {
        color: var(--color-text-secondary);
      }

      .season__track {
        height: 0.5rem;
        width: 100%;
        border-radius: var(--radius-full);
        background: var(--color-surface-2);
        overflow: hidden;
      }

      .season__fill {
        height: 100%;
        border-radius: var(--radius-full);
        background: var(--color-primary);
        transition: width 200ms ease;
      }

      @media (prefers-reduced-motion: reduce) {
        .season__fill {
          transition: none;
        }
      }

      .season-standing {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.25rem;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-cards);
      }

      .season-standing__title {
        margin: 0;
        font-size: var(--ui-text-md);
        font-weight: 600;
      }

      .season-standing__meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 0.5rem;
        margin: 0.25rem 0 0;
        font-size: var(--ui-text-sm);
      }

      .season-standing__lifetime {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
      }
    `,
  ],
})
export class SeasonOverview {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly intel = inject(IntelService);
  private readonly translate = inject(TranslateService);

  /** Active season retrieved from backend. */
  protected readonly activeSeason = signal<ProgressionSeasonView | null>(null);

  /** Current member's progression profile snapshot. */
  protected readonly progressionMe = signal<ProgressionMeView | null>(null);

  /** Overview combat data from guild report if accessible. */
  protected readonly reportOverview = signal<ReportOverview | null>(null);

  /** Roster/attendance/event-count data from the same guild report, used as a fallback source. */
  protected readonly reportOperations = signal<ReportOperations | null>(null);

  /** Total participant count recorded for season XP. */
  protected readonly seasonTotalCount = signal<number>(0);

  protected readonly tabs: ReadonlyArray<LeaderboardTab> = [
    {
      key: 'season',
      labelKey: 'season.tabs.season',
      hintKey: 'leaderboards.hint.season',
      unitKey: 'leaderboards.unit.xp',
    },
    {
      key: 'kills',
      labelKey: 'season.tabs.kills',
      hintKey: 'leaderboards.hint.kills',
      unitKey: 'leaderboards.unit.kills',
    },
    {
      key: 'killfame',
      labelKey: 'season.tabs.killfame',
      hintKey: 'leaderboards.hint.killfame',
      unitKey: 'leaderboards.unit.fame',
    },
    {
      key: 'attendance',
      labelKey: 'season.tabs.attendance',
      hintKey: 'leaderboards.hint.attendance',
      unitKey: 'leaderboards.unit.events',
    },
    {
      key: 'payout',
      labelKey: 'season.tabs.payout',
      hintKey: 'leaderboards.hint.payout',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'deaths',
      labelKey: 'season.tabs.deaths',
      hintKey: 'leaderboards.hint.deaths',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'siphoned',
      labelKey: 'season.tabs.siphoned',
      hintKey: 'leaderboards.hint.siphoned',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'deathfame',
      labelKey: 'season.tabs.deathfame',
      hintKey: 'leaderboards.hint.deathfame',
      unitKey: 'leaderboards.unit.fame',
    },
  ];

  /**
   * Tabs the caller is allowed to see. Siphoned balances are guild financial
   * data, so the tab only appears for members holding `siphoned.view`.
   */
  protected readonly visibleTabs = computed<ReadonlyArray<LeaderboardTab>>(() =>
    this.tabs.filter((tab) => tab.key !== 'siphoned' || this.auth.hasPermission('siphoned.view')),
  );

  protected readonly tabOptions = computed<TabOption[]>(() =>
    this.visibleTabs().map((tab) => ({ id: tab.key, label: this.t(tab.labelKey) })),
  );

  /** Every board starts loading so a tab switched to early shows a skeleton, not "no activity". */
  private readonly stateByTab = signal<Record<LeaderboardKey, TabState>>({
    season: LOADING_STATE,
    kills: LOADING_STATE,
    killfame: LOADING_STATE,
    attendance: LOADING_STATE,
    payout: LOADING_STATE,
    deaths: LOADING_STATE,
    siphoned: LOADING_STATE,
    deathfame: LOADING_STATE,
  });

  private readonly loadedIntel = signal(false);
  private readonly loadedSeason = signal(false);

  /** In-flight guard for the header refresh button; also blocks a double-click race. */
  protected readonly refreshing = signal(false);
  /** Bumped on every `loadSeason`/`loadIntel` call so a superseded batch's results are discarded. */
  private seasonGeneration = 0;
  private intelGeneration = 0;

  /** Active category tab, defaults to Season XP. */
  protected readonly activeTab = signal<LeaderboardKey>('season');

  protected readonly activeTabDef = computed<LeaderboardTab>(
    () => this.tabs.find((tab) => tab.key === this.activeTab()) ?? this.tabs[0],
  );

  protected readonly activeState = computed<TabState>(() => this.stateByTab()[this.activeTab()]);

  protected readonly activeEntries = computed<ReadonlyArray<LeaderboardEntry>>(
    () => this.activeState().entries,
  );

  protected readonly unitLabel = computed<string>(() => this.t(this.activeTabDef().unitKey));

  /**
   * Window the Intel boards and report cover: the active season, once it is
   * known. Null means the backend default (the last 30 days) applies.
   */
  protected readonly intelWindow = computed<{ from: string; to: string } | null>(() => {
    const season = this.activeSeason();
    return season?.starts_at && season.ends_at
      ? { from: season.starts_at, to: season.ends_at }
      : null;
  });

  /** Human-readable period the Intel figures cover, for hints and empty states. */
  protected readonly periodText = computed<string>(() => {
    const seasonWindow = this.intelWindow();
    const timeline = this.timeline();
    if (!seasonWindow || !timeline) {
      return this.t('season.period.recent');
    }
    return this.t('season.period.range', {
      from: timeline.startFormatted,
      to: timeline.endFormatted,
    });
  });

  /** Computed timeline dates, percent progress, remaining time, and live status. */
  protected readonly timeline = computed(() => {
    const s = this.activeSeason();
    if (!s || !s.starts_at || !s.ends_at) {
      return null;
    }
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    if (isNaN(start) || isNaN(end)) {
      return null;
    }
    const now = Date.now();
    const total = Math.max(1, end - start);
    const elapsed = Math.max(0, now - start);
    const percent = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

    const isLive = s.is_active && now >= start && now <= end;
    const isUpcoming = now < start;
    const isEnded = now > end || (!s.is_active && now > start);

    const msRemaining = Math.max(0, end - now);
    const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
    const hoursRemaining = Math.ceil(msRemaining / (1000 * 60 * 60));

    const startFormatted = new Date(s.starts_at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const endFormatted = new Date(s.ends_at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    return {
      startFormatted,
      endFormatted,
      percent,
      isLive,
      isUpcoming,
      isEnded,
      daysRemaining,
      hoursRemaining,
    };
  });

  /** Multiplier value from current member progression snapshot. */
  protected readonly multiplierValue = computed<number>(() => {
    const me = this.progressionMe();
    if (!me || me.multiplier === undefined || me.multiplier === null) {
      return 1.0;
    }
    const parsed = Number(me.multiplier);
    return isNaN(parsed) ? 1.0 : parsed;
  });

  protected readonly multiplierLabel = computed<string>(() => {
    const mult = this.multiplierValue();
    return `×${mult.toFixed(2)} ${this.t('season.hero.multiplier')}`;
  });

  /** Total Season XP accumulated across all players. */
  protected readonly totalSeasonXp = computed<number>(() => {
    const seasonEntries = this.stateByTab().season.entries;
    return seasonEntries.reduce((acc, row) => acc + (row.value || 0), 0);
  });

  /** Count of active guild participants recorded across season & activity boards. */
  protected readonly activeParticipantsCount = computed<number>(() => {
    const seasonEntries = this.stateByTab().season.entries;
    const attendanceEntries = this.stateByTab().attendance.entries;
    const killsEntries = this.stateByTab().kills.entries;
    return Math.max(
      seasonEntries.length,
      attendanceEntries.length,
      killsEntries.length,
      this.seasonTotalCount(),
    );
  });

  /** Total battles fought over the Intel window. */
  protected readonly totalBattlesCount = computed<number>(() => {
    const rep = this.reportOverview();
    if (rep && rep.fights !== undefined && rep.fights > 0) {
      return rep.fights;
    }
    // Fallback: the attendance board is per-player attendance counts, so
    // summing it overcounts every event by however many members showed up.
    // `events_total` from the same guild report is the actual distinct count.
    const ops = this.reportOperations();
    if (ops && ops.events_total !== undefined) {
      return ops.events_total;
    }
    return 0;
  });

  /** Total fame gained by guild members over the Intel window. */
  protected readonly totalFameGained = computed<number>(() => {
    const rep = this.reportOverview();
    if (rep && rep.kill_fame !== undefined && rep.kill_fame > 0) {
      return rep.kill_fame;
    }
    const killFameEntries = this.stateByTab().killfame.entries;
    return killFameEntries.reduce((acc, row) => acc + (row.value || 0), 0);
  });

  /** The summary band waits for the season and Intel boards together. */
  protected readonly summaryLoading = computed<boolean>(
    () => this.stateByTab().season.isLoading || this.stateByTab().kills.isLoading,
  );

  /** User's personal season standing. */
  protected readonly myStanding = computed(() => {
    const me = this.progressionMe();
    if (!me) {
      return null;
    }
    return {
      level: me.level,
      xp: me.xp,
      xpToNext: me.xp_to_next,
      nextLevelAt: me.next_level_at,
      rank: me.rank,
      multiplier: me.multiplier,
      lifetimeXp: me.lifetime_xp,
    };
  });

  protected readonly rankedRows = computed<RankedRow[]>(() =>
    this.activeEntries().map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      value: entry.value,
    })),
  );

  protected readonly rankingColumns: readonly DataTableColumn<RankedRow>[] = [
    {
      key: 'rank',
      label: 'leaderboards.rank',
      sortable: true,
      accessor: (row) => row.rank,
      comparator: (a, b) => a.rank - b.rank,
    },
    {
      key: 'name',
      label: 'leaderboards.player',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'value',
      label: 'leaderboards.value',
      sortable: true,
      accessor: (row) => row.value,
      comparator: (a, b) => a.value - b.value,
      align: 'right',
    },
  ];

  protected readonly trackRankedRow = (row: RankedRow) => `${row.rank}-${row.name}`;

  /** Empty copy says what is missing and why, with the period it was checked against. */
  protected readonly emptyMessage = computed<string>(() =>
    this.activeTab() === 'season'
      ? this.t('season.empty.season')
      : this.t('season.empty.intel', { period: this.periodText() }),
  );

  protected readonly emptyHint = computed<string>(() =>
    this.activeTab() === 'season'
      ? this.t('season.empty.seasonHint')
      : this.t('season.empty.intelHint'),
  );

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    // Intel boards are scoped to the season window, so they wait for the
    // season to resolve rather than racing it.
    void this.loadSeason().then(() => this.loadIntel());
  }

  protected selectTab(key: string): void {
    if (!this.tabs.some((tab) => tab.key === key)) {
      return;
    }
    if (this.activeTab() === key) {
      return;
    }
    this.activeTab.set(key as LeaderboardKey);
  }

  protected reloadAll(): void {
    // Guards the button and prevents a double-click from racing two batches.
    if (this.refreshing()) {
      return;
    }
    this.refreshing.set(true);
    void this.loadSeason({ force: true })
      .then(() => this.loadIntel({ force: true }))
      .finally(() => this.refreshing.set(false));
  }

  protected reloadActive(): void {
    if (this.activeTab() === 'season') {
      void this.loadSeason({ force: true });
      return;
    }
    // Retry a single failed tab without disturbing the other, already-loaded tabs.
    void this.loadIntel({ force: true, only: this.activeTab() as IntelLeaderboardKey });
  }

  protected formatValue(value: number): string {
    return value.toLocaleString();
  }

  protected formatCompact(value: number): string {
    if (value >= 1_000_000_000) {
      return (value / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    }
    if (value >= 1_000_000) {
      return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (value >= 1_000) {
      return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return value.toLocaleString();
  }

  /** Loads the season XP board, season configuration, and member progression snapshot. */
  private async loadSeason(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force && this.loadedSeason()) {
      return;
    }
    const generation = ++this.seasonGeneration;
    this.patchState('season', LOADING_STATE);
    try {
      const [seasonsRes, meRes, leaderboardRes] = await Promise.allSettled([
        firstValueFrom(this.api.get<ProgressionSeasonView[]>('api/progression/seasons')),
        firstValueFrom(this.api.get<ProgressionMeView>('api/progression/me')),
        firstValueFrom(
          this.api.get<PaginatedData<ProgressionLeaderboardEntry>>('api/progression/leaderboard', {
            page: 1,
            limit: 100,
          }),
        ),
      ]);
      // A newer call to loadSeason() has since started; let its own batch win.
      if (generation !== this.seasonGeneration) {
        return;
      }

      if (seasonsRes.status === 'fulfilled') {
        const seasons = seasonsRes.value ?? [];
        const active = seasons.find((s) => s.is_active) ?? seasons[0] ?? null;
        this.activeSeason.set(active);
      }

      if (meRes.status === 'fulfilled') {
        const me = meRes.value;
        this.progressionMe.set(me);
        if (!this.activeSeason() && me?.season) {
          this.activeSeason.set(me.season);
        }
      }

      if (leaderboardRes.status === 'fulfilled') {
        const data = leaderboardRes.value;
        this.seasonTotalCount.set(data?.total_items ?? (data?.items ?? []).length);
        this.patchState('season', {
          entries: (data?.items ?? []).map((row) => ({
            name: row.username,
            value: row.xp,
          })),
          isLoading: false,
          hasError: false,
        });
        this.loadedSeason.set(true);
      } else {
        this.patchState('season', ERROR_STATE);
        this.loadedSeason.set(false);
      }
    } catch {
      if (generation !== this.seasonGeneration) {
        return;
      }
      this.patchState('season', ERROR_STATE);
      this.loadedSeason.set(false);
    }
  }

  /**
   * Loads intel category boards and summary metrics for the season window.
   * Pass `only` to retry a single failed tab without flipping the other,
   * already-loaded tabs back to a loading/error state.
   */
  private async loadIntel(
    opts: { force?: boolean; only?: IntelLeaderboardKey } = {},
  ): Promise<void> {
    if (!opts.force && this.loadedIntel()) {
      return;
    }
    const generation = ++this.intelGeneration;
    const targetKeys: readonly IntelLeaderboardKey[] = opts.only ? [opts.only] : INTEL_KEYS;
    for (const key of targetKeys) {
      this.patchState(key, LOADING_STATE);
    }
    const seasonWindow = this.intelWindow();
    try {
      const [boardsRes, reportRes] = await Promise.allSettled([
        firstValueFrom(this.intel.leaderboards(seasonWindow?.from, seasonWindow?.to)),
        firstValueFrom(this.intel.report(seasonWindow?.from, seasonWindow?.to)),
      ]);
      // A newer call to loadIntel() has since started; let its own batch win.
      if (generation !== this.intelGeneration) {
        return;
      }

      if (boardsRes.status === 'fulfilled') {
        const boards = boardsRes.value;
        // The API returns every board in one payload: a scoped retry still
        // gets fresh data for all tabs, it just doesn't reset the other
        // tabs' state to loading/error around the request.
        for (const key of INTEL_KEYS) {
          this.patchState(key, {
            entries: (BOARD_FOR_TAB[key](boards) ?? []).map((row) => ({
              name: row.username,
              value: row.value,
            })),
            isLoading: false,
            hasError: false,
          });
        }
        this.loadedIntel.set(true);
      } else {
        for (const key of targetKeys) {
          this.patchState(key, ERROR_STATE);
        }
        this.loadedIntel.set(false);
      }

      if (reportRes.status === 'fulfilled') {
        this.reportOverview.set(reportRes.value?.overview ?? null);
        this.reportOperations.set(reportRes.value?.operations ?? null);
      }
    } catch {
      if (generation !== this.intelGeneration) {
        return;
      }
      for (const key of targetKeys) {
        this.patchState(key, ERROR_STATE);
      }
      this.loadedIntel.set(false);
    }
  }

  private patchState(key: LeaderboardKey, next: TabState): void {
    this.stateByTab.update((map) => ({ ...map, [key]: next }));
  }
}

/** Backward compatibility alias. */
export { SeasonOverview as Leaderboards };
