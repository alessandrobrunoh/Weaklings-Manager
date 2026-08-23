import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { LeaderboardEntry as BoardEntry, ReportLeaderboards } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { PageHeader } from '../../shared/components/page-header/page-header';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';

/** Identifier matching every supported leaderboard. */
type LeaderboardKey =
  'payout' | 'deaths' | 'kills' | 'attendance' | 'killfame' | 'deathfame' | 'siphoned';

/** Single row in any leaderboard: a labelled performer and their metric. */
interface LeaderboardEntry {
  readonly name: string;
  readonly value: number;
}

/** Static descriptor used to render a tab and its header. */
interface LeaderboardTab {
  readonly key: LeaderboardKey;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
  readonly icon: IconName;
  /** Translation key for the value's unit label shown under the podium number. */
  readonly unitKey: TranslationKey;
}

/**
 * Which board backs each tab.
 *
 * `deaths` ranks silver lost rather than a death count — that is what the tab
 * has always shown, and the label is kept for continuity.
 */
const BOARD_FOR_TAB: Record<LeaderboardKey, (b: ReportLeaderboards) => BoardEntry[]> = {
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

/** Always shown slot count, even when fewer entries are available. */
const PODIUM_SIZE = 3;

/**
 * Cross-module top-3 rankings surfaced as a single tabbed view.
 *
 * Every board comes from one backend call, computed over the full window from
 * real activity. Tab switching is instant because all boards arrive together.
 *
 * # Side effects
 * One request on first load, and one more if the user asks to refresh.
 */
@Component({
  selector: 'app-leaderboards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader],
  template: `
    <app-page-header
      [title]="t('leaderboards.title')"
      [subtitle]="t('leaderboards.subtitle')"
      [actions]="false"
    />

    <!-- Segmented tab bar -->
    <div class="tabs" role="tablist" [attr.aria-label]="t('leaderboards.title')">
      @for (tab of visibleTabs(); track tab.key) {
        <button
          type="button"
          role="tab"
          class="tab"
          [class.tab--active]="activeTab() === tab.key"
          [attr.aria-selected]="activeTab() === tab.key"
          (click)="selectTab(tab.key)"
        >
          <app-icon [name]="tab.icon" size="0.95rem" />
          <span>{{ t(tab.labelKey) }}</span>
        </button>
      }
    </div>

    <!-- Active panel -->
    <section class="panel">
      <header class="panel__header">
        <span
          class="panel__icon"
          [style.backgroundColor]="activeAccentBg()"
          [style.color]="activeAccentFg()"
          aria-hidden="true"
        >
          <app-icon [name]="activeTabDef().icon" size="1.15rem" />
        </span>
        <div>
          <h2 class="panel__title">{{ t(activeTabDef().labelKey) }}</h2>
          <p class="panel__hint">{{ t(activeTabDef().hintKey) }}</p>
        </div>
      </header>

      @if (activeState().isLoading) {
        <div class="state state--loading" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>{{ t('common.loading') }}</span>
        </div>
      } @else if (activeState().hasError) {
        <div class="state state--error" role="alert">
          <span>{{ t('common.error') }}</span>
          <button type="button" class="link-btn" (click)="reloadActive()">
            {{ t('common.retry') }}
          </button>
        </div>
      } @else if (activeEntries().length === 0) {
        <div class="state state--empty">
          <app-icon name="trophy" size="1.75rem" class="state__icon" />
          <span>{{ t('leaderboards.empty') }}</span>
        </div>
      } @else {
        <!-- Podium: 2nd | 1st | 3rd, tallest pedestal in the center -->
        <div class="podium">
          @for (slot of podiumSlots(); track slot.rank) {
            <div class="podium__column">
              <article
                class="podium__card"
                [class.podium__card--first]="slot.rank === 1"
                [class.podium__card--muted]="slot.entry === null"
              >
                <span
                  class="podium__medal"
                  [class.podium__medal--gold]="slot.rank === 1"
                  [class.podium__medal--silver]="slot.rank === 2"
                  [class.podium__medal--bronze]="slot.rank === 3"
                >
                  @if (slot.rank === 1) {
                    <app-icon name="sparkles" size="1rem" />
                  } @else {
                    {{ slot.rank }}
                  }
                </span>
                @if (slot.entry; as entry) {
                  <p class="podium__name" [title]="entry.name">{{ entry.name }}</p>
                  <p class="podium__value">{{ formatValue(entry.value) }}</p>
                  <p class="podium__unit">{{ unitLabel() }}</p>
                } @else {
                  <p class="podium__name podium__name--muted">—</p>
                  <p class="podium__value podium__value--muted">—</p>
                  <p class="podium__unit">{{ unitLabel() }}</p>
                }
              </article>
              <div
                class="podium__pedestal"
                [class.podium__pedestal--first]="slot.rank === 1"
                [class.podium__pedestal--second]="slot.rank === 2"
                [class.podium__pedestal--third]="slot.rank === 3"
                aria-hidden="true"
              ></div>
            </div>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      /* ---------- Tab bar ---------- */

      .tabs {
        display: flex;
        gap: 0.25rem;
        width: 100%;
        margin-bottom: 1.5rem;
        padding: 0.3rem;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-full);
        overflow-x: auto;
        scrollbar-width: none;
      }

      .tabs::-webkit-scrollbar {
        display: none;
      }

      .tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 1 0 auto;
        gap: 0.4rem;
        padding: 0.45rem 0.75rem;
        border: none;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 0.78rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background-color 140ms ease,
          color 140ms ease,
          box-shadow 140ms ease;
      }

      .tab:hover {
        background: var(--color-surface-hover);
        color: var(--color-text);
      }

      .tab--active {
        background: var(--color-surface);
        color: var(--color-primary);
        box-shadow: var(--shadow-1);
      }

      /* ---------- Panel ---------- */

      .panel {
        padding: 1.75rem;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-1);
      }

      .panel__header {
        display: flex;
        align-items: center;
        gap: 0.85rem;
        padding-bottom: 1.25rem;
        margin-bottom: 1.75rem;
        border-bottom: 1px solid var(--color-border);
      }

      .panel__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: var(--radius-md);
        flex-shrink: 0;
      }

      .panel__title {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--color-text);
      }

      .panel__hint {
        margin: 0.15rem 0 0;
        font-size: 0.8rem;
        color: var(--color-text-secondary);
      }

      /* ---------- States ---------- */

      .state {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 3rem 1rem;
        text-align: center;
        font-size: 0.875rem;
        color: var(--color-text-secondary);
      }

      .state--error {
        flex-direction: column;
        color: var(--color-error);
      }

      .state--empty {
        flex-direction: column;
      }

      .state__icon {
        opacity: 0.45;
      }

      .link-btn {
        background: none;
        border: none;
        color: var(--color-primary);
        font-weight: 600;
        cursor: pointer;
        padding: 0;
      }

      .link-btn:hover {
        text-decoration: underline;
      }

      .spinner {
        width: 1.1rem;
        height: 1.1rem;
        border-radius: 50%;
        border: 2px solid var(--color-text-disabled);
        border-top-color: var(--color-primary);
        animation: leaderboard-spin 0.7s linear infinite;
      }

      @keyframes leaderboard-spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* ---------- Podium ---------- */

      .podium {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1rem;
        max-width: 54rem;
        margin: 0 auto;
      }

      .podium__column {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
      }

      .podium__card {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.3rem;
        padding: 1.9rem 0.9rem 1.1rem;
        margin-bottom: 0.75rem;
        min-height: 8.75rem;
        border-radius: var(--radius-md);
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        text-align: center;
        transition: transform 160ms ease;
      }

      .podium__card--first {
        background: var(--color-warning-container);
        border-color: color-mix(in srgb, var(--color-warning) 40%, transparent);
      }

      .podium__card--muted {
        opacity: 0.55;
      }

      .podium__medal {
        position: absolute;
        top: -1.05rem;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.15rem;
        height: 2.15rem;
        border-radius: 50%;
        font-size: 0.875rem;
        font-weight: 700;
        box-shadow:
          0 0 0 3px var(--color-surface),
          0 3px 8px rgba(0, 0, 0, 0.3);
      }

      .podium__medal--gold {
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--color-warning) 55%, white),
          var(--color-warning)
        );
        color: var(--color-text);
      }

      .podium__medal--silver {
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--color-text-secondary) 55%, white),
          var(--color-text-secondary)
        );
        color: var(--color-surface);
      }

      .podium__medal--bronze {
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--color-warning) 50%, var(--color-error)),
          var(--color-error)
        );
        color: var(--color-surface);
      }

      .podium__name {
        margin: 0.3rem 0 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--color-text);
      }

      .podium__name--muted {
        font-weight: 500;
        color: var(--color-text-disabled);
      }

      .podium__value {
        margin: 0.15rem 0 0;
        font-size: 1.3rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--color-text);
      }

      .podium__value--muted {
        color: var(--color-text-disabled);
      }

      .podium__unit {
        margin: 0;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--color-text-secondary);
      }

      .podium__pedestal {
        height: 2.25rem;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        opacity: 0.85;
      }

      .podium__pedestal--first {
        height: 4.5rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-warning) 70%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-warning) 30%, var(--color-surface-1))
        );
      }

      .podium__pedestal--second {
        height: 3.25rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-text-secondary) 55%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-text-secondary) 20%, var(--color-surface-1))
        );
      }

      .podium__pedestal--third {
        height: 2.25rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-error) 55%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-error) 22%, var(--color-surface-1))
        );
      }

      @media (max-width: 480px) {
        .podium {
          grid-template-columns: 1fr;
        }

        .podium__pedestal {
          display: none;
        }
      }
    `,
  ],
})
export class Leaderboards {
  private readonly auth = inject(AuthService);
  private readonly intel = inject(IntelService);
  private readonly translate = inject(TranslateService);

