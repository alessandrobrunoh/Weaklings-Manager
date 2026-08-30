import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type {
  RegearBudgetSummary,
  AlbionLinkStatus,
  BalanceSummary,
  BattleSummary,
  PaginatedData,
  ProgressionMeView,
  SiphonedEntryView,
  SiphonedPlayerBalance,
  TransactionView,
  UserMetrics,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService, type ThemePreference } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';

interface ProfileMetric {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

interface ProfileChartMetric {
  readonly label: string;
  readonly value: number;
}

/**
 * Empty paginated response for optional profile panels.
 *
 * The `/battles/me` endpoint intentionally returns a validation error when the user has not linked
 * an Albion character. Profile should still render money/settings in that case, so we degrade only
 * the fight panel to an empty dataset.
 *
 * @example
 * ```ts
 * const empty = emptyPaginatedBattles();
 * console.assert(empty.items.length === 0);
 * ```
 */
function emptyPaginatedBattles(): PaginatedData<BattleSummary> {
  return {
    items: [],
    total_items: 0,
    total_pages: 0,
    current_page: 1,
    limit: 50,
  };
}

/**
 * Personal performance command center.
 *
 * Settings were too small for what members need day-to-day. This profile view keeps preferences,
 * but its primary purpose is to show the caller's money, siphoned-energy activity, and fight
 * history using the same backend ledgers used by the guild pages.
 *
 * @example
 * ```ts
 * { path: 'profile', loadComponent: () => import('./features/settings/settings').then(m => m.Settings) }
 * ```
 */
@Component({
  selector: 'app-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, PageHeader, PageStack, Loading, ErrorState, DataTable],
  template: `
    <app-page-header title="Profile" subtitle="Your account, economy and fight performance." />

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else {
      <app-page-stack>
        <section class="profile__hero card p-6">
          <div>
            <p class="profile__eyebrow">Account</p>
            <h1>{{ displayName() }}</h1>
            <p>{{ profile()?.email || 'No email' }} · {{ profile()?.highest_role || 'User' }}</p>
            @if (albionLink()?.linked) {
              <span class="chip chip--success">Albion: {{ albionLink()?.albion_player_name }}</span>
            } @else {
              <span class="chip chip--warning">Albion character not linked</span>
            }
          </div>
        </section>

        @if (progression(); as xp) {
          <article class="surface p-5">
            <h2 class="profile__panel-title">{{ t('profile.xp.title') }}</h2>
            <p class="profile__sub" style="margin-top: 0">
              {{ t('profile.xp.season') }}:
              {{ xp.season?.name || t('profile.xp.noSeason') }}
            </p>
            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <p class="profile__label">{{ t('profile.xp.level') }}</p>
                <p class="profile__value">{{ xp.level }}</p>
              </div>
              <div>
                <p class="profile__label">{{ t('profile.xp.xp') }}</p>
                <p class="profile__value">{{ formatAmount(xp.xp) }}</p>
              </div>
              <div>
                <p class="profile__label">{{ t('profile.xp.rank') }}</p>
                <p class="profile__value">
                  {{ xp.rank != null ? '#' + xp.rank : t('profile.xp.unranked') }}
                </p>
              </div>
              <div>
                <p class="profile__label">{{ t('profile.xp.lifetime') }}</p>
                <p class="profile__value">{{ formatAmount(xp.lifetime_xp) }}</p>
              </div>
            </div>
            <div class="profile__bar-row">
              <span>{{ t('profile.xp.toNext') }}</span>
              <div class="profile__bar">
                <span [style.width.%]="progressionBarPercent(xp)"></span>
              </div>
              <strong>{{ formatAmount(xp.xp) }} / {{ formatAmount(xp.xp + xp.xp_to_next) }}</strong>
            </div>
            @if (showMultiplier(xp.multiplier)) {
              <p class="mt-3 text-sm" style="color: var(--color-warning)">
                {{ t('profile.xp.multiplier') }}: ×{{ formatMultiplier(xp.multiplier) }}
              </p>
            }
          </article>
        }

        @if (loadFailed()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="load()"
          />
        } @else {
          <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            @for (metric of profileMetrics(); track metric.label) {
              <article class="surface p-4">
                <p class="profile__label">{{ metric.label }}</p>
                <p class="profile__value">{{ metric.value }}</p>
                @if (metric.sub) {
                  <p class="profile__sub">{{ metric.sub }}</p>
                }
              </article>
            }
          </section>

          <section class="grid gap-4 xl:grid-cols-3">
            <article class="surface p-5">
              <h2 class="profile__panel-title">Bank status</h2>
              @for (row of bankChart(); track row.label) {
                <div class="profile__bar-row">
                  <span>{{ row.label }}</span>
                  <div class="profile__bar">
                    <span [style.width.%]="chartPercent(row.value, bankChart())"></span>
                  </div>
                  <strong>{{ formatAmount(row.value) }}</strong>
                </div>
              }
            </article>
            <article class="surface p-5">
              <h2 class="profile__panel-title">Siphoned energy</h2>
              @for (row of siphonedChart(); track row.label) {
                <div class="profile__bar-row">
                  <span>{{ row.label }}</span>
                  <div class="profile__bar profile__bar--energy">
                    <span [style.width.%]="chartPercent(row.value, siphonedChart())"></span>
                  </div>
                  <strong>{{ formatAmount(row.value) }}</strong>
                </div>
              }
            </article>
            <article class="surface p-5">
              <h2 class="profile__panel-title">My fights</h2>
              @for (row of battleChart(); track row.label) {
                <div class="profile__bar-row">
                  <span>{{ row.label }}</span>
                  <div class="profile__bar profile__bar--fight">
                    <span [style.width.%]="chartPercent(row.value, battleChart())"></span>
                  </div>
                  <strong>{{ formatCompact(row.value) }}</strong>
                </div>
              }
            </article>
          </section>

          <!-- Attendance, regear and splits: the three areas the profile used to
           say nothing about, even though the data existed. -->
          <section class="grid gap-4 xl:grid-cols-3">
            <article class="surface p-5">
              <h2 class="profile__panel-title">Attendance</h2>
              @if (userMetrics(); as m) {
                <div class="profile__bar-row">
                  <span>Signed up</span>
                  <div class="profile__bar">
                    <span [style.width.%]="clampPercent(m.attendance_rate)"></span>
                  </div>
                  <strong>{{ m.events_attended }} / {{ m.events_total }}</strong>
                </div>
                <p class="mt-3 text-sm" style="color: var(--color-text-secondary)">
                  {{ m.attendance_rate | number: '1.0-0' }}% of guild events.
                  @if (m.attendance_streak > 0) {
                    Current streak: <strong>{{ m.attendance_streak }}</strong
                    >.
                  }
                </p>
                @if (m.next_event_title) {
                  <p class="mt-2 text-sm" style="color: var(--color-primary)">
                    Next: {{ m.next_event_title }}
                    <span style="color: var(--color-text-secondary)">
                      · {{ m.next_event_at | date: 'MMM d, HH:mm' }}
                    </span>
                  </p>
                } @else {
                  <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
                    Not signed up for anything upcoming.
                  </p>
                }
              }
            </article>

            <article class="surface p-5">
              <h2 class="profile__panel-title">Regear</h2>
              @if (userMetrics(); as m) {
                <div class="profile__bar-row">
                  <span>Monthly cap</span>
                  <div class="profile__bar profile__bar--fight">
                    <span [style.width.%]="regearCapPercent()"></span>
                  </div>
                  <strong
                    >{{ budget()?.per_month_used ?? 0 }} /
                    {{ budget()?.per_month_max ?? 0 }}</strong
                  >
                </div>
                <dl class="mt-3 grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt style="color: var(--color-text-secondary)">Claimed</dt>
                  <dd class="text-right">{{ m.regears_claimed }}</dd>
                  <dt style="color: var(--color-text-secondary)">Awaiting decision</dt>
                  <dd
                    class="text-right"
                    [style.color]="m.regears_pending > 0 ? 'var(--color-warning)' : null"
                  >
                    {{ m.regears_pending }}
                  </dd>
                  <dt style="color: var(--color-text-secondary)">Approved</dt>
                  <dd class="text-right" style="color: var(--color-success)">
                    {{ m.regears_approved }}
                  </dd>
                  <dt style="color: var(--color-text-secondary)">Reimbursed</dt>
                  <dd class="text-right">{{ formatAmount(m.regear_silver) }}</dd>
                </dl>
              }
            </article>

            <article class="surface p-5">
              <h2 class="profile__panel-title">Loot splits</h2>
              @if (userMetrics(); as m) {
                <dl class="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt style="color: var(--color-text-secondary)">Splits joined</dt>
                  <dd class="text-right">{{ m.splits_joined }}</dd>
                  <dt style="color: var(--color-text-secondary)">Total earned</dt>
                  <dd class="text-right" style="color: var(--color-success)">
                    {{ formatAmount(m.split_earnings) }}
                  </dd>
                  <dt style="color: var(--color-text-secondary)">Average per split</dt>
                  <dd class="text-right">{{ formatAmount(averageSplitShare()) }}</dd>
                </dl>
                <div class="profile__bar-row mt-4">
                  <span>Kills / deaths</span>
                  <div class="profile__bar profile__bar--fight">
                    <span [style.width.%]="killShare()"></span>
                  </div>
                  <strong>{{ m.kills }} / {{ m.deaths }}</strong>
                </div>
                <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
                  {{ m.battles_fought }} battles · {{ formatCompact(m.kill_fame) }} kill fame
                </p>
              }
            </article>
          </section>

          <section class="grid gap-4 xl:grid-cols-2">
            <article class="surface overflow-hidden">
              <header class="profile__section-header"><h2>Recent bank ledger</h2></header>
              <app-data-table
                [columns]="transactionColumns"
                [rows]="transactions()"
                [trackBy]="trackTransaction"
                [pageSize]="8"
              >
                <ng-template dataTableCell="amount" let-row>{{
                  formatAmount(row.amount)
                }}</ng-template>
                <ng-template dataTableCell="created_at" let-row>{{
                  formatDate(row.created_at)
                }}</ng-template>
              </app-data-table>
            </article>
            <article class="surface overflow-hidden">
              <header class="profile__section-header"><h2>Recent siphoned ledger</h2></header>
              <app-data-table
                [columns]="siphonedColumns"
                [rows]="siphonedEntries()"
                [trackBy]="trackSiphonedEntry"
                [pageSize]="8"
              >
                <ng-template dataTableCell="amount" let-row>{{
                  formatAmount(row.amount)
                }}</ng-template>
                <ng-template dataTableCell="occurred_at" let-row>{{
                  formatDate(row.occurred_at)
                }}</ng-template>
              </app-data-table>
            </article>
          </section>

          <article class="surface overflow-hidden">
            <header class="profile__section-header"><h2>My recent fights</h2></header>
            <app-data-table
              [columns]="battleColumns"
              [rows]="battles()"
              [trackBy]="trackBattle"
              [pageSize]="8"
            >
              <ng-template dataTableCell="start_time" let-row>{{
                formatDate(row.start_time)
              }}</ng-template>
              <ng-template dataTableCell="total_fame" let-row>{{
                formatCompact(row.total_fame)
              }}</ng-template>
            </app-data-table>
          </article>
        }

        <section class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section class="card p-6">
            <h2 class="profile__panel-title">Appearance</h2>
            <fieldset class="profile__option-list">
              @for (option of themeOptions; track option.value) {
                <label
                  class="profile__option"
                  [class.profile__option--active]="theme.preference() === option.value"
                >
                  <input
                    type="radio"
                    name="theme"
                    [checked]="theme.preference() === option.value"
                    (change)="onThemeChange(option.value)"
                  />
                  <span>{{ t(option.labelKey) }}</span>
                </label>
              }
            </fieldset>
          </section>
          <section class="card p-6">
            <h2 class="profile__panel-title">Language</h2>
            <fieldset class="profile__option-list">
              @for (lang of translate.supportedLanguages; track lang) {
                <label
                  class="profile__option"
                  [class.profile__option--active]="translate.language() === lang"
                >
                  <input
                    type="radio"
                    name="language"
                    [checked]="translate.language() === lang"
                    (change)="onLanguageChange(lang)"
                  />
                  <span>{{ translate.languageLabels[lang] }}</span>
                </label>
              }
            </fieldset>
          </section>
        </section>
      </app-page-stack>
    }
  `,
  styles: `
    @layer components {
      .profile__hero h1 {
        color: var(--color-text);
        font-family: var(--font-universalsansdisplay);
        font-size: clamp(1.75rem, 4vw, 2.5rem);
        font-weight: 400;
        letter-spacing: -0.025em;
        line-height: 1.1;
      }
      .profile__hero p {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        margin-top: 0.25rem;
      }
      .profile__eyebrow,
      .profile__label {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        font-size: 0.6875rem;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .profile__value {
        color: var(--color-text);
        font-family: var(--font-geistmono);
        font-size: clamp(1.2rem, 2vw, 1.5rem);
        font-weight: 400;
        letter-spacing: -0.01em;
      }
      .profile__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .profile__panel-title {
        color: var(--color-text);
        font-family: var(--font-universalsans);
        font-size: 0.875rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 1rem;
      }
      .profile__bar-row {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(7rem, 1fr) minmax(8rem, 2fr) auto;
        margin-top: 0.75rem;
      }
      .profile__bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.5rem;
        overflow: hidden;
      }
      .profile__bar span {
        background: var(--color-primary);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
      }
      .profile__bar--energy span {
        background: var(--color-warning);
      }
      .profile__bar--fight span {
        background: var(--color-success);
      }
      .profile__section-header {
        border-bottom: 1px solid var(--color-border);
        padding: 1rem;
      }
      .profile__section-header h2 {
        color: var(--color-text);
        font-weight: 600;
      }
      .profile__option-list {
        border: 0;
        display: grid;
        gap: 0.5rem;
        margin: 0;
        padding: 0;
      }
      .profile__option {
        align-items: center;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-inputs);
        color: var(--color-text);
        cursor: pointer;
        display: flex;
        gap: 0.75rem;
        padding: 0.75rem;
        transition:
          border-color 150ms ease,
          background-color 150ms ease;
      }
      .profile__option:hover {
        background: var(--color-surface-hover);
        border-color: var(--color-border-strong);
      }
      .profile__option--active {
        background: var(--color-surface-2);
        border-color: var(--color-text);
      }
    }
  `,
})
export class Settings {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly translate = inject(TranslateService);
  private readonly toasts = inject(ToastService);

  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly siphonedBalance = signal<SiphonedPlayerBalance | null>(null);
  protected readonly siphonedEntries = signal<SiphonedEntryView[]>([]);
  protected readonly battles = signal<BattleSummary[]>([]);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly userMetrics = signal<UserMetrics | null>(null);
  /** Regear cap usage, for the monthly progress bar. */
  protected readonly budget = signal<RegearBudgetSummary | null>(null);
  /** Season XP snapshot; null when the endpoint failed so the rest of the profile still renders. */
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly profile = this.auth.profile;

