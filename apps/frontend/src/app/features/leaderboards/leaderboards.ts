import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  LeaderboardEntry as BoardEntry,
  PaginatedData,
  ProgressionLeaderboardEntry,
  ProgressionMeView,
  ProgressionSeasonView,
  ReportLeaderboards,
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
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';

/** Identifier matching every supported leaderboard. */
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

/** Static descriptor used to render a tab and its header. */
interface LeaderboardTab {
  readonly key: LeaderboardKey;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
  readonly icon: IconName;
  /** Translation key for the value's unit label shown under the podium number. */
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

/** Always shown slot count, even when fewer entries are available. */
const PODIUM_SIZE = 3;

/**
 * Comprehensive Season Overview (Panoramica Stagione) component.
 *
 * Displays the current active season timeline, multiplier chip, key season KPIs,
 * personal standing, top-3 podiums and category leaderboards across all guild activities.
 */
@Component({
  selector: 'app-season-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    EmptyState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    ViewToggle,
  ],
  template: `
    <app-page-header
      [title]="t('season.title')"
      [subtitle]="t('season.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        (click)="reloadAll()"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- Active Season Hero Banner -->
      <section class="season-hero">
        <div class="season-hero__glow" aria-hidden="true"></div>

        <div class="season-hero__content">
          <!-- Top Row: Season Title, Status badge & Multiplier -->
          <div class="season-hero__header">
            <div class="season-hero__identity">
              <div class="season-hero__badge-wrap">
                <span class="season-hero__trophy-icon" aria-hidden="true">
                  <app-icon name="trophy" size="1.1rem" />
                </span>
                <span class="eyebrow">{{ t('season.hero.active') }}</span>
              </div>
              <h2 class="season-hero__title">
                {{ activeSeason()?.name || t('season.hero.noActive') }}
              </h2>
            </div>

            <div class="season-hero__chips">
              @if (timeline(); as tl) {
                @if (tl.isLive) {
                  <span class="chip chip--success season-hero__status-chip">
                    <span class="live-dot" aria-hidden="true"></span>
                    {{ t('season.hero.status.live') }}
                  </span>
                } @else if (tl.isUpcoming) {
                  <span class="chip chip--info">
                    <app-icon name="calendar" size="0.75rem" />
                    {{ t('season.hero.status.upcoming') }}
                  </span>
                } @else {
                  <span class="chip">
                    {{ t('season.hero.status.ended') }}
                  </span>
                }
              }

              <!-- Multiplier chip -->
              <span
                class="chip season-hero__multiplier-chip"
                [class.chip--warning]="hasActiveMultiplierBoost()"
              >
                <app-icon name="sparkles" size="0.8rem" />
                <span>{{ multiplierLabel() }}</span>
              </span>
            </div>
          </div>

          <!-- Timeline & Progress Bar -->
          @if (timeline(); as tl) {
            <div class="season-timeline">
              <div class="season-timeline__labels">
                <div class="season-timeline__left">
                  <span class="season-timeline__caption">{{ t('season.hero.progress') }}</span>
                  <span class="season-timeline__percent mono">{{ tl.percent }}%</span>
                </div>
                <div class="season-timeline__right">
                  <span class="season-timeline__dates">{{ tl.startFormatted }} – {{ tl.endFormatted }}</span>
                  @if (tl.isLive) {
                    <span class="season-timeline__remaining">
                      @if (tl.daysRemaining > 1) {
                        {{ t('season.hero.daysRemaining', { days: tl.daysRemaining }) }}
                      } @else {
                        {{ t('season.hero.hoursRemaining', { hours: tl.hoursRemaining }) }}
                      }
                    </span>
                  } @else if (tl.isUpcoming) {
                    <span class="season-timeline__remaining">
                      {{ t('season.hero.startsIn', { days: tl.daysRemaining }) }}
                    </span>
                  } @else {
                    <span class="season-timeline__remaining">
                      {{ t('season.hero.endedAgo', { date: tl.endFormatted }) }}
                    </span>
                  }
                </div>
              </div>

              <!-- Track -->
              <div
                class="season-timeline__track"
                role="progressbar"
                [attr.aria-valuenow]="tl.percent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="season-timeline__fill"
                  [style.width.%]="tl.percent"
                ></div>
              </div>
            </div>
          } @else {
            <p class="season-hero__no-season-desc">
              {{ t('season.hero.noActiveDesc') }}
            </p>
          }

          <!-- Key Metrics Summary Grid -->
          <div class="season-metrics-grid">
            <div class="metric-card">
              <div class="metric-card__header">
                <span class="metric-card__label">{{ t('season.hero.totalXp') }}</span>
                <span class="metric-card__icon metric-card__icon--gold" aria-hidden="true">
                  <app-icon name="trophy" size="0.9rem" />
                </span>
              </div>
              <p class="metric-card__value mono">
                {{ formatCompact(totalSeasonXp()) }}
                <span class="metric-card__unit">XP</span>
              </p>
            </div>

            <div class="metric-card">
              <div class="metric-card__header">
                <span class="metric-card__label">{{ t('season.hero.participants') }}</span>
                <span class="metric-card__icon metric-card__icon--info" aria-hidden="true">
                  <app-icon name="users" size="0.9rem" />
                </span>
              </div>
              <p class="metric-card__value mono">{{ activeParticipantsCount() }}</p>
            </div>

            <div class="metric-card">
              <div class="metric-card__header">
                <span class="metric-card__label">{{ t('season.hero.totalBattles') }}</span>
                <span class="metric-card__icon metric-card__icon--danger" aria-hidden="true">
                  <app-icon name="shield" size="0.9rem" />
                </span>
              </div>
              <p class="metric-card__value mono">{{ totalBattlesCount() }}</p>
            </div>

            <div class="metric-card">
              <div class="metric-card__header">
                <span class="metric-card__label">{{ t('season.hero.totalFame') }}</span>
                <span class="metric-card__icon metric-card__icon--warning" aria-hidden="true">
                  <app-icon name="sparkles" size="0.9rem" />
                </span>
              </div>
              <p class="metric-card__value mono">{{ formatCompact(totalFameGained()) }}</p>
            </div>
          </div>

          <!-- Personal Standing Section -->
          @if (myStanding(); as standing) {
            <div class="season-standing">
              <div class="season-standing__left">
                <div class="season-standing__avatar" aria-hidden="true">
                  <app-icon name="users" size="1.1rem" />
                </div>
                <div>
                  <div class="season-standing__heading">
                    <span class="season-standing__title">{{ t('season.hero.myStanding') }}</span>
                    @if (standing.rank) {
                      <span class="chip chip--warning font-bold">
                        {{ t('season.hero.myRank', { rank: standing.rank }) }}
                      </span>
                    } @else {
                      <span class="chip font-medium">{{ t('season.hero.unranked') }}</span>
                    }
                    <span class="chip chip--info font-bold">
                      {{ t('season.hero.myLevel', { level: standing.level }) }}
                    </span>
                  </div>
                  <p class="season-standing__hint">
                    @if (standing.xpToNext > 0) {
                      {{ t('season.hero.myNextLevel', { xp: formatValue(standing.xpToNext), next: standing.level + 1 }) }}
                    } @else {
                      {{ formatValue(standing.xp) }} XP
                    }
                  </p>
                </div>
              </div>

              <div class="season-standing__right">
                <div class="season-standing__lifetime">
                  <span class="season-standing__lifetime-label">{{ t('season.hero.lifetimeXp') }}</span>
                  <span class="season-standing__lifetime-value mono">{{ formatValue(standing.lifetimeXp) }} XP</span>
                </div>
              </div>
            </div>
          }
        </div>
      </section>

      <!-- Category Rankings Section -->
      <section class="rankings-section">
        <div class="rankings-section__header">
          <div>
            <h3 class="rankings-section__title">{{ t('season.rankings.title') }}</h3>
            <p class="rankings-section__subtitle">{{ t('season.rankings.subtitle') }}</p>
          </div>
        </div>

        <!-- View toggle tabs -->
        <div class="rankings-tabs">
          <app-view-toggle
            [options]="tabOptions()"
            [active]="activeTab()"
            (activeChange)="selectTab($event)"
          />
        </div>

        <!-- Active Category Panel -->
        <div class="panel">
          <header class="panel__header">
            <span
              class="panel__icon"
              [style.backgroundColor]="activeAccentBg()"
              [style.color]="activeAccentFg()"
              aria-hidden="true"
            >
              <app-icon [name]="activeTabDef().icon" size="1.25rem" />
            </span>
            <div>
              <h4 class="panel__title">{{ t(activeTabDef().labelKey) }}</h4>
              <p class="panel__hint">{{ t(activeTabDef().hintKey) }}</p>
            </div>
          </header>

          @if (activeState().isLoading) {
            <app-loading [label]="t('common.loading')" />
          } @else if (activeState().hasError) {
            <div class="state state--error" role="alert">
              <span>{{ t('common.error') }}</span>
              <button type="button" class="link-btn" (click)="reloadActive()">
                {{ t('common.retry') }}
              </button>
            </div>
          } @else if (activeEntries().length === 0) {
            <app-empty-state icon="trophy" [message]="t('season.empty')" />
          } @else {
            <!-- Top 3 Podium (2nd | 1st | 3rd) -->
            <div class="podium">
              @for (slot of podiumSlots(); track slot.rank) {
                <div class="podium__column" [class.podium__column--champion]="slot.rank === 1">
                  <article
                    class="podium__card"
                    [class.podium__card--first]="slot.rank === 1"
                    [class.podium__card--second]="slot.rank === 2"
                    [class.podium__card--third]="slot.rank === 3"
                    [class.podium__card--muted]="slot.entry === null"
                  >
                    <span
                      class="podium__medal"
                      [class.podium__medal--gold]="slot.rank === 1"
                      [class.podium__medal--silver]="slot.rank === 2"
                      [class.podium__medal--bronze]="slot.rank === 3"
                    >
                      @if (slot.rank === 1) {
                        <app-icon name="sparkles" size="1.1rem" />
                      } @else {
                        {{ slot.rank }}
                      }
                    </span>

                    @if (slot.rank === 1) {
                      <div class="podium__crown" aria-hidden="true">
                        <app-icon name="trophy" size="0.95rem" />
                      </div>
                    }

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
                  >
                    <span class="podium__pedestal-rank">#{{ slot.rank }}</span>
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Detailed Data Table -->
        @if (!activeState().isLoading && !activeState().hasError && activeEntries().length > 0) {
          <div class="card p-5">
            <div class="flex items-center justify-between gap-3 mb-4">
              <h4 class="eyebrow">{{ t('season.rankings.title') }} — {{ t(activeTabDef().labelKey) }}</h4>
              <span class="text-xs" style="color: var(--color-text-secondary)">
                {{ rankedRows().length }} {{ t('season.hero.participants') }}
              </span>
            </div>

            <app-data-table
              [columns]="rankingColumns"
              [rows]="rankedRows()"
              [trackBy]="trackRankedRow"
              [pageSize]="10"
              emptyIcon="trophy"
            >
              <ng-template dataTableCell="rank" let-row>
                @if (row.rank === 1) {
                  <span class="chip chip--warning font-bold">🥇 #1</span>
                } @else if (row.rank === 2) {
                  <span class="chip chip--info font-bold">🥈 #2</span>
                } @else if (row.rank === 3) {
                  <span class="chip chip--error font-bold">🥉 #3</span>
                } @else {
                  <span class="font-mono text-sm" style="color: var(--color-text-secondary)">#{{ row.rank }}</span>
                }
              </ng-template>
              <ng-template dataTableCell="name" let-row>
                <div class="flex items-center gap-2">
                  <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                    style="background: var(--color-surface-2); color: var(--color-text-secondary)"
                  >
                    <app-icon name="users" size="0.75rem" />
                  </span>
                  <span class="font-medium" style="color: var(--color-text)">{{ row.name }}</span>
                </div>
              </ng-template>
              <ng-template dataTableCell="value" let-row>
                <span class="font-semibold mono" style="color: var(--color-text)">
                  {{ formatValue(row.value) }}
                  <span class="text-xs font-normal" style="color: var(--color-text-secondary)">{{ unitLabel() }}</span>
                </span>
              </ng-template>
            </app-data-table>
          </div>
        }
      </section>
    </app-page-stack>
  `,
  styles: [
    `
      /* ---------- Season Hero Banner ---------- */

      .season-hero {
        position: relative;
        overflow: hidden;
        padding: 1.75rem;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-cards);
        box-shadow: var(--shadow-subtle-2);
      }

      .season-hero__glow {
        position: absolute;
        top: -6rem;
        left: 50%;
        transform: translateX(-50%);
        width: 36rem;
        height: 14rem;
        background: radial-gradient(ellipse at center, rgba(245, 158, 11, 0.12), transparent 70%);
        pointer-events: none;
      }

      .season-hero__content {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }

      .season-hero__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 1rem;
      }

      .season-hero__identity {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }

      .season-hero__badge-wrap {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .season-hero__trophy-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--color-warning);
      }

      .season-hero__title {
        margin: 0;
        font-size: 1.65rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--color-text);
      }

      .season-hero__chips {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
      }

      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background-color: var(--color-success);
        box-shadow: 0 0 0 2px var(--color-success-container);
        animation: pulse-live 1.8s ease-in-out infinite;
      }

      @keyframes pulse-live {
        0%,
        100% {
          transform: scale(1);
          opacity: 1;
        }
        50% {
          transform: scale(1.3);
          opacity: 0.6;
        }
      }

      .season-hero__multiplier-chip {
        font-weight: 600;
        border: 1px solid transparent;
      }

      .season-hero__multiplier-chip.chip--warning {
        background-color: var(--color-warning-container);
        color: var(--color-warning);
        border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
      }

      .season-hero__no-season-desc {
        margin: 0;
        font-size: 0.875rem;
        color: var(--color-text-secondary);
      }

      /* ---------- Timeline & Progress Bar ---------- */

      .season-timeline {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1rem 1.25rem;
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .season-timeline__labels {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.5rem;
        font-size: 0.8125rem;
      }

      .season-timeline__left {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .season-timeline__caption {
        font-weight: 600;
        color: var(--color-text);
      }

      .season-timeline__percent {
        font-weight: 700;
        color: var(--color-warning);
      }

      .season-timeline__right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        color: var(--color-text-secondary);
      }

      .season-timeline__remaining {
        font-weight: 600;
        color: var(--color-text);
      }

      .season-timeline__track {
        height: 8px;
        width: 100%;
        border-radius: var(--radius-full);
        background: var(--color-surface-2);
        overflow: hidden;
      }

      .season-timeline__fill {
        height: 100%;
        border-radius: var(--radius-full);
        background: linear-gradient(
          90deg,
          color-mix(in srgb, var(--color-warning) 80%, #fbbf24),
          var(--color-warning)
        );
        transition: width 400ms cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 0 10px rgba(245, 158, 11, 0.35);
      }

      /* ---------- Metrics Grid ---------- */

      .season-metrics-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
      }

      .metric-card {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 1rem 1.15rem;
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        transition:
          transform 160ms ease,
          border-color 160ms ease;
      }

      .metric-card:hover {
        transform: translateY(-2px);
        border-color: var(--color-border-strong);
      }

      .metric-card__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }

      .metric-card__label {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-secondary);
      }

      .metric-card__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border-radius: var(--radius-full);
      }

      .metric-card__icon--gold {
        background: var(--color-warning-container);
        color: var(--color-warning);
      }

      .metric-card__icon--info {
        background: var(--color-primary-container);
        color: var(--color-primary);
      }

      .metric-card__icon--danger {
        background: var(--color-error-container);
        color: var(--color-error);
      }

      .metric-card__icon--warning {
        background: var(--color-warning-container);
        color: var(--color-warning);
      }

      .metric-card__value {
        margin: 0;
        font-size: 1.45rem;
        font-weight: 700;
        color: var(--color-text);
        letter-spacing: -0.02em;
      }

      .metric-card__unit {
        font-size: 0.8rem;
        font-weight: 500;
        color: var(--color-text-secondary);
      }

      /* ---------- Member Standing ---------- */

      .season-standing {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 1rem;
        padding: 1rem 1.25rem;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .season-standing__left {
        display: flex;
        align-items: center;
        gap: 0.85rem;
      }

      .season-standing__avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.5rem;
        height: 2.5rem;
        border-radius: var(--radius-full);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        color: var(--color-text);
        flex-shrink: 0;
      }

      .season-standing__heading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .season-standing__title {
        font-weight: 600;
        font-size: 0.9375rem;
        color: var(--color-text);
      }

      .season-standing__hint {
        margin: 0.15rem 0 0;
        font-size: 0.8125rem;
        color: var(--color-text-secondary);
      }

      .season-standing__lifetime {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }

      .season-standing__lifetime-label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-secondary);
      }

      .season-standing__lifetime-value {
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--color-text);
      }

      /* ---------- Rankings Section ---------- */

      .rankings-section {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        margin-top: 0.5rem;
      }

      .rankings-section__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .rankings-section__title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 700;
        letter-spacing: -0.015em;
        color: var(--color-text);
      }

      .rankings-section__subtitle {
        margin: 0.2rem 0 0;
        font-size: 0.875rem;
        color: var(--color-text-secondary);
      }

      .rankings-tabs {
        overflow-x: auto;
        padding-bottom: 0.25rem;
      }

      /* ---------- Panel ---------- */

      .panel {
        padding: 1.75rem;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-cards);
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

      /* ---------- Podium ---------- */

      .podium {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1.25rem;
        max-width: 54rem;
        margin: 0 auto;
        padding-top: 1rem;
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
        padding: 2.1rem 0.9rem 1.25rem;
        margin-bottom: 0.75rem;
        min-height: 9.25rem;
        border-radius: var(--radius-cards);
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        text-align: center;
        transition:
          transform 180ms cubic-bezier(0.4, 0, 0.2, 1),
          box-shadow 180ms ease,
          border-color 180ms ease;
      }

      .podium__card:hover {
        transform: translateY(-4px);
        box-shadow: var(--shadow-xl);
      }

      .podium__card--first {
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-warning) 8%, var(--color-surface)),
          var(--color-surface)
        );
        border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
        box-shadow: 0 8px 24px -6px rgba(245, 158, 11, 0.18);
      }

      .podium__card--second {
        border-color: color-mix(in srgb, var(--color-text-secondary) 30%, var(--color-border));
      }

      .podium__card--third {
        border-color: color-mix(in srgb, var(--color-error) 25%, var(--color-border));
      }

      .podium__card--muted {
        opacity: 0.55;
      }

      .podium__crown {
        position: absolute;
        top: -2.35rem;
        left: 50%;
        transform: translateX(-50%);
        color: var(--color-warning);
        filter: drop-shadow(0 2px 6px rgba(245, 158, 11, 0.45));
        animation: float-crown 2.4s ease-in-out infinite alternate;
      }

      @keyframes float-crown {
        0% {
          transform: translateX(-50%) translateY(0);
        }
        100% {
          transform: translateX(-50%) translateY(-3px);
        }
      }

      .podium__medal {
        position: absolute;
        top: -1.15rem;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.35rem;
        height: 2.35rem;
        border-radius: 50%;
        font-size: 0.875rem;
        font-weight: 700;
        box-shadow:
          0 0 0 3px var(--color-surface),
          0 4px 10px rgba(0, 0, 0, 0.25);
      }

      .podium__medal--gold {
        background: linear-gradient(
          135deg,
          #fde047,
          #eab308 60%,
          #ca8a04
        );
        color: #713f12;
      }

      .podium__medal--silver {
        background: linear-gradient(
          135deg,
          #f4f4f5,
          #cbd5e1 60%,
          #94a3b8
        );
        color: #334155;
      }

      .podium__medal--bronze {
        background: linear-gradient(
          135deg,
          #fdba74,
          #ea580c 65%,
          #9a3412
        );
        color: #ffffff;
      }

      .podium__name {
        margin: 0.3rem 0 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.9375rem;
        font-weight: 600;
        color: var(--color-text);
      }

      .podium__name--muted {
        font-weight: 500;
        color: var(--color-text-disabled);
      }

      .podium__value {
        margin: 0.15rem 0 0;
        font-size: 1.35rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--color-text);
      }

      .podium__value--muted {
        color: var(--color-text-disabled);
      }

      .podium__unit {
        margin: 0;
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--color-text-secondary);
      }

      .podium__pedestal {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 0.5rem;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        opacity: 0.9;
      }

      .podium__pedestal-rank {
        font-family: var(--font-geistmono);
        font-size: 0.75rem;
        font-weight: 700;
        opacity: 0.65;
        letter-spacing: 0.05em;
      }

      .podium__pedestal--first {
        height: 4.75rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-warning) 70%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-warning) 25%, var(--color-surface-1))
        );
        color: var(--color-text);
      }

      .podium__pedestal--second {
        height: 3.5rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-text-secondary) 55%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-text-secondary) 18%, var(--color-surface-1))
        );
        color: var(--color-surface);
      }

      .podium__pedestal--third {
        height: 2.5rem;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--color-error) 55%, var(--color-surface-1)),
          color-mix(in srgb, var(--color-error) 20%, var(--color-surface-1))
        );
        color: var(--color-surface);
      }

      /* ---------- Responsive Styles ---------- */

      @media (max-width: 900px) {
        .season-metrics-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      @media (max-width: 580px) {
        .season-metrics-grid {
          grid-template-columns: 1fr;
        }

        .season-hero__header {
          flex-direction: column;
        }

        .season-standing {
          flex-direction: column;
          align-items: flex-start;
        }

        .season-standing__lifetime {
          align-items: flex-start;
        }

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

  /** Total participant count recorded for season XP. */
  protected readonly seasonTotalCount = signal<number>(0);

  protected readonly tabs: ReadonlyArray<LeaderboardTab> = [
    {
      key: 'season',
      labelKey: 'season.tabs.season',
      hintKey: 'leaderboards.hint.season',
      icon: 'trophy',
      unitKey: 'leaderboards.unit.xp',
    },
    {
      key: 'kills',
      labelKey: 'season.tabs.kills',
      hintKey: 'leaderboards.hint.kills',
      icon: 'swords',
      unitKey: 'leaderboards.unit.kills',
    },
    {
      key: 'killfame',
      labelKey: 'season.tabs.killfame',
      hintKey: 'leaderboards.hint.killfame',
      icon: 'sparkles',
      unitKey: 'leaderboards.unit.fame',
    },
    {
      key: 'attendance',
      labelKey: 'season.tabs.attendance',
      hintKey: 'leaderboards.hint.attendance',
      icon: 'calendar',
      unitKey: 'leaderboards.unit.events',
    },
    {
      key: 'payout',
      labelKey: 'season.tabs.payout',
      hintKey: 'leaderboards.hint.payout',
      icon: 'bank',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'deaths',
      labelKey: 'season.tabs.deaths',
      hintKey: 'leaderboards.hint.deaths',
      icon: 'shield',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'siphoned',
      labelKey: 'season.tabs.siphoned',
      hintKey: 'leaderboards.hint.siphoned',
      icon: 'activity',
      unitKey: 'leaderboards.unit.silver',
    },
    {
      key: 'deathfame',
      labelKey: 'season.tabs.deathfame',
      hintKey: 'leaderboards.hint.deathfame',
      icon: 'chart',
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

  protected readonly tabOptions = computed<ViewToggleOption[]>(() =>
    this.visibleTabs().map((tab) => ({ id: tab.key, label: this.t(tab.labelKey), icon: tab.icon })),
  );

  private readonly stateByTab = signal<Record<LeaderboardKey, TabState>>({
    season: LOADING_STATE,
    kills: EMPTY_STATE,
    killfame: EMPTY_STATE,
    attendance: EMPTY_STATE,
    payout: EMPTY_STATE,
    deaths: EMPTY_STATE,
    siphoned: EMPTY_STATE,
    deathfame: EMPTY_STATE,
  });

  private readonly loadedIntel = signal(false);
  private readonly loadedSeason = signal(false);

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

  protected readonly activeAccentBg = computed(() => ACCENT_BG[this.activeTab()]);

  protected readonly activeAccentFg = computed(() => ACCENT_FG[this.activeTab()]);

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

  protected readonly hasActiveMultiplierBoost = computed<boolean>(
    () => this.multiplierValue() > 1.0,
  );

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

  /** Total battles fought over the season window. */
  protected readonly totalBattlesCount = computed<number>(() => {
    const rep = this.reportOverview();
    if (rep && rep.fights !== undefined && rep.fights > 0) {
      return rep.fights;
    }
    const attendanceEntries = this.stateByTab().attendance.entries;
    return attendanceEntries.reduce((acc, row) => acc + (row.value || 0), 0);
  });

  /** Total fame gained by guild members. */
  protected readonly totalFameGained = computed<number>(() => {
    const rep = this.reportOverview();
    if (rep && rep.kill_fame !== undefined && rep.kill_fame > 0) {
      return rep.kill_fame;
    }
    const killFameEntries = this.stateByTab().killfame.entries;
    return killFameEntries.reduce((acc, row) => acc + (row.value || 0), 0);
  });

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

  /**
   * Reorder top-3 entries into podium slots `2 - 1 - 3` with `null` padding
   * when fewer rows are available.
   */
  protected readonly podiumSlots = computed<
    ReadonlyArray<{ readonly rank: number; readonly entry: LeaderboardEntry | null }>
  >(() => {
    const top = this.activeEntries().slice(0, PODIUM_SIZE);
    const lookup = new Map<number, LeaderboardEntry>(top.map((entry, index) => [index + 1, entry]));
    return [2, 1, 3].map((rank) => ({ rank, entry: lookup.get(rank) ?? null }));
  });

  protected readonly rankedRows = computed(() => {
    return this.activeEntries().map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      value: entry.value,
    }));
  });

  protected readonly rankingColumns: readonly DataTableColumn<{ rank: number; name: string; value: number }>[] = [
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

  protected readonly trackRankedRow = (row: { rank: number; name: string; value: number }) => `${row.rank}-${row.name}`;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.loadSeason();
    void this.loadIntel();
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
    void this.loadSeason({ force: true });
    void this.loadIntel({ force: true });
  }

  protected reloadActive(): void {
    if (this.activeTab() === 'season') {
      void this.loadSeason({ force: true });
      return;
    }
    void this.loadIntel({ force: true });
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
      this.patchState('season', ERROR_STATE);
      this.loadedSeason.set(false);
    }
  }

  /** Loads intel category boards and summary metrics. */
  private async loadIntel(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force && this.loadedIntel()) {
      return;
    }
    for (const key of INTEL_KEYS) {
      this.patchState(key, LOADING_STATE);
    }
    try {
      const [boardsRes, reportRes] = await Promise.allSettled([
        firstValueFrom(this.intel.leaderboards()),
        firstValueFrom(this.intel.report()),
      ]);

      if (boardsRes.status === 'fulfilled') {
        const boards = boardsRes.value;
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
        for (const key of INTEL_KEYS) {
          this.patchState(key, ERROR_STATE);
        }
        this.loadedIntel.set(false);
      }

      if (reportRes.status === 'fulfilled') {
        this.reportOverview.set(reportRes.value?.overview ?? null);
      }
    } catch {
      for (const key of INTEL_KEYS) {
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

const ACCENT_BG: Record<LeaderboardKey, string> = {
  season: 'var(--color-warning-container)',
  kills: 'var(--color-error-container)',
  killfame: 'var(--color-warning-container)',
  attendance: 'var(--color-success-container)',
  payout: 'var(--color-primary-container)',
  deaths: 'var(--color-error-container)',
  siphoned: 'var(--color-primary-container)',
  deathfame: 'var(--color-error-container)',
};

const ACCENT_FG: Record<LeaderboardKey, string> = {
  season: 'var(--color-warning)',
  kills: 'var(--color-error)',
  killfame: 'var(--color-warning)',
  attendance: 'var(--color-success)',
  payout: 'var(--color-primary)',
  deaths: 'var(--color-error)',
  siphoned: 'var(--color-primary)',
  deathfame: 'var(--color-error)',
};