  protected readonly tabs: ReadonlyArray<LeaderboardTab> = [
    {
      key: 'payout',
      labelKey: 'leaderboards.tab.payout',
      hintKey: 'leaderboards.hint.payout',
      icon: 'bank',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'deaths',
      labelKey: 'leaderboards.tab.deaths',
      hintKey: 'leaderboards.hint.deaths',
      icon: 'shield',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'kills',
      labelKey: 'leaderboards.tab.kills',
      hintKey: 'leaderboards.hint.kills',
      icon: 'swords',
      unitKey: 'leaderboards.unit.kills',
    },
    {
      key: 'attendance',
      labelKey: 'leaderboards.tab.attendance',
      hintKey: 'leaderboards.hint.attendance',
      icon: 'calendar',
      unitKey: 'leaderboards.unit.events',
    },
    {
      key: 'killfame',
      labelKey: 'leaderboards.tab.killfame',
      hintKey: 'leaderboards.hint.killfame',
      icon: 'sparkles',
      unitKey: 'leaderboards.unit.fame',
    },
    {
      key: 'deathfame',
      labelKey: 'leaderboards.tab.deathfame',
      hintKey: 'leaderboards.hint.deathfame',
      icon: 'chart',
      unitKey: 'leaderboards.unit.fame',
    },
    {
      key: 'siphoned',
      labelKey: 'leaderboards.tab.siphoned',
      hintKey: 'leaderboards.hint.siphoned',
      icon: 'activity',
      unitKey: 'leaderboards.unit.silver',
    },
  ];

