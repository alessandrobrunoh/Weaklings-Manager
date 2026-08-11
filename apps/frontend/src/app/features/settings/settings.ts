import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  BalanceSummary,
  BattleSummary,
  PaginatedData,
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
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
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
  imports: [PageHeader, Loading, DataTable],
  template: `
    <app-page-header title="Profile" subtitle="Your account, economy and fight performance." />

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else {
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

      <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
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

      <section class="mt-5 grid gap-4 xl:grid-cols-3">
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

      <section class="mt-5 grid gap-4 xl:grid-cols-2">
        <article class="surface overflow-hidden">
          <header class="profile__section-header"><h2>Recent bank ledger</h2></header>
          <app-data-table
            [columns]="transactionColumns"
            [rows]="transactions()"
            [trackBy]="trackTransaction"
            [pageSize]="8"
          >
            <ng-template dataTableCell="amount" let-row>{{ formatAmount(row.amount) }}</ng-template>
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
            <ng-template dataTableCell="amount" let-row>{{ formatAmount(row.amount) }}</ng-template>
            <ng-template dataTableCell="occurred_at" let-row>{{
              formatDate(row.occurred_at)
            }}</ng-template>
          </app-data-table>
        </article>
      </section>

      <article class="mt-5 surface overflow-hidden">
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

      <section class="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
    }
  `,
  styles: `
    @layer components {
      .profile__hero h1 {
        color: var(--color-text);
        font-size: clamp(1.75rem, 4vw, 3rem);
        font-weight: 800;
      }
      .profile__hero p {
        color: var(--color-text-secondary);
        margin-top: 0.25rem;
      }
      .profile__eyebrow,
      .profile__label {
        color: var(--color-text-disabled);
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .profile__value {
        color: var(--color-text);
        font-size: clamp(1.2rem, 2vw, 1.6rem);
        font-weight: 800;
      }
      .profile__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .profile__panel-title {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
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
        height: 0.7rem;
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
        font-weight: 700;
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
        border-radius: var(--radius-md);
        color: var(--color-text);
        cursor: pointer;
        display: flex;
        gap: 0.75rem;
        padding: 0.75rem;
      }
      .profile__option--active {
        background: var(--color-primary-container);
        border-color: var(--color-primary);
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
  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly siphonedBalance = signal<SiphonedPlayerBalance | null>(null);
  protected readonly siphonedEntries = signal<SiphonedEntryView[]>([]);
  protected readonly battles = signal<BattleSummary[]>([]);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly userMetrics = signal<UserMetrics | null>(null);
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

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [balance, transactions, albionLink, battles, metrics] = await Promise.all([
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
      ]);
      this.balance.set(balance);
      this.transactions.set(transactions.items);
      this.albionLink.set(albionLink);
      this.battles.set(battles.items);
      this.userMetrics.set(metrics);
      await this.loadSiphoned(albionLink.albion_player_name ?? this.profile()?.username ?? '');
    } catch (error) {
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