  protected readonly transactionColumns: readonly DataTableColumn<TransactionView>[] = [
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (row) => row.status,
      comparator: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'amount',
      label: 'common.amount',
      sortable: true,
      accessor: (row) => row.amount,
      comparator: (a, b) => a.amount - b.amount,
      align: 'right',
    },
    {
      key: 'reason',
      label: 'common.description',
      searchable: true,
      accessor: (row) => row.reason ?? '',
      comparator: (a, b) => (a.reason ?? '').localeCompare(b.reason ?? ''),
    },
    {
      key: 'created_at',
      label: 'common.date',
      sortable: true,
      accessor: (row) => row.created_at,
      comparator: (a, b) => a.created_at.localeCompare(b.created_at),
    },
  ];
  protected readonly siphonedColumns: readonly DataTableColumn<SiphonedEntryView>[] = [
    {
      key: 'occurred_at',
      label: 'common.date',
      sortable: true,
      accessor: (row) => row.occurred_at,
      comparator: (a, b) => a.occurred_at.localeCompare(b.occurred_at),
    },
    {
      key: 'reason',
      label: 'common.description',
      sortable: true,
      accessor: (row) => row.reason,
      comparator: (a, b) => a.reason.localeCompare(b.reason),
    },
    {
      key: 'amount',
      label: 'common.amount',
      sortable: true,
      accessor: (row) => row.amount,
      comparator: (a, b) => a.amount - b.amount,
      align: 'right',
    },
  ];
  protected readonly battleColumns: readonly DataTableColumn<BattleSummary>[] = [
    {
      key: 'battle_id',
      label: 'events.detail.open_battle',
      sortable: true,
      accessor: (row) => row.battle_id,
      comparator: (a, b) => a.battle_id - b.battle_id,
    },
    {
      key: 'start_time',
      label: 'common.date',
      sortable: true,
      accessor: (row) => row.start_time,
      comparator: (a, b) => a.start_time.localeCompare(b.start_time),
    },
    {
      key: 'total_players',
      label: 'battles.players',
      sortable: true,
      accessor: (row) => row.total_players,
      comparator: (a, b) => a.total_players - b.total_players,
      align: 'right',
    },
    {
      key: 'total_kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (row) => row.total_kills,
      comparator: (a, b) => a.total_kills - b.total_kills,
      align: 'right',
    },
    {
      key: 'total_fame',
      label: 'battles.fame',
      sortable: true,
      accessor: (row) => row.total_fame,
      comparator: (a, b) => a.total_fame - b.total_fame,
      align: 'right',
    },
  ];

