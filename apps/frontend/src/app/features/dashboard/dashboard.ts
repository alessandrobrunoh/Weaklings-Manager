import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  BalanceSummary,
  EventView,
  ProgressionMeView,
  UserMetrics,
} from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { Avatar } from '../../shared/components/avatar/avatar';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

interface AttentionItem {
  readonly id: string;
  readonly icon: IconName;
  readonly iconTone: 'warning' | 'info';
  readonly text: string;
  readonly actionText: string;
  readonly link: string;
}

interface NextMassCard {
  readonly id: number;
  readonly title: string;
  readonly dayLabel: string;
  readonly time: string;
  readonly compName: string;
  readonly capText: string | null;
  readonly live: boolean;
}

/**
 * Personal command-center dashboard.
 *
 * The landing page answers "what is true for me right now": identity, bank
 * ledger, season progress, things I still need to do, and the next mass.
 * Guild-wide finance and officer queues live on `/guild` and `/admin`.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, EmptyState, Icon, RouterLink, TooltipDirective],
  styles: `
    :host {
      display: block;
      width: 100%;
    }

    .identity-card,
    .kpi-card,
    .action-panel {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      transition: border-color 150ms ease, background-color 150ms ease;
    }
    .identity-card:hover,
    .kpi-card:hover,
    .action-panel:hover {
      border-color: var(--color-border-strong);
    }

    .kpi-card {
      padding: 1.125rem 1.25rem;
      display: flex;
      flex-direction: column;
      text-decoration: none;
    }
    .kpi-card:hover {
      background-color: var(--color-surface-hover);
    }

    .icon-capsule {
      width: 2.125rem;
      height: 2.125rem;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .icon-capsule--red {
      background: rgba(220, 38, 38, 0.12);
      color: #ef4444;
    }
    .icon-capsule--green {
      background: rgba(34, 197, 94, 0.12);
      color: #4cc36a;
    }
    .icon-capsule--amber {
      background: rgba(234, 179, 8, 0.12);
      color: #eab308;
    }
    .icon-capsule--purple {
      background: rgba(168, 85, 247, 0.12);
      color: #c084fc;
    }
    .icon-capsule--sky {
      background: rgba(56, 189, 248, 0.12);
      color: #7dd3fc;
    }

    .xp-track {
      height: 0.375rem;
      border-radius: 9999px;
      overflow: hidden;
      background: var(--color-surface-2);
    }
    .xp-track__fill {
      height: 100%;
      border-radius: 9999px;
      background: var(--color-primary);
    }

    .caught-up-banner {
      background-color: color-mix(in srgb, var(--color-surface-2) 75%, transparent);
      border: 1px solid var(--color-border);
    }

    .date-box {
      background-color: #16171a;
      border: 1px solid #2d2024;
      min-width: 5.75rem;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.375rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1;
    }
    .status-pill--ready {
      background-color: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.25);
      color: #4cc36a;
    }
    .status-pill--live {
      background-color: rgba(220, 38, 38, 0.1);
      border: 1px solid rgba(220, 38, 38, 0.28);
      color: #f87171;
    }

    .btn-open-event {
      background-color: var(--color-weaklings-red);
      color: #ffffff;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      transition: background-color 150ms ease;
      line-height: 1.25;
    }
    .btn-open-event:hover {
      background-color: #b91c1c;
    }
  `,
  template: `
    <div class="dashboard-page flex flex-col gap-6 max-w-7xl mx-auto pb-10">
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-1">
        <div>
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) m-0">
            {{ greeting() }}, {{ username() }}
          </h1>
          <p class="text-sm text-[var(--color-text-tertiary)] mt-1 mb-0">
            {{ t('dashboard.subtitle') }}
          </p>
        </div>

        <div class="flex items-center gap-3 self-end sm:self-center">
          <a
            routerLink="/profile"
            class="btn btn--ghost btn--sm no-underline"
          >
            {{ t('dashboard.open_profile') }}
          </a>
          <button
            type="button"
            class="btn btn--ghost btn--icon shrink-0 text-[var(--color-text-tertiary)] hover:text-(--color-text)"
            [disabled]="loading()"
            (click)="refreshNow()"
            [appTooltip]="t('dashboard.refresh')"
            tooltipPosition="bottom"
            [attr.aria-label]="t('dashboard.refresh')"
          >
            <app-icon name="refresh" size="1rem" [class.animate-spin]="loading()" />
          </button>
        </div>
      </header>

      <section class="identity-card p-5 sm:p-6" [attr.aria-label]="t('dashboard.identity')">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-4 min-w-0">
            <app-avatar
              [userId]="profile()?.id"
              [avatar]="profile()?.avatar"
              [username]="username()"
              size="lg"
              shape="rounded"
            />
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-lg font-bold tracking-tight text-(--color-text) m-0 truncate">
                  {{ username() }}
                </p>
                @if (roleLabel()) {
                  <span class="chip">{{ roleLabel() }}</span>
                }
              </div>
              <div class="flex flex-wrap items-center gap-2 mt-1.5 text-sm text-[var(--color-text-secondary)]">
                <span
                  class="h-2 w-2 rounded-full shrink-0"
                  [class.bg-emerald-400]="albionLinked()"
                  [class.bg-amber-400]="!albionLinked()"
                ></span>
                <span class="truncate">
                  {{ albionLabel() }}
                </span>
              </div>
            </div>
          </div>

          @if (progression(); as xp) {
            <a routerLink="/season" class="min-w-[14rem] flex-1 max-w-md no-underline">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ xp.season?.name || t('profile.xp.noSeason') }}
                </span>
                <span class="text-xs font-mono text-[var(--color-text-tertiary)]">
                  {{ seasonRankLabel() }}
                </span>
              </div>
              <div class="flex items-baseline justify-between gap-3 mt-1">
                <span class="text-sm font-semibold text-(--color-text)">
                  {{ t('dashboard.stat.season_level', { level: xp.level }) }}
                </span>
                <span class="text-xs font-mono text-[var(--color-text-secondary)]">
                  {{ t('dashboard.stat.xp_progress', { current: formatAmount(xp.xp), next: formatAmount(xp.xp + xp.xp_to_next) }) }}
                </span>
              </div>
              <div class="xp-track mt-2" role="progressbar" [attr.aria-valuenow]="xpPercent()" aria-valuemin="0" aria-valuemax="100">
                <div class="xp-track__fill" [style.width.%]="xpPercent()"></div>
              </div>
            </a>
          }
        </div>
      </section>

      <section [attr.aria-label]="t('dashboard.kpis')" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-5">
        <a routerLink="/bank" class="kpi-card group" [attr.aria-label]="t('dashboard.stat.balance')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--green">
                <app-icon name="bank" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                {{ t('dashboard.stat.balance') }}
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5 font-mono">
            {{ pendingValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('bank.creditsAvailable', { count: bankBalance()?.pending_count ?? 0 }) }}
          </div>
        </a>

        <a routerLink="/bank" class="kpi-card group" [attr.aria-label]="t('dashboard.stat.requested')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--amber">
                <app-icon name="alert" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                {{ t('dashboard.stat.requested') }}
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5 font-mono">
            {{ requestedValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('bank.withdrawalsInReview', { count: bankBalance()?.requested_count ?? 0 }) }}
          </div>
        </a>

        <a routerLink="/splits" class="kpi-card group" [attr.aria-label]="t('dashboard.stat.earnings')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--purple">
                <app-icon name="coins" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                {{ t('dashboard.stat.earnings') }}
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5 font-mono">
            {{ earningsValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('dashboard.stat.earnings_sub', { count: metrics()?.splits_joined ?? 0 }) }}
          </div>
        </a>

        <a routerLink="/events" class="kpi-card group" [attr.aria-label]="t('dashboard.stat.attendance')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--sky">
                <app-icon name="users" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                {{ t('dashboard.stat.attendance') }}
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5 font-mono">
            {{ attendanceValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ t('dashboard.stat.attendance_sub', { attended: metrics()?.events_attended ?? 0, total: metrics()?.events_total ?? 0 }) }}
          </div>
        </a>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5 items-stretch">
        <div class="action-panel p-5 sm:p-6 flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-2 mb-4">
              <h2 class="text-base font-bold text-(--color-text) m-0">{{ t('dashboard.attention.title') }}</h2>
              @if (attentionItems().length > 0) {
                <span class="inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold rounded-full bg-[#dc2626] text-(--color-text)">
                  {{ attentionItems().length }}
                </span>
              }
            </div>

            @if (attentionItems().length > 0) {
              <ul class="flex flex-col m-0 p-0 list-none divide-y divide-[var(--color-border)]">
                @for (item of attentionItems(); track item.id) {
                  <li class="py-3.5 first:pt-1 last:pb-1 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3 min-w-0">
                      <div
                        class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                        [class]="item.iconTone === 'warning' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'"
                      >
                        <app-icon [name]="item.icon" size="1.125rem" />
                      </div>
                      <span class="text-xs sm:text-sm font-medium text-(--color-text) truncate">
                        {{ item.text }}
                      </span>
                    </div>
                    <a
                      [routerLink]="item.link"
                      class="action-link text-xs font-semibold text-[#dc2626] hover:text-red-400 transition-colors shrink-0 inline-flex items-center gap-1 no-underline"
                    >
                      <span>{{ item.actionText }}</span>
                      <app-icon name="arrow-right" size="0.75rem" />
                    </a>
                  </li>
                }
              </ul>
            } @else {
              <div class="caught-up-banner p-3.5 rounded-xl flex items-center gap-3.5">
                <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
                  <app-icon name="check" size="1rem" />
                </div>
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-(--color-text) m-0">{{ t('dashboard.attention.caught_up') }}</p>
                  <p class="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-0">{{ t('dashboard.attention.caught_up_hint') }}</p>
                </div>
              </div>
            }
          </div>
        </div>

        <div class="action-panel p-5 sm:p-6 flex flex-col justify-between">
          @if (nextMassCard(); as mass) {
            <div>
              <div class="flex items-center gap-2 mb-5">
                <span
                  class="h-2 w-2 rounded-full"
                  [class.bg-red-500]="mass.live"
                  [class.animate-pulse]="mass.live"
                  [class.bg-zinc-500]="!mass.live"
                ></span>
                <h2 class="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider m-0">
                  {{ t('dashboard.next_mass') }}
                </h2>
              </div>

              <div class="flex items-center gap-4 sm:gap-6 mt-1">
                <div class="date-box shrink-0 flex flex-col items-center justify-center rounded-xl p-3 sm:px-4 sm:py-3.5">
                  <app-icon name="calendar" size="1.25rem" class="text-red-500 mb-1" />
                  <span class="text-[10px] font-bold text-red-500 tracking-wider uppercase">
                    {{ mass.dayLabel }}
                  </span>
                  <span class="text-2xl sm:text-3xl font-bold text-(--color-text) tracking-tight leading-none mt-1">
                    {{ mass.time }}
                  </span>
                </div>

                <div class="flex flex-col justify-center min-w-0">
                  <h3 class="text-lg sm:text-2xl font-bold text-(--color-text) truncate m-0">
                    {{ mass.title }}
                  </h3>
                  <div class="flex items-center gap-2 text-xs sm:text-sm text-[var(--color-text-secondary)] mt-2">
                    <app-icon name="swords" size="1rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                    <span class="truncate">{{ mass.compName }}</span>
                  </div>
                  @if (mass.capText) {
                    <div class="flex items-center gap-2 text-xs sm:text-sm text-[var(--color-text-secondary)] mt-1">
                      <app-icon name="users" size="1rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                      <span class="truncate">{{ mass.capText }}</span>
                    </div>
                  }
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3 mt-6 pt-4 border-t border-[var(--color-border)]">
              <div class="status-pill" [class.status-pill--live]="mass.live" [class.status-pill--ready]="!mass.live">
                @if (mass.live) {
                  <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
                  <span>{{ t('events.status.live') }}</span>
                } @else {
                  <app-icon name="check" size="0.875rem" />
                  <span>{{ t('events.status.scheduled') }}</span>
                }
              </div>

              <a
                [routerLink]="['/events', mass.id]"
                class="btn-open-event no-underline inline-flex items-center gap-1.5"
              >
                <span>{{ t('dashboard.next_mass.open') }}</span>
                <app-icon name="arrow-right" size="0.875rem" />
              </a>
            </div>
          } @else {
            <div class="flex flex-col h-full">
              <h2 class="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider m-0 mb-4">
                {{ t('dashboard.next_mass') }}
              </h2>
              <div class="flex-1 flex flex-col items-center justify-center">
                <app-empty-state
                  icon="calendar"
                  [message]="t('dashboard.next_mass.empty')"
                  [hint]="t('dashboard.next_mass.empty_hint')"
                >
                  <a routerLink="/events" class="btn btn--ghost btn--sm no-underline">
                    {{ t('dashboard.view_all') }}
                  </a>
                </app-empty-state>
              </div>
            </div>
          }
        </div>
      </section>
    </div>
  `,
})
export class Dashboard {
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected readonly translate = inject(TranslateService);

  protected readonly bankBalance = signal<BalanceSummary | null>(null);
  protected readonly metrics = signal<UserMetrics | null>(null);
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly recentEvents = signal<ReadonlyArray<EventView>>([]);
  protected readonly loading = signal(false);

  protected readonly profile = this.auth.profile;
  protected readonly username = computed(() => this.auth.profile()?.username ?? '');
  protected readonly roleLabel = computed(() => this.auth.profile()?.highest_role ?? '');

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return this.t('dashboard.greeting.morning');
    if (hour >= 12 && hour < 18) return this.t('dashboard.greeting.afternoon');
    return this.t('dashboard.greeting.evening');
  });

  protected readonly albionLinked = computed(() => this.albionLink()?.linked === true);

  protected readonly albionLabel = computed(() => {
    const link = this.albionLink();
    if (link?.linked && link.albion_player_name) {
      return this.t('dashboard.albion.linked', { name: link.albion_player_name });
    }
    return this.t('dashboard.albion.unlinked');
  });

  protected readonly pendingValue = computed(() =>
    this.formatCompactSilver(this.bankBalance()?.pending_total),
  );

  protected readonly requestedValue = computed(() =>
    this.formatCompactSilver(this.bankBalance()?.requested_total),
  );

  protected readonly earningsValue = computed(() =>
    this.formatCompactSilver(this.metrics()?.split_earnings),
  );

  protected readonly attendanceValue = computed(() => {
    const rate = this.metrics()?.attendance_rate;
    if (rate === null || rate === undefined) return '—';
    return `${Math.round(rate)}%`;
  });

  protected readonly xpPercent = computed(() => {
    const xp = this.progression();
    if (!xp) return 0;
    const total = xp.xp + xp.xp_to_next;
    if (total <= 0) return xp.xp > 0 ? 100 : 0;
    return Math.min(100, Math.max(0, Math.round((xp.xp / total) * 100)));
  });

  protected readonly seasonRankLabel = computed(() => {
    const rank = this.progression()?.rank;
    if (rank == null) return this.t('profile.xp.unranked');
    return this.t('dashboard.stat.season_rank', { rank });
  });

  protected readonly nextMassCard = computed<NextMassCard | null>(() => {
    const selected = selectNextMass(this.recentEvents());
    if (!selected) return null;

    const massAt = eventMassAt(selected);
    const isToday = massAt !== null && massAt.toDateString() === new Date().toDateString();
    const timeStr = massAt
      ? massAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : '—';

    return {
      id: selected.id,
      title: selected.title,
      dayLabel: isToday
        ? this.t('dashboard.next_mass.today')
        : (massAt?.toLocaleDateString([], { weekday: 'short' }).toUpperCase() || this.t('dashboard.next_mass.today')),
      time: timeStr,
      compName: selected.comp_name,
      capText: selected.player_cap
        ? this.t('dashboard.next_mass.cap', { count: selected.player_cap })
        : null,
      live: selected.status === 'live',
    };
  });

  protected readonly attentionItems = computed<ReadonlyArray<AttentionItem>>(() => {
    const items: AttentionItem[] = [];
    const balance = this.bankBalance();
    const metrics = this.metrics();
    const link = this.albionLink();
    const nextEvent = selectNextMass(this.recentEvents());

    if (balance && balance.pending_total > 0) {
      items.push({
        id: 'withdraw',
        icon: 'bank',
        iconTone: 'info',
        text: this.t('dashboard.attention.withdraw', {
          amount: this.formatCompactSilver(balance.pending_total),
        }),
        actionText: this.t('dashboard.attention.withdraw_action'),
        link: '/bank',
      });
    }

    if (balance && balance.requested_count > 0) {
      items.push({
        id: 'requested',
        icon: 'alert',
        iconTone: 'warning',
        text: this.t('dashboard.attention.requested', { count: balance.requested_count }),
        actionText: this.t('dashboard.attention.requested_action'),
        link: '/bank',
      });
    }

    if (metrics && metrics.regears_pending > 0) {
      items.push({
        id: 'regears',
        icon: 'shield',
        iconTone: 'warning',
        text: this.t('dashboard.attention.regears', { count: metrics.regears_pending }),
        actionText: this.t('dashboard.attention.regears_action'),
        link: '/regears',
      });
    }

    if (link && !link.linked) {
      items.push({
        id: 'albion',
        icon: 'link',
        iconTone: 'info',
        text: this.t('dashboard.attention.link_albion'),
        actionText: this.t('dashboard.attention.link_albion_action'),
        link: '/profile',
      });
    }

    if (nextEvent) {
      if (nextEvent.status === 'live') {
        items.push({
          id: 'mass',
          icon: 'swords',
          iconTone: 'warning',
          text: this.t('dashboard.attention.mass_live', { title: nextEvent.title }),
          actionText: this.t('dashboard.attention.mass_action'),
          link: `/events/${nextEvent.id}`,
        });
      } else {
        const massAt = eventMassAt(nextEvent);
        if (massAt) {
          const eta = formatMassEta(massAt);
          const soon = eta.unit === 'now' || eta.unit === 'minutes' || (eta.unit === 'hours' && eta.count <= 6);
          if (soon) {
            items.push({
              id: 'mass',
              icon: 'calendar',
              iconTone: 'info',
              text: this.t('dashboard.attention.mass', {
                title: nextEvent.title,
                eta: this.formatEtaLabel(eta),
              }),
              actionText: this.t('dashboard.attention.mass_action'),
              link: `/events/${nextEvent.id}`,
            });
          }
        }
      }
    }

    return items;
  });

  constructor() {
    void this.loadSnapshot();
  }

  protected async refreshNow(): Promise<void> {
    this.loading.set(true);
    try {
      await this.loadSnapshot();
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSnapshot(): Promise<void> {
    const [balance, metrics, progression, albion, scheduledEvents, liveEvents] =
      await Promise.allSettled([
        firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance')),
        firstValueFrom(this.api.get<UserMetrics>('api/users/me/metrics')),
        firstValueFrom(this.api.get<ProgressionMeView>('api/progression/me')),
        firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me')),
        firstValueFrom(
          this.api.get<{ items: EventView[] }>('api/events', {
            page: 1,
            limit: 20,
            status: 'scheduled',
            sort: 'mass_time_utc',
            order: 'asc',
          }),
        ),
        firstValueFrom(
          this.api.get<{ items: EventView[] }>('api/events', {
            page: 1,
            limit: 10,
            status: 'live',
            sort: 'mass_time_utc',
            order: 'asc',
          }),
        ),
      ]);

    if (balance.status === 'fulfilled') this.bankBalance.set(balance.value);
    if (metrics.status === 'fulfilled') this.metrics.set(metrics.value);
    if (progression.status === 'fulfilled') this.progression.set(progression.value);
    if (albion.status === 'fulfilled') this.albionLink.set(albion.value);

    const upcoming: EventView[] = [];
    if (liveEvents.status === 'fulfilled') upcoming.push(...liveEvents.value.items);
    if (scheduledEvents.status === 'fulfilled') upcoming.push(...scheduledEvents.value.items);
    this.recentEvents.set(upcoming);
  }

  formatCompactSilver(
    value: number | string | null | undefined,
    showPlus = false,
  ): string {
    return formatCompactSilver(value, showPlus);
  }

  protected formatAmount(value: number | string): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  private formatEtaLabel(eta: MassEta): string {
    if (eta.unit === 'now') return this.t('dashboard.eta.now');
    if (eta.unit === 'minutes') return this.t('dashboard.eta.minutes', { count: eta.count });
    if (eta.unit === 'hours') return this.t('dashboard.eta.hours', { count: eta.count });
    return this.t('dashboard.eta.days', { count: eta.count });
  }
}

export function formatCompactSilver(
  value: number | string | null | undefined,
  showPlus = false,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return '—';
  const sign = showPlus && num > 0 ? '+' : '';
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) {
    return `${sign}${(num / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${(num / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${(num / 1_000).toFixed(1)}k`;
  }
  return `${sign}${num.toLocaleString()}`;
}

/** Mass gather time for an event — the first clock time of that event day. */
export function eventMassAt(event: EventView): Date | null {
  const raw = event.mass_time_utc ?? event.event_date_utc;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventStartAt(event: EventView): Date | null {
  const raw = event.start_time_utc ?? event.event_date_utc;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function byMassTime(left: EventView, right: EventView): number {
  const leftTime = eventMassAt(left)?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = eventMassAt(right)?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

export interface MassEta {
  readonly unit: 'now' | 'minutes' | 'hours' | 'days';
  readonly count: number;
}

export function formatMassEta(target: Date, now: Date = new Date()): MassEta {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return { unit: 'now', count: 0 };
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return { unit: 'minutes', count: Math.max(1, mins) };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.round(hours / 24) };
}

/**
 * Next mass is the live event if one is running, otherwise the soonest scheduled
 * event whose start has not passed yet — on that day, the first (mass) time.
 */
export function selectNextMass(
  events: readonly EventView[],
  now: Date = new Date(),
): EventView | null {
  const nowMs = now.getTime();
  const actionable = events.filter(
    (event) => event.status === 'live' || event.status === 'scheduled',
  );

  const live = actionable.filter((event) => event.status === 'live').sort(byMassTime);
  if (live[0]) {
    return live[0];
  }

  const upcoming = actionable
    .filter((event) => event.status === 'scheduled')
    .filter((event) => {
      const startAt = eventStartAt(event);
      return startAt !== null && startAt.getTime() >= nowMs;
    })
    .sort(byMassTime);

  return upcoming[0] ?? null;
}