  /**
   * Tabs the caller is allowed to see. Siphoned balances are guild financial
   * data, so the tab only appears for members holding `siphoned.view`.
   */
  protected readonly visibleTabs = computed<ReadonlyArray<LeaderboardTab>>(() =>
    this.tabs.filter((tab) => tab.key !== 'siphoned' || this.auth.hasPermission('siphoned.view')),
  );

  private readonly stateByTab = signal<Record<LeaderboardKey, TabState>>({
    payout: LOADING_STATE,
    deaths: EMPTY_STATE,
    kills: EMPTY_STATE,
    attendance: EMPTY_STATE,
    killfame: EMPTY_STATE,
    deathfame: EMPTY_STATE,
    siphoned: EMPTY_STATE,
  });

  private readonly loadedTabs = signal<ReadonlySet<LeaderboardKey>>(new Set());

  protected readonly activeTab = signal<LeaderboardKey>('payout');

  protected readonly activeTabDef = computed<LeaderboardTab>(
    () => this.tabs.find((tab) => tab.key === this.activeTab()) ?? this.tabs[0],
  );

  protected readonly activeState = computed<TabState>(() => this.stateByTab()[this.activeTab()]);

  protected readonly activeEntries = computed<ReadonlyArray<LeaderboardEntry>>(
    () => this.activeState().entries,
  );