  /** Clamps a percentage into the 0-100 a progress bar can render. */
  protected clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  /** How much of the monthly regear allowance is spent. */
  protected regearCapPercent(): number {
    const budget = this.budget();
    if (!budget || budget.per_month_max <= 0) {
      return 0;
    }
    return this.clampPercent((budget.per_month_used / budget.per_month_max) * 100);
  }

  /** Mean payout per split joined; zero when the member has joined none. */
  protected averageSplitShare(): number {
    const m = this.userMetrics();
    if (!m || m.splits_joined <= 0) {
      return 0;
    }
    return Math.round(m.split_earnings / m.splits_joined);
  }

  /** Kills as a share of kills plus deaths, for the ratio bar. */
  protected killShare(): number {
    const m = this.userMetrics();
    const total = (m?.kills ?? 0) + (m?.deaths ?? 0);
    return total === 0 ? 0 : this.clampPercent(((m?.kills ?? 0) / total) * 100);
  }

  protected readonly profileMetrics = computed<ProfileMetric[]>(() => {
    const balance = this.balance();
    const siphoned = this.siphonedBalance();
    const battleRows = this.battles();
    const userMetrics = this.userMetrics();

    return [
      {
        label: 'Pending silver',
        value: this.formatAmount(balance?.pending_total ?? 0),
        sub: `${balance?.pending_count ?? 0} rows`,
      },
      {
        label: 'Requested silver',
        value: this.formatAmount(balance?.requested_total ?? 0),
        sub: `${balance?.requested_count ?? 0} rows`,
      },
      {
        label: 'Total earned',
        value: this.formatAmount(this.withdrawnTotal()),
        sub: `${this.withdrawnCount()} tx paid out`,
      },
      {
        label: 'Siphoned net',
        value: this.formatAmount(siphoned?.net ?? 0),
        sub: `${siphoned?.entry_count ?? 0} entries`,
      },
      { label: 'Siphoned withdrawn', value: this.formatAmount(siphoned?.total_withdrawn ?? 0) },
      { label: 'Tracked fights', value: String(battleRows.length) },
      {
        label: 'Fight fame',
        value: this.formatCompact(battleRows.reduce((sum, battle) => sum + battle.total_fame, 0)),
      },
      {
        label: 'Events attended',
        value: String(userMetrics?.events_attended ?? 0),
      },
      {
        label: 'Most played build',
        value: userMetrics?.most_played_build || 'N/A',
      },
      {
        label: 'Total estimated loss',
        value: this.formatAmount(userMetrics?.total_estimated_loss ?? 0),
      },
      {
        label: 'Top estimated loss',
        value: this.formatAmount(userMetrics?.top_estimated_loss ?? 0),
      },
    ];
  });
  protected readonly bankChart = computed<ProfileChartMetric[]>(() => [
    { label: 'Pending', value: Number(this.balance()?.pending_total ?? 0) },
    { label: 'Requested', value: Number(this.balance()?.requested_total ?? 0) },
  ]);
  protected readonly siphonedChart = computed<ProfileChartMetric[]>(() => [
    { label: 'Deposited', value: Number(this.siphonedBalance()?.total_deposited ?? 0) },
    { label: 'Withdrawn', value: Number(this.siphonedBalance()?.total_withdrawn ?? 0) },
    { label: 'Debt', value: Math.abs(Math.min(0, Number(this.siphonedBalance()?.net ?? 0))) },
  ]);
  protected readonly battleChart = computed<ProfileChartMetric[]>(() => [
    { label: 'Battles', value: this.battles().length },
    { label: 'Kills', value: this.battles().reduce((sum, battle) => sum + battle.total_kills, 0) },
    { label: 'Fame', value: this.battles().reduce((sum, battle) => sum + battle.total_fame, 0) },
  ]);

