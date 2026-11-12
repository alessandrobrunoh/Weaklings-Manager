import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  AlbionPlayer,
  AlbionSearchResult,
  BalanceSummary,
  BattleSummary,
  PaginatedData,
  ProgressionMeView,
  RegearBudgetSummary,
  Role,
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
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { WeaponRoster } from '../../shared/components/weapon-roster/weapon-roster';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect, type SearchableSelectOption } from '../../shared/components/searchable-select/searchable-select';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type ProfileTab = 'overview' | 'weapons' | 'ledgers' | 'battles' | 'settings';

/** Debounce for the Albion player lookup while the officer types. */
const PLAYER_SEARCH_DELAY_MS = 300;

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
 * Personal profile and settings workspace.
 *
 * Overview shows season progression and activity; Weapons, Ledger and Battles hold the member's
 * records. Settings groups the account details (read only), the Albion character link, and the
 * device preferences (theme and language), each with its own heading and a note on where it is
 * saved.
 */
@Component({
  selector: 'app-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    COMPACT_FEATURE_STYLES,
    `
      .settings-stack {
        display: grid;
        gap: 1rem;
        max-width: 48rem;
      }
      .settings-list {
        display: grid;
        gap: 0.5rem 1rem;
        margin: 0;
      }
      .settings-list__row {
        display: grid;
        gap: 0.125rem;
      }
      .settings-list__row dt {
        font-size: var(--ui-text-xs);
        font-weight: 600;
        color: var(--color-text-secondary);
      }
      .settings-list__row dd {
        margin: 0;
        font-size: var(--ui-text-sm);
        color: var(--color-text);
        overflow-wrap: anywhere;
      }
      @media (min-width: 40rem) {
        .settings-list__row {
          grid-template-columns: 10rem 1fr;
          align-items: baseline;
        }
      }
      .settings-field {
        display: grid;
        gap: 0.375rem;
      }
      .settings-select {
        max-width: 16rem;
      }
    `,
  ],
  imports: [
    DecimalPipe,
    DataTable,
    DataTableCell,
    WeaponRoster,
    Dialog,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    Select,
    StatusChip,
    Stat,
    SummaryBand,
    Tabs,
  ],
  template: `
    <app-page-header [title]="t('nav.profile')" [subtitle]="t('profile.subtitle')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="load()">
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      <app-tabs
        pageTabs
        [options]="tabs()"
        [active]="activeTab()"
        (activeChange)="onTabChange($event)"
      />
    </app-page-header>

    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    } @else {
      <app-page-stack>
        <!-- MY WEAPONS -->
        @if (activeTab() === 'weapons') {
          <app-weapon-roster mode="self" />
        }

        <!-- OVERVIEW: season progression and activity -->
        @if (activeTab() === 'overview') {
          @if (progression(); as xp) {
            <section class="card p-5" aria-labelledby="profile-xp-title">
              <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 class="section-title" id="profile-xp-title">{{ t('profile.xp.title') }}</h2>
                  <p class="hint mt-1">{{ xp.season?.name || t('profile.xp.noSeason') }}</p>
                </div>
                @if (showMultiplier(xp.multiplier)) {
                  <span class="chip chip--warning num">
                    {{ t('profile.xp.multiplier') }}: ×{{ formatMultiplier(xp.multiplier) }}
                  </span>
                }
              </div>

              <app-summary-band [ariaLabel]="t('profile.xp.title')">
                <app-stat [label]="t('profile.xp.level')" [value]="xp.level" />
                <app-stat [label]="t('profile.xp.xp')" [value]="formatAmount(xp.xp)" />
                <app-stat
                  [label]="t('profile.xp.rank')"
                  [value]="xp.rank != null ? '#' + xp.rank : t('profile.xp.unranked')"
                />
                <app-stat [label]="t('profile.xp.lifetime')" [value]="formatAmount(xp.lifetime_xp)" />
              </app-summary-band>

              <div class="mt-4">
                <div class="mb-1.5 flex items-center justify-between gap-2 text-xs">
                  <span class="hint">{{ t('profile.xp.toNext') }}</span>
                  <span class="num font-semibold" style="color: var(--color-text)">
                    {{ formatAmount(xp.xp) }} / {{ formatAmount(xp.xp + xp.xp_to_next) }}
                  </span>
                </div>
                <div
                  class="h-2 overflow-hidden rounded-full"
                  style="background: var(--color-surface-2)"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="progressionBarPercent(xp)"
                  [attr.aria-label]="t('profile.xp.toNext')"
                >
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    style="background: var(--color-primary)"
                    [style.width.%]="progressionBarPercent(xp)"
                  ></div>
                </div>
              </div>
            </section>
          }

          <section class="grid gap-4 md:grid-cols-3">
            <!-- Attendance -->
            <section class="card p-5" aria-labelledby="profile-attendance-title">
              <h2 class="section-title section-title--sm mb-3" id="profile-attendance-title">
                {{ t('settings.presence.title') }}
              </h2>
              @if (userMetrics(); as m) {
                <div class="mb-2 flex items-baseline justify-between gap-2">
                  <span class="num text-2xl font-semibold" style="color: var(--color-text)">
                    {{ m.attendance_rate | number: '1.0-0' }}%
                  </span>
                  <span class="hint">
                    {{ t('settings.presence.eventsCount', { attended: m.events_attended, total: m.events_total }) }}
                  </span>
                </div>
                <div
                  class="mb-3 h-1.5 overflow-hidden rounded-full"
                  style="background: var(--color-surface-2)"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="clampPercent(m.attendance_rate)"
                  [attr.aria-label]="t('settings.presence.title')"
                >
                  <div
                    class="h-full rounded-full"
                    style="background: var(--color-primary)"
                    [style.width.%]="clampPercent(m.attendance_rate)"
                  ></div>
                </div>
                @if (m.attendance_streak > 0) {
                  <p class="hint">{{ t('settings.presence.streak', { count: m.attendance_streak }) }}</p>
                }
                @if (m.next_event_title) {
                  <p class="mt-2 text-xs" style="color: var(--color-primary)">
                    {{ t('settings.presence.next', { title: m.next_event_title }) }}
                  </p>
                }
              }
            </section>

            <!-- Regear -->
            <section class="card p-5" aria-labelledby="profile-regear-title">
              <h2 class="section-title section-title--sm mb-3" id="profile-regear-title">
                {{ t('regears.title') }}
              </h2>
              @if (userMetrics(); as m) {
                <div class="mb-1 flex items-baseline justify-between gap-2">
                  <span class="num text-lg font-semibold" style="color: var(--color-text)">
                    {{ budget()?.weekly_balance ?? 0 }} / {{ budget()?.weekly_cap ?? 0 }}
                  </span>
                  <span class="hint">{{ t('regears.budget.weekly') }}</span>
                </div>
                <div
                  class="mb-3 h-1.5 overflow-hidden rounded-full"
                  style="background: var(--color-surface-2)"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="regearWeeklyPercent()"
                  [attr.aria-label]="t('regears.budget.weekly')"
                >
                  <div
                    class="h-full rounded-full"
                    style="background: var(--color-warning)"
                    [style.width.%]="regearWeeklyPercent()"
                  ></div>
                </div>
                <div class="mb-1 flex items-baseline justify-between gap-2">
                  <span class="num text-lg font-semibold" style="color: var(--color-text)">
                    {{ budget()?.bonus_balance ?? 0 }} / {{ budget()?.bonus_cap ?? 0 }}
                  </span>
                  <span class="hint">{{ t('regears.budget.bonus') }}</span>
                </div>
                <div
                  class="mb-3 h-1.5 overflow-hidden rounded-full"
                  style="background: var(--color-surface-2)"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuenow]="regearBonusPercent()"
                  [attr.aria-label]="t('regears.budget.bonus')"
                >
                  <div
                    class="h-full rounded-full"
                    style="background: var(--color-success)"
                    [style.width.%]="regearBonusPercent()"
                  ></div>
                </div>
                <div class="hint grid grid-cols-2 gap-1">
                  <span>{{ t('regears.status.approved') }}: <strong>{{ m.regears_approved }}</strong></span>
                  <span>{{ t('regears.status.pending') }}: <strong>{{ m.regears_pending }}</strong></span>
                  <span class="col-span-2 mt-1">
                    {{ t('regears.stat.totalReimbursed') }}:
                    <strong style="color: var(--color-success)">{{ formatAmount(m.regear_silver) }}</strong>
                  </span>
                </div>
              }
            </section>

            <!-- Loot splits -->
            <section class="card p-5" aria-labelledby="profile-splits-title">
              <h2 class="section-title section-title--sm mb-3" id="profile-splits-title">
                {{ t('splits.title') }}
              </h2>
              @if (userMetrics(); as m) {
                <p class="hint">{{ t('intel.splitEarnings') }}</p>
                <p class="num mb-3 text-2xl font-semibold" style="color: var(--color-success)">
                  {{ formatAmount(m.split_earnings) }}
                </p>
                <div class="hint grid grid-cols-2 gap-1 border-t pt-3" style="border-color: var(--color-border)">
                  <span>{{ t('splits.participants') }}: <strong>{{ m.splits_joined }}</strong></span>
                  <span>{{ t('settings.splits.average') }}: <strong>{{ formatAmount(averageSplitShare()) }}</strong></span>
                  <span class="col-span-2 mt-1">
                    K/D: <strong>{{ m.kills }}K / {{ m.deaths }}D</strong> ({{ formatCompact(m.kill_fame) }} fame)
                  </span>
                </div>
              }
            </section>
          </section>
        }

        <!-- LEDGER & BANK -->
        @if (activeTab() === 'ledgers') {
          <app-summary-band [ariaLabel]="t('settings.ledger.summary')">
            <app-stat [label]="t('bank.balance.pending')" [value]="formatAmount(balance()?.pending_total ?? 0)" />
            <app-stat [label]="t('bank.balance.requested')" [value]="formatAmount(balance()?.requested_total ?? 0)" />
            <app-stat [label]="t('bank.finance.paidOut')" [value]="formatAmount(withdrawnTotal())" />
            <app-stat [label]="t('bank.finance.siphonedNet')" [value]="formatAmount(siphonedBalance()?.net ?? 0)" />
          </app-summary-band>

          <section class="grid gap-4 lg:grid-cols-2">
            <section class="card overflow-hidden p-0" aria-labelledby="profile-transactions-title">
              <div class="border-b p-4" style="border-color: var(--color-border)">
                <h2 class="section-title section-title--sm" id="profile-transactions-title">
                  {{ t('bank.transactions.title') }}
                </h2>
              </div>
              <app-data-table
                [columns]="transactionColumns"
                [rows]="transactions()"
                [trackBy]="trackTransaction"
                [pageSize]="10"
              >
                <ng-template dataTableCell="status" let-row>
                  <app-status-chip [value]="row.status" />
                </ng-template>
                <ng-template dataTableCell="amount" let-row>
                  <span class="num font-semibold" style="color: var(--color-success)">
                    {{ formatAmount(row.amount) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="created_at" let-row>
                  <span class="hint">{{ formatDate(row.created_at) }}</span>
                </ng-template>
              </app-data-table>
            </section>

            <section class="card overflow-hidden p-0" aria-labelledby="profile-siphoned-title">
              <div class="border-b p-4" style="border-color: var(--color-border)">
                <h2 class="section-title section-title--sm" id="profile-siphoned-title">
                  {{ t('siphoned.title') }}
                </h2>
              </div>
              <app-data-table
                [columns]="siphonedColumns"
                [rows]="siphonedEntries()"
                [trackBy]="trackSiphonedEntry"
                [pageSize]="10"
              >
                <ng-template dataTableCell="amount" let-row>
                  <span class="num font-semibold" [style.color]="row.amount >= 0 ? 'var(--color-success)' : 'var(--color-error)'">
                    {{ formatAmount(row.amount) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="occurred_at" let-row>
                  <span class="hint">{{ formatDate(row.occurred_at) }}</span>
                </ng-template>
              </app-data-table>
            </section>
          </section>
        }

        <!-- BATTLES -->
        @if (activeTab() === 'battles') {
          <section class="card overflow-hidden p-0" aria-labelledby="profile-battles-title">
            <div class="flex items-center justify-between gap-2 border-b p-4" style="border-color: var(--color-border)">
              <h2 class="section-title section-title--sm" id="profile-battles-title">
                {{ t('profile.battles.title') }}
              </h2>
              <span class="chip num">{{ t('profile.battles.recorded', { count: battles().length }) }}</span>
            </div>
            <app-data-table
              [columns]="battleColumns"
              [rows]="battles()"
              [trackBy]="trackBattle"
              [pageSize]="10"
            >
              <ng-template dataTableCell="battle_id" let-row>
                <a
                  [routerLink]="['/battles', row.battle_id]"
                  class="btn btn--tonal btn--sm num px-2 py-1 text-xs"
                >
                  #{{ row.battle_id }}
                </a>
              </ng-template>
              <ng-template dataTableCell="start_time" let-row>
                <span class="hint">{{ formatDate(row.start_time) }}</span>
              </ng-template>
              <ng-template dataTableCell="total_fame" let-row>
                <span class="num font-semibold" style="color: var(--color-warning)">
                  {{ formatCompact(row.total_fame) }}
                </span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <!-- SETTINGS -->
        @if (activeTab() === 'settings') {
          <div class="settings-stack">
            <!-- Profile: read only -->
            <section class="card p-5" aria-labelledby="settings-profile-title">
              <h2 class="section-title section-title--sm" id="settings-profile-title">
                {{ t('settings.profile.title') }}
              </h2>
              <p class="hint mt-1 mb-3">{{ t('settings.profile.hint') }}</p>
              <dl class="settings-list">
                <div class="settings-list__row">
                  <dt>{{ t('common.username') }}</dt>
                  <dd>{{ profile()?.username }}</dd>
                </div>
                <div class="settings-list__row">
                  <dt>{{ t('common.email') }}</dt>
                  <dd>{{ profile()?.email || t('common.noEmail') }}</dd>
                </div>
                <div class="settings-list__row">
                  <dt>{{ t('common.role') }}</dt>
                  <dd>
                    <span [class]="roleChip(profile()?.highest_role)">
                      {{ profile()?.highest_role || 'User' }}
                    </span>
                  </dd>
                </div>
                <div class="settings-list__row">
                  <dt>{{ t('settings.profile.userId') }}</dt>
                  <dd class="num">{{ profile()?.id }}</dd>
                </div>
              </dl>
            </section>

            <!-- Albion character -->
            <section class="card p-5" aria-labelledby="settings-albion-title">
              <h2 class="section-title section-title--sm" id="settings-albion-title">
                {{ t('settings.albion.sectionTitle') }}
              </h2>
              <p class="hint mt-1 mb-3">{{ t('settings.albion.sectionHint') }}</p>

              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  @if (albionLink()?.linked) {
                    <app-status-chip value="linked" toneOverride="success" [label]="t('settings.albion.linked')" />
                  } @else {
                    <app-status-chip value="not_linked" toneOverride="warning" [label]="t('albion.not_linked')" />
                  }
                  <span class="num min-w-0 truncate font-semibold" style="color: var(--color-text)">
                    {{ albionLinked() ? albionLinkLabel() : '' }}
                  </span>
                </div>

                @if (albionLinked()) {
                  <button type="button" class="btn btn--outline btn--sm" (click)="unlinkConfirmOpen.set(true)">
                    {{ t('albion.unlink') }}
                  </button>
                } @else {
                  <button type="button" class="btn btn--primary btn--sm" (click)="openLinkDialog()">
                    <app-icon name="plus" size="0.75rem" />
                    {{ t('dashboard.attention.link_albion_action') }}
                  </button>
                }
              </div>
            </section>

            <!-- Appearance -->
            <section class="card p-5" aria-labelledby="settings-appearance-title">
              <h2 class="section-title section-title--sm" id="settings-appearance-title">
                {{ t('settings.appearance') }}
              </h2>
              <p class="hint mt-1 mb-3">{{ t('settings.appearance.hint') }}</p>
              <app-tabs
                variant="segmented"
                [ariaLabel]="t('settings.appearance')"
                [options]="themeTabs()"
                [active]="theme.preference()"
                (activeChange)="onThemeChange($event)"
              />
            </section>

            <!-- Language -->
            <section class="card p-5" aria-labelledby="settings-language-title">
              <div class="settings-field">
                <h2 class="section-title section-title--sm" id="settings-language-title">
                  {{ t('language.label') }}
                </h2>
                <p class="hint">{{ t('settings.language.hint') }}</p>
                <div class="settings-select">
                  <app-select
                    [options]="languageOptions"
                    [value]="translate.language()"
                    ariaLabelledBy="settings-language-title"
                    (valueChange)="onLanguageChange($event)"
                  />
                </div>
              </div>
            </section>
          </div>
        }
      </app-page-stack>
    }

    <!-- Link Albion character dialog -->
    @if (linkDialogOpen()) {
      <app-dialog [title]="t('albion.required.title')" (closed)="closeLinkDialog()">
        <div class="settings-field">
          <p class="label" id="albion-link-label">{{ t('settings.albion.searchLabel') }}</p>
          <app-searchable-select
            [options]="playerOptions()"
            [remote]="true"
            [loading]="playerSearchLoading()"
            [allowEmpty]="false"
            [emptyLabel]="t('settings.albion.searchPlaceholder')"
            [searchPlaceholder]="t('settings.albion.searchPlaceholder')"
            [emptyOptionsLabel]="playerSearchDone() ? t('settings.albion.noPlayers') : t('settings.albion.typeToSearch')"
            [noMatchesLabel]="t('settings.albion.noPlayers')"
            [disabled]="savingLink()"
            [ariaLabel]="t('settings.albion.searchLabel')"
            (searchChange)="onPlayerSearch($event)"
            (valueChange)="onPlayerPicked($event)"
          />
          <p class="hint">{{ t('settings.albion.searchHint') }}</p>
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeLinkDialog()">
            {{ t('common.cancel') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Unlink confirmation dialog -->
    @if (unlinkConfirmOpen()) {
      <app-dialog [title]="t('settings.albion.unlinkConfirmTitle')" (closed)="unlinkConfirmOpen.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('settings.albion.unlinkConfirmBody', { name: albionLink()?.albion_player_name ?? '' }) }}
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="unlinkConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger btn--sm" (click)="confirmUnlink()" [disabled]="savingLink()">
            {{ t('settings.albion.unlinkConfirmTitle') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Settings {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  protected readonly theme = inject(ThemeService);
  protected readonly translate = inject(TranslateService);
  private readonly toasts = inject(ToastService);

  protected readonly activeTab = signal<ProfileTab>('overview');
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly siphonedBalance = signal<SiphonedPlayerBalance | null>(null);
  protected readonly siphonedEntries = signal<SiphonedEntryView[]>([]);
  protected readonly battles = signal<BattleSummary[]>([]);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly albionLinked = computed(() => this.albionLink()?.linked === true);
  protected readonly albionLinkLabel = computed(() => {
    const link = this.albionLink();
    if (link?.linked) return link.albion_player_name ?? '';
    return this.t('albion.not_linked');
  });
  protected readonly userMetrics = signal<UserMetrics | null>(null);
  protected readonly budget = signal<RegearBudgetSummary | null>(null);
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly profile = this.auth.profile;

  // Albion link state
  protected readonly linkDialogOpen = signal(false);
  protected readonly unlinkConfirmOpen = signal(false);
  protected readonly playerSearchLoading = signal(false);
  protected readonly playerSearchDone = signal(false);
  protected readonly savingLink = signal(false);
  protected readonly playerSearchResults = signal<AlbionPlayer[]>([]);
  protected readonly playerOptions = computed<SearchableSelectOption[]>(() =>
    this.playerSearchResults().map((player) => ({
      id: player.id,
      label: player.name,
      hint: player.guild_name ?? this.t('albionSettings.lookup.noGuild'),
    })),
  );
  private playerSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private playerSearchSeq = 0;

  protected readonly tabs = computed<readonly TabOption[]>(() => [
    { id: 'overview', label: this.t('profile.tab.overview'), icon: 'trophy' },
    { id: 'weapons', label: this.t('weapons.tab'), icon: 'swords' },
    { id: 'ledgers', label: this.t('profile.tab.ledgers'), icon: 'bank' },
    { id: 'battles', label: this.t('profile.tab.battles'), icon: 'shield' },
    { id: 'settings', label: this.t('settings.title'), icon: 'sparkles' },
  ]);

  protected readonly themeTabs = computed<readonly TabOption[]>(() => [
    { id: 'light', label: this.t('theme.light') },
    { id: 'dark', label: this.t('theme.dark') },
    { id: 'system', label: this.t('theme.system') },
  ]);

  protected readonly languageOptions: readonly SelectOption[] = this.translate.supportedLanguages.map(
    (language) => ({ value: language, label: this.translate.languageLabels[language] }),
  );

  protected onTabChange(id: string): void {
    this.activeTab.set(id as ProfileTab);
  }

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
      key: 'type',
      label: 'common.description',
      searchable: true,
      accessor: (row) => row.type,
      comparator: (a, b) => a.type.localeCompare(b.type),
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

  protected readonly trackTransaction = (row: TransactionView): unknown => row.id;
  protected readonly trackSiphonedEntry = (row: SiphonedEntryView): unknown => row.id;
  protected readonly trackBattle = (row: BattleSummary): unknown => row.battle_id;
  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.playerSearchTimer));
    void this.load();
    // Deep link from the event signup dialog: `/profile?tab=weapons` opens "My weapons".
    if (this.route.snapshot.queryParamMap.get('tab') === 'weapons') {
      this.onTabChange('weapons');
    }
  }

  protected roleChip(role?: Role | string): string {
    if (role === 'SuperAdmin') return 'chip chip--error';
    if (role === 'Admin') return 'chip chip--warning';
    if (role === 'Officer') return 'chip chip--success';
    return 'chip';
  }

  protected formatAmount(value: number | string): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  protected withdrawnTotal(): number {
    return this.transactions()
      .filter((tx) => tx.status === 'withdrawn')
      .reduce((sum, tx) => sum + Number(tx.amount), 0);
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  protected regearWeeklyPercent(): number {
    const budget = this.budget();
    if (!budget || budget.weekly_cap <= 0) return 0;
    return this.clampPercent((budget.weekly_balance / budget.weekly_cap) * 100);
  }

  protected regearBonusPercent(): number {
    const budget = this.budget();
    if (!budget || budget.bonus_cap <= 0) return 0;
    return this.clampPercent((budget.bonus_balance / budget.bonus_cap) * 100);
  }

  protected averageSplitShare(): number {
    const m = this.userMetrics();
    if (!m || m.splits_joined <= 0) return 0;
    return Math.round(m.split_earnings / m.splits_joined);
  }

  protected onThemeChange(value: string): void {
    const preference = value as ThemePreference;
    this.theme.setPreference(preference);
    this.toasts.success(
      this.t(
        preference === 'light' ? 'theme.light' : preference === 'dark' ? 'theme.dark' : 'theme.system',
      ),
    );
  }

  protected onLanguageChange(value: string): void {
    const language = value as Language;
    this.translate.use(language);
    this.toasts.success(this.translate.languageLabels[language]);
  }

  protected progressionBarPercent(xp: ProgressionMeView): number {
    const total = xp.xp + xp.xp_to_next;
    if (total <= 0) return xp.xp > 0 ? 100 : 0;
    return this.clampPercent((xp.xp / total) * 100);
  }

  protected showMultiplier(value: string | number): boolean {
    return Math.abs(Number(value) - 1) > 1e-9;
  }

  protected formatMultiplier(value: string | number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  protected openLinkDialog(): void {
    this.linkDialogOpen.set(true);
    this.resetPlayerSearch();
  }

  protected closeLinkDialog(): void {
    this.linkDialogOpen.set(false);
    this.resetPlayerSearch();
  }

  /** Called on every keystroke of the lookup; searches once the text is long enough, debounced. */
  protected onPlayerSearch(query: string): void {
    clearTimeout(this.playerSearchTimer);
    const q = query.trim();
    if (q.length < 2) {
      this.resetPlayerSearch();
      return;
    }
    this.playerSearchTimer = setTimeout(() => void this.runPlayerSearch(q), PLAYER_SEARCH_DELAY_MS);
  }

  /** Picking a result links that character, the same action as before the lookup became a list. */
  protected onPlayerPicked(id: string): void {
    const player = this.playerSearchResults().find((candidate) => candidate.id === id);
    if (player) void this.confirmLink(player);
  }

  private async runPlayerSearch(q: string): Promise<void> {
    const seq = ++this.playerSearchSeq;
    this.playerSearchLoading.set(true);
    this.playerSearchDone.set(false);
    try {
      const result = await firstValueFrom(
        this.api.get<AlbionSearchResult>('api/albion/search', { q }),
      );
      if (seq === this.playerSearchSeq) {
        this.playerSearchResults.set(result.players);
        this.playerSearchDone.set(true);
      }
    } catch {
      if (seq === this.playerSearchSeq) {
        this.playerSearchResults.set([]);
        this.toasts.error(this.t('settings.albion.searchFailed'));
      }
    } finally {
      if (seq === this.playerSearchSeq) this.playerSearchLoading.set(false);
    }
  }

  private resetPlayerSearch(): void {
    clearTimeout(this.playerSearchTimer);
    this.playerSearchSeq += 1;
    this.playerSearchLoading.set(false);
    this.playerSearchDone.set(false);
    this.playerSearchResults.set([]);
  }

  protected async confirmLink(player: AlbionPlayer): Promise<void> {
    if (this.savingLink()) return;
    this.savingLink.set(true);
    try {
      const linkStatus = await firstValueFrom(
        this.api.post<AlbionLinkStatus>('api/albion/link', {
          albion_player_id: player.id,
          albion_player_name: player.name,
        }),
      );
      this.albionLink.set(linkStatus);
      this.closeLinkDialog();
      this.toasts.success(this.t('albion.linked', { name: player.name }));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.savingLink.set(false);
    }
  }

  protected async confirmUnlink(): Promise<void> {
    if (this.savingLink()) return;
    this.savingLink.set(true);
    try {
      await firstValueFrom(this.api.delete<void>('api/albion/link'));
      this.albionLink.set(null);
      this.unlinkConfirmOpen.set(false);
      this.toasts.success(this.t('albionSettings.link.unlinked'));
      await this.load();
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.savingLink.set(false);
    }
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
    } catch {
      this.loadFailed.set(true);
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