  protected readonly unitLabel = computed<string>(() => this.t(this.activeTabDef().unitKey));

  protected readonly activeAccentBg = computed(() => ACCENT_BG[this.activeTab()]);

  protected readonly activeAccentFg = computed(() => ACCENT_FG[this.activeTab()]);

  /**
   * Reorder top-3 entries into podium slots `2 - 1 - 3` with `null` padding
   * when fewer rows are available. This shape keeps the layout stable so the
   * center column is always the winner.
   */
  protected readonly podiumSlots = computed<
    ReadonlyArray<{ readonly rank: number; readonly entry: LeaderboardEntry | null }>
  >(() => {
    const top = this.activeEntries().slice(0, PODIUM_SIZE);
    const lookup = new Map<number, LeaderboardEntry>(top.map((entry, index) => [index + 1, entry]));
    return [2, 1, 3].map((rank) => ({ rank, entry: lookup.get(rank) ?? null }));
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.loadAll();
  }

  protected selectTab(key: LeaderboardKey): void {
    if (this.activeTab() === key) {
      return;
    }
    this.activeTab.set(key);
  }

  protected reloadActive(): void {
    void this.loadAll({ force: true });
  }

  protected formatValue(value: number): string {
    return value.toLocaleString();
  }

  /**
   * Loads every board in one call.
   *
   * Previously each tab aggregated client-side over its own set of list and
   * detail requests, capped at the ten most recent splits or battles — so the
   * rankings were a partial snapshot, and switching tabs meant more round
   * trips. The backend now computes all boards over the full window from real
   * activity, cached, so one request fills the page.
   */
  private async loadAll(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force && this.loadedTabs().size > 0) {
      return;
    }
    for (const tab of this.tabs) {
      this.patchState(tab.key, LOADING_STATE);
    }
    try {
      const boards = await firstValueFrom(this.intel.leaderboards());
      for (const tab of this.tabs) {
        this.patchState(tab.key, {
          entries: (BOARD_FOR_TAB[tab.key](boards) ?? []).map((row) => ({
            name: row.username,
            value: row.value,
          })),
          isLoading: false,
          hasError: false,
        });
      }
      this.loadedTabs.set(new Set(this.tabs.map((tab) => tab.key)));
    } catch {
      for (const tab of this.tabs) {
        this.patchState(tab.key, ERROR_STATE);
      }
    }
  }

  private patchState(key: LeaderboardKey, next: TabState): void {
    this.stateByTab.update((map) => ({ ...map, [key]: next }));
  }
}

const ACCENT_BG: Record<LeaderboardKey, string> = {
  payout: 'var(--color-primary-container)',
  deaths: 'var(--color-error-container)',
  kills: 'var(--color-warning-container)',
  attendance: 'var(--color-success-container)',
  killfame: 'var(--color-warning-container)',
  deathfame: 'var(--color-error-container)',
  siphoned: 'var(--color-primary-container)',
};

const ACCENT_FG: Record<LeaderboardKey, string> = {
  payout: 'var(--color-primary)',
  deaths: 'var(--color-error)',
  kills: 'var(--color-warning)',
  attendance: 'var(--color-success)',
  killfame: 'var(--color-warning)',
  deathfame: 'var(--color-error)',
  siphoned: 'var(--color-primary)',
};