  protected readonly trackTransaction = (row: TransactionView): unknown => row.id;
  protected readonly trackSiphonedEntry = (row: SiphonedEntryView): unknown => row.id;
  protected readonly trackBattle = (row: BattleSummary): unknown => row.battle_id;
  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly themeOptions: ReadonlyArray<{
    value: ThemePreference;
    labelKey: TranslationKey;
  }> = [
    { value: 'light', labelKey: 'theme.light' },
    { value: 'dark', labelKey: 'theme.dark' },
    { value: 'system', labelKey: 'theme.system' },
  ];

  constructor() {
    void this.load();
  }

  protected displayName(): string {
    return this.profile()?.username ?? 'Profile';
  }

  protected formatAmount(value: number | string): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  /** Sum of every `withdrawn` transaction — the silver the bank actually paid out to this member. */
  protected withdrawnTotal(): number {
    return this.transactions()
      .filter((tx) => tx.status === 'withdrawn')
      .reduce((sum, tx) => sum + Number(tx.amount), 0);
  }

  /** Number of `withdrawn` transactions on the member's ledger. */
  protected withdrawnCount(): number {
    return this.transactions().filter((tx) => tx.status === 'withdrawn').length;
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected chartPercent(value: number, rows: readonly ProfileChartMetric[]): number {
    const maxValue = Math.max(...rows.map((row) => row.value), 0);
    if (maxValue <= 0) return 0;
    return Math.max(4, Math.round((value / maxValue) * 100));
  }

  protected onThemeChange(value: ThemePreference): void {
    this.theme.setPreference(value);
    this.toasts.success(
      this.t(value === 'light' ? 'theme.light' : value === 'dark' ? 'theme.dark' : 'theme.system'),
    );
  }

  protected onLanguageChange(value: Language): void {
    this.translate.use(value);
    this.toasts.success(this.translate.languageLabels[value]);
  }

  /** XP bar fill: current / (current + remaining). Full when already at cap. */
  protected progressionBarPercent(xp: ProgressionMeView): number {
    const total = xp.xp + xp.xp_to_next;
    if (total <= 0) {
      return xp.xp > 0 ? 100 : 0;
    }
    return this.clampPercent((xp.xp / total) * 100);
  }

  /** Hide the multiplier chip when the account is running at the default 1×. */
  protected showMultiplier(value: string | number): boolean {
    return Math.abs(Number(value) - 1) > 1e-9;
  }

  protected formatMultiplier(value: string | number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return String(value);
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [balance, transactions, albionLink, battles, metrics, budget, progression] =
        await Promise.all([
          firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance')),
          firstValueFrom(
            this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', {
              page: 1,
              limit: 50,
            }),
          ),
          firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me')),
          firstValueFrom(
            this.api.get<PaginatedData<BattleSummary>>('api/battles/me', { page: 1, limit: 50 }),
          ).catch(() => emptyPaginatedBattles()),
          firstValueFrom(this.api.get<UserMetrics>('api/users/me/metrics')).catch(() => null),
          // Members without `regear.view` simply see no cap bar, rather than
          // the whole profile failing on a permission they do not need.
          firstValueFrom(this.api.get<RegearBudgetSummary>('api/regear/me/summary')).catch(
            () => null,
          ),
          firstValueFrom(this.api.get<ProgressionMeView>('api/progression/me')).catch(() => null),
        ]);
      this.balance.set(balance);
      this.transactions.set(transactions.items);
      this.albionLink.set(albionLink);
      this.battles.set(battles.items);
      this.userMetrics.set(metrics);
      this.budget.set(budget);
      this.progression.set(progression);
      await this.loadSiphoned(albionLink.albion_player_name ?? this.profile()?.username ?? '');
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSiphoned(playerName: string): Promise<void> {
    if (!playerName || !this.auth.hasPermission('siphoned.view')) {
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.get<{ balance: SiphonedPlayerBalance; recent_entries: SiphonedEntryView[] }>(
          `api/siphoned/balances/${encodeURIComponent(playerName)}`,
          { recent: 50 },
        ),
      );
      this.siphonedBalance.set(detail.balance);
      this.siphonedEntries.set(detail.recent_entries);
    } catch {
      this.siphonedBalance.set(null);
      this.siphonedEntries.set([]);
    }
  }
}
