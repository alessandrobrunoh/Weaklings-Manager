import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
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
import { Avatar } from '../../shared/components/avatar/avatar';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

type ProfileTab = 'overview' | 'ledgers' | 'battles' | 'preferences';

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
 * Unified Personal Profile & Preferences Workspace.
 *
 * Integrates account identity, season XP progression, attendance and combat metrics,
 * personal bank and siphoned energy ledgers, fight records, Albion character link,
 * and user preferences (theme & language).
 */
@Component({
  selector: 'app-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    DatePipe,
    DecimalPipe,
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
    StatusChip,
    TooltipDirective,
    ViewToggle,
  ],
  template: `
    <app-page-header [title]="t('nav.profile')" subtitle="Gestione account, progressione, economia e preferenze">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="load()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      <app-view-toggle
        pageTabs
        [options]="tabs()"
        [active]="activeTab()"
        (activeChange)="onTabChange($event)"
      />
    </app-page-header>

    @if (loading()) {
      <div class="p-12 flex justify-center">
        <app-loading [label]="t('common.loading')" />
      </div>
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    } @else {
      <app-page-stack>
        <!-- Profile Identity & Hero Card -->
        <section class="card p-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-4">
              <app-avatar
                [userId]="profile()?.id"
                [avatar]="profile()?.avatar"
                [username]="profile()?.username ?? 'U'"
                size="lg"
                shape="rounded"
              />
              <div>
                <div class="flex items-center gap-2">
                  <h1 class="text-xl font-bold tracking-tight" style="color: var(--color-text)">
                    {{ profile()?.username }}
                  </h1>
                  <span class="chip" [class]="roleChip(profile()?.highest_role)">
                    {{ profile()?.highest_role || 'User' }}
                  </span>
                </div>
                <p class="text-sm mt-0.5" style="color: var(--color-text-secondary)">
                  {{ profile()?.email || 'Nessuna email' }} · ID #{{ profile()?.id }}
                </p>
              </div>
            </div>

            <!-- Albion Character Link Capsule -->
            <div
              class="flex items-center gap-3 rounded-xl p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <div class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  [style.background]="albionLink()?.linked ? 'var(--color-success)' : 'var(--color-warning)'"
                ></span>
                <div>
                  <p class="text-xs uppercase tracking-wider font-semibold" style="color: var(--color-text-secondary)">
                    Albion Online Link
                  </p>
                  <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                    {{ albionLink()?.linked ? albionLink()?.albion_player_name : 'Non collegato' }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-1.5 ml-2">
                @if (albionLink()?.linked) {
                  <button
                    type="button"
                    class="btn btn--outline btn--sm text-xs py-1 px-2.5"
                    (click)="unlinkConfirmOpen.set(true)"
                    [appTooltip]="'Scollega il tuo personaggio Albion'"
                    tooltipPosition="top"
                  >
                    Scollega
                  </button>
                } @else {
                  <button
                    type="button"
                    class="btn btn--primary btn--sm text-xs py-1 px-2.5 flex items-center gap-1"
                    (click)="openLinkDialog()"
                    [appTooltip]="'Cerca e collega il tuo personaggio Albion'"
                    tooltipPosition="top"
                  >
                    <app-icon name="plus" size="0.75rem" />
                    Collega
                  </button>
                }
              </div>
            </div>
          </div>
        </section>

        <section class="card p-5 flex flex-wrap items-center justify-between gap-4" aria-labelledby="profile-specializations-heading">
          <div>
            <h2 id="profile-specializations-heading" class="text-base font-semibold" style="color: var(--color-text)">Specializzazioni Combat</h2>
            <p class="text-xs mt-1" style="color: var(--color-text-secondary)">Imposta il livello per ogni arma e armatura nella tua Destiny Board.</p>
          </div>
          @if (profile()?.user_id; as profileId) {
            <a class="btn btn--primary btn--sm flex items-center gap-1.5" [routerLink]="['/users', profileId]">
              <app-icon name="sparkles" size="0.8rem" />
              Gestisci specializzazioni
            </a>
          }
        </section>

        <!-- TAB 1: OVERVIEW & PROGRESSION -->
        @if (activeTab() === 'overview') {
          <!-- Season Progression Card -->
          @if (progression(); as xp) {
            <article class="card p-6">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div>
                  <span class="text-xs uppercase tracking-wider font-semibold" style="color: var(--color-text-secondary)">
                    {{ t('profile.xp.title') }}
                  </span>
                  <h2 class="text-lg font-bold" style="color: var(--color-text)">
                    {{ xp.season?.name || t('profile.xp.noSeason') }}
                  </h2>
                </div>
                @if (showMultiplier(xp.multiplier)) {
                  <span class="chip chip--warning font-mono">
                    {{ t('profile.xp.multiplier') }}: ×{{ formatMultiplier(xp.multiplier) }}
                  </span>
                }
              </div>

              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-4">
                <div class="rounded-xl p-3 border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                  <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('profile.xp.level') }}</p>
                  <p class="text-xl font-bold mono mt-0.5" style="color: var(--color-text)">{{ xp.level }}</p>
                </div>
                <div class="rounded-xl p-3 border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                  <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('profile.xp.xp') }}</p>
                  <p class="text-xl font-bold mono mt-0.5" style="color: var(--color-primary)">{{ formatAmount(xp.xp) }}</p>
                </div>
                <div class="rounded-xl p-3 border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                  <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('profile.xp.rank') }}</p>
                  <p class="text-xl font-bold mono mt-0.5" style="color: var(--color-success)">
                    {{ xp.rank != null ? '#' + xp.rank : t('profile.xp.unranked') }}
                  </p>
                </div>
                <div class="rounded-xl p-3 border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                  <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('profile.xp.lifetime') }}</p>
                  <p class="text-xl font-bold mono mt-0.5" style="color: var(--color-text)">{{ formatAmount(xp.lifetime_xp) }}</p>
                </div>
              </div>

              <!-- XP Progress Bar -->
              <div>
                <div class="flex items-center justify-between text-xs mb-1.5" style="color: var(--color-text-secondary)">
                  <span>{{ t('profile.xp.toNext') }}</span>
                  <span class="mono font-semibold" style="color: var(--color-text)">
                    {{ formatAmount(xp.xp) }} / {{ formatAmount(xp.xp + xp.xp_to_next) }}
                  </span>
                </div>
                <div class="h-2 rounded-full overflow-hidden" style="background: var(--color-surface-2)">
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    style="background: var(--color-primary)"
                    [style.width.%]="progressionBarPercent(xp)"
                  ></div>
                </div>
              </div>
            </article>
          }

          <!-- Activity, Regear & Loot Split Cards -->
          <section class="grid gap-4 md:grid-cols-3">
            <!-- Attendance -->
            <article class="card p-5">
              <h2 class="text-sm uppercase tracking-wider font-semibold mb-3" style="color: var(--color-text-secondary)">
                Presenza Eventi
              </h2>
              @if (userMetrics(); as m) {
                <div class="flex items-baseline justify-between mb-2">
                  <span class="text-2xl font-bold mono" style="color: var(--color-text)">
                    {{ m.attendance_rate | number: '1.0-0' }}%
                  </span>
                  <span class="text-xs" style="color: var(--color-text-secondary)">
                    {{ m.events_attended }} / {{ m.events_total }} eventi
                  </span>
                </div>
                <div class="h-1.5 rounded-full overflow-hidden mb-3" style="background: var(--color-surface-2)">
                  <div
                    class="h-full rounded-full"
                    style="background: var(--color-primary)"
                    [style.width.%]="clampPercent(m.attendance_rate)"
                  ></div>
                </div>
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  @if (m.attendance_streak > 0) {
                    Serie attuale: <strong>{{ m.attendance_streak }} consecutivi</strong>.
                  }
                </p>
                @if (m.next_event_title) {
                  <p class="mt-2 text-xs" style="color: var(--color-primary)">
                    Prossimo: {{ m.next_event_title }}
                  </p>
                }
              }
            </article>

            <!-- Regear -->
            <article class="card p-5">
              <h2 class="text-sm uppercase tracking-wider font-semibold mb-3" style="color: var(--color-text-secondary)">
                Regear Mensile
              </h2>
              @if (userMetrics(); as m) {
                <div class="flex items-baseline justify-between mb-2">
                  <span class="text-2xl font-bold mono" style="color: var(--color-text)">
                    {{ budget()?.per_month_used ?? 0 }} / {{ budget()?.per_month_max ?? 0 }}
                  </span>
                  <span class="text-xs" style="color: var(--color-text-secondary)">
                    Cap mensile
                  </span>
                </div>
                <div class="h-1.5 rounded-full overflow-hidden mb-3" style="background: var(--color-surface-2)">
                  <div
                    class="h-full rounded-full"
                    style="background: var(--color-warning)"
                    [style.width.%]="regearCapPercent()"
                  ></div>
                </div>
                <div class="grid grid-cols-2 gap-1 text-xs" style="color: var(--color-text-secondary)">
                  <span>Approvati: <strong>{{ m.regears_approved }}</strong></span>
                  <span>In attesa: <strong>{{ m.regears_pending }}</strong></span>
                  <span class="col-span-2 mt-1">Rimborsato: <strong style="color: var(--color-success)">{{ formatAmount(m.regear_silver) }}</strong></span>
                </div>
              }
            </article>

            <!-- Loot Splits -->
            <article class="card p-5">
              <h2 class="text-sm uppercase tracking-wider font-semibold mb-3" style="color: var(--color-text-secondary)">
                Loot Splits
              </h2>
              @if (userMetrics(); as m) {
                <div class="mb-2">
                  <p class="text-xs" style="color: var(--color-text-secondary)">Guadagno Totale</p>
                  <p class="text-2xl font-bold mono" style="color: var(--color-success)">
                    {{ formatAmount(m.split_earnings) }}
                  </p>
                </div>
                <div class="grid grid-cols-2 gap-1 text-xs mt-3 pt-3 border-t" style="border-color: var(--color-border); color: var(--color-text-secondary)">
                  <span>Partecipazioni: <strong>{{ m.splits_joined }}</strong></span>
                  <span>Media split: <strong>{{ formatAmount(averageSplitShare()) }}</strong></span>
                  <span class="col-span-2 mt-1">K/D: <strong>{{ m.kills }}K / {{ m.deaths }}D</strong> ({{ formatCompact(m.kill_fame) }} fame)</span>
                </div>
              }
            </article>
          </section>
        }

        <!-- TAB 2: LEDGERS & ECONOMY -->
        @if (activeTab() === 'ledgers') {
          <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Economy snapshot">
            <app-stat-card
              label="Argento in Attesa"
              [value]="formatAmount(balance()?.pending_total ?? 0)"
              icon="bank"
              tone="primary"
            />
            <app-stat-card
              label="Argento Richiesto"
              [value]="formatAmount(balance()?.requested_total ?? 0)"
              icon="bank"
              tone="warning"
            />
            <app-stat-card
              label="Argento Liquidato"
              [value]="formatAmount(withdrawnTotal())"
              icon="bank"
              tone="success"
            />
            <app-stat-card
              label="Energia Sifonata Netta"
              [value]="formatAmount(siphonedBalance()?.net ?? 0)"
              icon="activity"
              tone="neutral"
            />
          </section>

          <section class="grid gap-4 lg:grid-cols-2">
            <!-- Bank Transactions Table -->
            <div class="card p-0 overflow-hidden">
              <div class="p-4 border-b" style="border-color: var(--color-border)">
                <h2 class="text-base font-semibold" style="color: var(--color-text)">
                  Transazioni Personali Banca
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
                  <span class="mono font-semibold" style="color: var(--color-success)">
                    {{ formatAmount(row.amount) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="created_at" let-row>
                  <span class="text-xs" style="color: var(--color-text-secondary)">
                    {{ formatDate(row.created_at) }}
                  </span>
                </ng-template>
              </app-data-table>
            </div>

            <!-- Siphoned Energy Table -->
            <div class="card p-0 overflow-hidden">
              <div class="p-4 border-b" style="border-color: var(--color-border)">
                <h2 class="text-base font-semibold" style="color: var(--color-text)">
                  Movimenti Energia Sifonata
                </h2>
              </div>
              <app-data-table
                [columns]="siphonedColumns"
                [rows]="siphonedEntries()"
                [trackBy]="trackSiphonedEntry"
                [pageSize]="10"
              >
                <ng-template dataTableCell="amount" let-row>
                  <span class="mono font-semibold" [style.color]="row.amount >= 0 ? 'var(--color-success)' : 'var(--color-error)'">
                    {{ formatAmount(row.amount) }}
                  </span>
                </ng-template>
                <ng-template dataTableCell="occurred_at" let-row>
                  <span class="text-xs" style="color: var(--color-text-secondary)">
                    {{ formatDate(row.occurred_at) }}
                  </span>
                </ng-template>
              </app-data-table>
            </div>
          </section>
        }

        <!-- TAB 3: BATTLES & COMBAT -->
        @if (activeTab() === 'battles') {
          <div class="card p-0 overflow-hidden">
            <div class="p-4 border-b flex items-center justify-between" style="border-color: var(--color-border)">
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                Le mie battaglie recenti
              </h2>
              <span class="chip font-mono text-xs">{{ battles().length }} registrate</span>
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
                  class="btn btn--tonal btn--sm text-xs py-1 px-2 mono"
                  [appTooltip]="'Apri dettagli battaglia #' + row.battle_id"
                  tooltipPosition="top"
                >
                  #{{ row.battle_id }}
                </a>
              </ng-template>
              <ng-template dataTableCell="start_time" let-row>
                <span class="text-xs" style="color: var(--color-text-secondary)">
                  {{ formatDate(row.start_time) }}
                </span>
              </ng-template>
              <ng-template dataTableCell="total_fame" let-row>
                <span class="mono font-semibold" style="color: var(--color-warning)">
                  {{ formatCompact(row.total_fame) }}
                </span>
              </ng-template>
            </app-data-table>
          </div>
        }

        <!-- TAB 4: PREFERENCES & SETTINGS -->
        @if (activeTab() === 'preferences') {
          <section class="grid gap-6 md:grid-cols-2">
            <!-- Theme Preference -->
            <section class="card p-6">
              <div class="flex items-center gap-2 mb-4">
                <app-icon name="sparkles" size="1.25rem" style="color: var(--color-primary)" />
                <h2 class="text-base font-semibold" style="color: var(--color-text)">
                  Tema e Aspetto
                </h2>
              </div>
              <div class="grid gap-3">
                @for (option of themeOptions; track option.value) {
                  <button
                    type="button"
                    class="flex items-center justify-between p-4 rounded-xl border text-left transition-all"
                    [style.border-color]="theme.preference() === option.value ? 'var(--color-primary)' : 'var(--color-border)'"
                    [style.background]="theme.preference() === option.value ? 'var(--color-primary-soft)' : 'var(--color-surface-1)'"
                    (click)="onThemeChange(option.value)"
                  >
                    <div class="flex items-center gap-3">
                      <span class="h-3 w-3 rounded-full border flex items-center justify-center"
                        [style.border-color]="theme.preference() === option.value ? 'var(--color-primary)' : 'var(--color-border-strong)'"
                        [style.background]="theme.preference() === option.value ? 'var(--color-primary)' : 'transparent'"
                      ></span>
                      <span class="font-medium text-sm" style="color: var(--color-text)">
                        {{ t(option.labelKey) }}
                      </span>
                    </div>
                  </button>
                }
              </div>
            </section>

            <!-- Language Preference -->
            <section class="card p-6">
              <div class="flex items-center gap-2 mb-4">
                <app-icon name="users" size="1.25rem" style="color: var(--color-primary)" />
                <h2 class="text-base font-semibold" style="color: var(--color-text)">
                  Lingua interfaccia
                </h2>
              </div>
              <div class="grid gap-3">
                @for (lang of translate.supportedLanguages; track lang) {
                  <button
                    type="button"
                    class="flex items-center justify-between p-4 rounded-xl border text-left transition-all"
                    [style.border-color]="translate.language() === lang ? 'var(--color-primary)' : 'var(--color-border)'"
                    [style.background]="translate.language() === lang ? 'var(--color-primary-soft)' : 'var(--color-surface-1)'"
                    (click)="onLanguageChange(lang)"
                  >
                    <div class="flex items-center gap-3">
                      <span class="h-3 w-3 rounded-full border flex items-center justify-center"
                        [style.border-color]="translate.language() === lang ? 'var(--color-primary)' : 'var(--color-border-strong)'"
                        [style.background]="translate.language() === lang ? 'var(--color-primary)' : 'transparent'"
                      ></span>
                      <span class="font-medium text-sm" style="color: var(--color-text)">
                        {{ translate.languageLabels[lang] }}
                      </span>
                    </div>
                  </button>
                }
              </div>
            </section>
          </section>
        }
      </app-page-stack>
    }

    <!-- Link Albion Character Dialog -->
    @if (linkDialogOpen()) {
      <app-dialog title="Collega il tuo Personaggio Albion" (closed)="closeLinkDialog()">
        <div class="grid gap-3">
          <p id="albion-link-search-hint" class="text-xs" style="color: var(--color-text-secondary)">
            Cerca il tuo nome giocatore in tutto Albion Online. Anche i giocatori esterni alla gilda possono collegarsi.
          </p>

          <form class="flex gap-2" (submit)="searchPlayers($event)">
            <label class="sr-only" for="albion-link-search">Nome personaggio Albion</label>
            <input
              id="albion-link-search"
              name="albion-player-search"
              type="search"
              class="input min-w-0 flex-1"
              placeholder="Cerca nome giocatore..."
              [value]="playerSearch()"
              (input)="onPlayerSearchInput($event)"
              aria-describedby="albion-link-search-hint"
              autofocus
            />
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="playerSearch().trim().length < 2 || playerSearchLoading()">
              Cerca
            </button>
          </form>

          @if (playerSearchLoading()) {
            <div class="p-6 flex justify-center">
              <app-loading label="Ricerca giocatori Albion..." />
            </div>
          } @else if (playerSearchDone()) {
            <div class="max-h-64 overflow-y-auto grid gap-1.5 pr-1" aria-live="polite">
              @for (player of playerSearchResults(); track player.id) {
                <button
                  type="button"
                  class="flex items-center justify-between p-2.5 rounded-xl border text-left transition-colors hover:border-primary hover:bg-surface-2"
                  style="border-color: var(--color-border); background: var(--color-surface-1)"
                  (click)="confirmLink(player)"
                  [disabled]="savingLink()"
                >
                  <div>
                    <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                      {{ player.name }}
                    </p>
                    <p class="text-xs" style="color: var(--color-text-secondary)">
                      {{ player.guild_name ?? 'Nessuna gilda' }} · ID: {{ player.id }}
                    </p>
                  </div>
                  <span class="btn btn--primary btn--sm text-xs py-1 px-2.5">
                    Collega
                  </span>
                </button>
              } @empty {
                <p class="text-sm text-center py-4" style="color: var(--color-text-secondary)">
                  Nessun giocatore trovato con questo nome.
                </p>
              }
            </div>
          }
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeLinkDialog()">
            {{ t('common.cancel') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Unlink Confirmation Dialog -->
    @if (unlinkConfirmOpen()) {
      <app-dialog title="Scollega Personaggio Albion" (closed)="unlinkConfirmOpen.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          Sei sicuro di voler scollegare il tuo personaggio <strong>{{ albionLink()?.albion_player_name }}</strong>?
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="unlinkConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm text-red-400 border-red-500/30 hover:bg-red-500/10"
            (click)="confirmUnlink()"
            [disabled]="savingLink()"
          >
            Conferma Scollegamento
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Settings {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
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
  protected readonly userMetrics = signal<UserMetrics | null>(null);
  protected readonly budget = signal<RegearBudgetSummary | null>(null);
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly profile = this.auth.profile;

  // Albion Link state
  protected readonly linkDialogOpen = signal(false);
  protected readonly unlinkConfirmOpen = signal(false);
  protected readonly playerSearchLoading = signal(false);
  protected readonly playerSearchDone = signal(false);
  protected readonly savingLink = signal(false);
  protected readonly playerSearch = signal('');
  protected readonly playerSearchResults = signal<AlbionPlayer[]>([]);

  protected readonly tabs = computed<readonly ViewToggleOption[]>(() => [
    { id: 'overview', label: 'Panoramica & XP', icon: 'trophy' },
    { id: 'ledgers', label: 'Libro Mastro & Banca', icon: 'bank' },
    { id: 'battles', label: 'Combattimenti', icon: 'shield' },
    { id: 'preferences', label: 'Preferenze & Tema', icon: 'sparkles' },
  ]);

  protected onTabChange(id: string): void {
    this.activeTab.set(id as ProfileTab);
  }


  protected readonly themeOptions: ReadonlyArray<{
    value: ThemePreference;
    labelKey: TranslationKey;
  }> = [
    { value: 'light', labelKey: 'theme.light' },
    { value: 'dark', labelKey: 'theme.dark' },
    { value: 'system', labelKey: 'theme.system' },
  ];

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
  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
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

  protected regearCapPercent(): number {
    const budget = this.budget();
    if (!budget || budget.per_month_max <= 0) return 0;
    return this.clampPercent((budget.per_month_used / budget.per_month_max) * 100);
  }

  protected averageSplitShare(): number {
    const m = this.userMetrics();
    if (!m || m.splits_joined <= 0) return 0;
    return Math.round(m.split_earnings / m.splits_joined);
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
    this.playerSearch.set('');
    this.playerSearchResults.set([]);
    this.playerSearchDone.set(false);
  }

  protected closeLinkDialog(): void {
    this.linkDialogOpen.set(false);
    this.playerSearch.set('');
    this.playerSearchResults.set([]);
    this.playerSearchDone.set(false);
  }

  protected onPlayerSearchInput(event: Event): void {
    this.playerSearch.set((event.target as HTMLInputElement).value);
  }

  protected async searchPlayers(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const q = this.playerSearch().trim();
    if (q.length < 2 || this.playerSearchLoading()) return;

    this.playerSearchLoading.set(true);
    this.playerSearchDone.set(false);
    try {
      const result = await firstValueFrom(this.api.get<AlbionSearchResult>('api/albion/search', { q }));
      this.playerSearchResults.set(result.players);
      this.playerSearchDone.set(true);
    } catch (error) {
      this.playerSearchResults.set([]);
      this.toasts.error(error instanceof Error ? error.message : 'Impossibile cercare giocatori Albion');
    } finally {
      this.playerSearchLoading.set(false);
    }
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
      this.toasts.success(`Personaggio ${player.name} collegato con successo!`);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante il collegamento');
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
      this.toasts.success('Personaggio scollegato con successo');
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante lo scollegamento');
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
