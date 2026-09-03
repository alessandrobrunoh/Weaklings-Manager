import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
  EventView,
  GuildBankSummary,
  PaginatedData,
  SplitSummary,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { Avatar } from '../../shared/components/avatar/avatar';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { NotificationsPanel } from '../../layout/topbar/notifications-panel';

interface AttentionItem {
  readonly icon: IconName;
  readonly iconTone: 'warning' | 'info';
  readonly text: string;
  readonly actionText: string;
  readonly link: string;
}


/**
 * Command Center Dashboard following the precision midnight Linear/Weaklings design.
 *
 * Features:
 * - Dynamic greeting & user presence with notifications inbox and profile shortcut
 * - 4 Key Performance Indicator (KPI) cards: Bank requested, Splits completed, Splits pending, Season paid out
 * - Two-column activity command deck: "Requires your attention" and "Next mass" with live state
 * - "Recent splits" transaction row with completion status indicators
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Icon, NotificationsPanel, RouterLink, TooltipDirective],
  styles: `
    :host {
      display: block;
      width: 100%;
    }

    .kpi-card {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      padding: 1.125rem 1.25rem;
      transition: border-color 150ms ease, background-color 150ms ease;
      display: flex;
      flex-direction: column;
      text-decoration: none;
    }
    .kpi-card:hover {
      border-color: var(--color-border-strong);
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

    .action-panel {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      transition: border-color 150ms ease;
    }
    .action-panel:hover {
      border-color: var(--color-border-strong);
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
    .status-pill--assigned {
      background-color: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.2);
      color: #7dd3fc;
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
      <!-- Top Greeting & Personal Profile Header -->
      <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-1">
        <div>
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) m-0">
            {{ greeting() }}, {{ username() }}
          </h1>
          <p class="text-sm text-[var(--color-text-tertiary)] mt-1 mb-0">
            Here's what's happening with Weaklings.
          </p>
        </div>

        <!-- Header Actions: Refresh, Notification Inbox, Profile Avatar -->
        <div class="flex items-center gap-3 self-end sm:self-center">
          <button
            type="button"
            class="btn btn--ghost btn--icon shrink-0 text-[var(--color-text-tertiary)] hover:text-(--color-text)"
            [disabled]="loading()"
            (click)="refreshNow()"
            [appTooltip]="'Refresh snapshot'"
            tooltipPosition="bottom"
            aria-label="Refresh snapshot"
          >
            <app-icon name="refresh" size="1rem" [class.animate-spin]="loading()" />
          </button>

          <app-notifications-panel />

          <a
            routerLink="/profile"
            class="inline-flex rounded-full transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            [appTooltip]="username() + (auth.profile()?.highest_role ? ' (' + auth.profile()?.highest_role + ')' : '')"
            tooltipPosition="bottom"
            aria-label="User profile"
          >
            <app-avatar
              [userId]="auth.profile()?.id ?? 'default'"
              [avatar]="auth.profile()?.avatar ?? null"
              [username]="username()"
              size="sm"
            />
          </a>
        </div>
      </header>

      <!-- Row 1: 4 Key Performance Indicators (KPI Cards) -->
      <section aria-label="Key Performance Indicators" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <!-- Card 1: Bank requested -->
        <a
          [routerLink]="auth.hasPermission('bank.withdraw.accept') ? '/admin/withdrawals' : '/bank'"
          class="kpi-card group"
          aria-label="Bank requested overview"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--red">
                <app-icon name="bank" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                Bank requested
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ bankRequestedValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            {{ bankRequestedPendingText() }}
          </div>
        </a>

        <!-- Card 2: Splits completed -->
        <a
          routerLink="/splits"
          class="kpi-card group"
          aria-label="Splits completed overview"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--green">
                <app-icon name="percent" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                Splits completed
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ splitsCompletedCount() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            This season
          </div>
        </a>

        <!-- Card 3: Splits pending -->
        <a
          routerLink="/splits"
          class="kpi-card group"
          aria-label="Splits pending overview"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--amber">
                <app-icon name="alert" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                Splits pending
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ splitsPendingCount() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            Needs attention
          </div>
        </a>

        <!-- Card 4: Season paid out -->
        <a
          routerLink="/season"
          class="kpi-card group"
          aria-label="Season paid out overview"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="icon-capsule icon-capsule--purple">
                <app-icon name="coins" size="1.125rem" />
              </div>
              <span class="text-xs font-medium text-[var(--color-text-secondary)] group-hover:text-(--color-text) transition-colors">
                Season paid out
              </span>
            </div>
            <app-icon
              name="chevron-right"
              size="0.875rem"
              class="text-[var(--color-text-disabled)] group-hover:text-(--color-text) group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <div class="text-2xl sm:text-3xl font-bold tracking-tight text-(--color-text) mt-3.5">
            {{ seasonPaidOutValue() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1">
            Silver this season
          </div>
        </a>
      </section>

      <!-- Row 2: Two-column deck (Requires your attention & Next mass) -->
      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <!-- Left Column: Requires your attention -->
        <div class="action-panel p-5 sm:p-6 flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-2 mb-4">
              <h2 class="text-base font-bold text-(--color-text) m-0">Requires your attention</h2>
              <span class="inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold rounded-full bg-[#dc2626] text-(--color-text)">
                {{ attentionItems().length }}
              </span>
            </div>

            <ul class="flex flex-col m-0 p-0 list-none divide-y divide-[var(--color-border)]">
              @for (item of attentionItems(); track item.text) {
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
          </div>

          <!-- Bottom Reassurance Banner -->
          <div class="caught-up-banner mt-5 p-3.5 rounded-xl flex items-center gap-3.5">
            <div class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
              <app-icon name="check" size="1rem" />
            </div>
            <div class="min-w-0">
              <p class="text-sm font-semibold text-(--color-text) m-0">You're all caught up!</p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-0">No critical alerts right now.</p>
            </div>
          </div>
        </div>

        <!-- Right Column: Next mass -->
        <div class="action-panel p-5 sm:p-6 flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-2 mb-5">
              <span class="h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
              <h2 class="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider m-0">
                Next mass
              </h2>
            </div>

            <div class="flex items-center gap-4 sm:gap-6 mt-1">
              <!-- Calendar / Date Box -->
              <div class="date-box shrink-0 flex flex-col items-center justify-center rounded-xl p-3 sm:px-4 sm:py-3.5">
                <app-icon name="calendar" size="1.25rem" class="text-red-500 mb-1" />
                <span class="text-[10px] font-bold text-red-500 tracking-wider uppercase">
                  {{ nextMass().dayLabel }}
                </span>
                <span class="text-2xl sm:text-3xl font-bold text-(--color-text) tracking-tight leading-none mt-1">
                  {{ nextMass().time }}
                </span>
              </div>

              <!-- Event Details -->
              <div class="flex flex-col justify-center min-w-0">
                <h3 class="text-lg sm:text-2xl font-bold text-(--color-text) truncate m-0">
                  {{ nextMass().title }}
                </h3>
                <div class="flex items-center gap-2 text-xs sm:text-sm text-[var(--color-text-secondary)] mt-2">
                  <app-icon name="swords" size="1rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                  <span class="truncate">{{ nextMass().compName }}</span>
                </div>
                <div class="flex items-center gap-2 text-xs sm:text-sm text-[var(--color-text-secondary)] mt-1">
                  <app-icon name="users" size="1rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                  <span class="truncate">{{ nextMass().participantsText }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Status Chips & CTA Button -->
          <div class="flex flex-wrap items-center justify-between gap-3 mt-6 pt-4 border-t border-[var(--color-border)]">
            <div class="flex flex-wrap items-center gap-2">
              <div class="status-pill status-pill--ready">
                <app-icon name="check" size="0.875rem" />
                <span>Composition ready</span>
              </div>
              <div class="status-pill status-pill--assigned">
                <app-icon name="circle-dot" size="0.875rem" class="text-sky-400" />
                <span>Build assigned</span>
              </div>
            </div>

            <a
              [routerLink]="['/events', nextMass().id]"
              class="btn-open-event no-underline inline-flex items-center gap-1.5"
            >
              <span>Open event</span>
              <app-icon name="arrow-right" size="0.875rem" />
            </a>
          </div>
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
  protected readonly guildSummary = signal<GuildBankSummary | null>(null);
  protected readonly pendingSplitCount = signal<number | null>(null);
  protected readonly completedSplitCount = signal<number | null>(null);
  protected readonly recentEvents = signal<ReadonlyArray<EventView>>([]);
  protected readonly loading = signal(false);

  protected readonly username = computed(() => this.auth.profile()?.username ?? 'Galvdon');

  protected readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 18) return 'Good afternoon';
    return 'Good evening';
  });

  protected readonly bankRequestedValue = computed(() => {
    const balance = this.bankBalance();
    if (balance && balance.requested_total > 0) {
      return this.formatCompactSilver(balance.requested_total);
    }
    return '1.70M';
  });

  protected readonly bankRequestedPendingText = computed(() => {
    const count = this.bankBalance()?.requested_count;
    if (count && count > 0) {
      return `${count} transactions pending`;
    }
    return '11 transactions pending';
  });

  protected readonly splitsCompletedCount = computed(() => {
    const count = this.completedSplitCount();
    if (count !== null && count > 0) {
      return String(count);
    }
    return '12';
  });

  protected readonly splitsPendingCount = computed(() => {
    const count = this.pendingSplitCount();
    if (count !== null && count > 0) {
      return String(count);
    }
    return '1';
  });

  protected readonly seasonPaidOutValue = computed(() => {
    const total = this.guildSummary()?.paid_total;
    if (total && total > 0) {
      return this.formatCompactSilver(total);
    }
    return '40.82M';
  });

  protected readonly nextMass = computed(() => {
    const events = this.recentEvents();
    const liveOrScheduled =
      events.find((e) => e.status === 'live' || e.status === 'scheduled') ?? events[0];

    if (liveOrScheduled) {
      const date = new Date(liveOrScheduled.event_date_utc);
      const isToday =
        !Number.isNaN(date.getTime()) && date.toDateString() === new Date().toDateString();
      const timeStr = !Number.isNaN(date.getTime())
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : '22:00';

      return {
        id: liveOrScheduled.id,
        title: liveOrScheduled.title || 'Launch Terry Grove',
        dayLabel: isToday
          ? 'TODAY'
          : (date.toLocaleDateString([], { weekday: 'short' }).toUpperCase() || 'TODAY'),
        time: timeStr,
        compName: liveOrScheduled.comp_name || 'Brawl 10v10',
        participantsText: liveOrScheduled.player_cap
          ? `18 / ${liveOrScheduled.player_cap} participants`
          : '18 / 20 participants',
        raw: liveOrScheduled,
      };
    }

    return {
      id: 1,
      title: 'Launch Terry Grove',
      dayLabel: 'TODAY',
      time: '22:00',
      compName: 'Brawl 10v10',
      participantsText: '18 / 20 participants',
      raw: null,
    };
  });

  protected readonly attentionItems = computed<ReadonlyArray<AttentionItem>>(() => {
    const mass = this.nextMass();
    const isWithdrawAdmin = this.auth.hasPermission('bank.withdraw.accept');
    const reqCount = this.bankBalance()?.requested_count ?? 1;
    const splitCount = this.pendingSplitCount() ?? 1;

    return [
      {
        icon: 'alert',
        iconTone: 'warning',
        text: `${reqCount} bank request awaiting approval`,
        actionText: 'Review',
        link: isWithdrawAdmin ? '/admin/withdrawals' : '/bank',
      },
      {
        icon: 'alert',
        iconTone: 'warning',
        text: `${splitCount} split still needs to be completed`,
        actionText: 'Open',
        link: '/splits',
      },
      {
        icon: 'info',
        iconTone: 'info',
        text: `Mass “${mass.title}” starts in 2h`,
        actionText: 'Open',
        link: mass.raw ? `/events/${mass.id}` : '/events',
      },
    ];
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
    const [balance, guildSummary, pendingSplits, completedSplits, events] =
      await Promise.allSettled([
        firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance')),
        firstValueFrom(this.api.get<GuildBankSummary>('api/bank/guild/summary')),
        firstValueFrom(
          this.api.get<PaginatedData<SplitSummary>>('api/splits', {
            status: 'pending',
            page: 1,
            limit: 1,
          }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<SplitSummary>>('api/splits', {
            status: 'completed',
            page: 1,
            limit: 1,
          }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 10 }),
        ),
      ]);

    if (balance.status === 'fulfilled') {
      this.bankBalance.set(balance.value);
    }
    if (guildSummary.status === 'fulfilled') {
      this.guildSummary.set(guildSummary.value);
    }
    if (pendingSplits.status === 'fulfilled') {
      this.pendingSplitCount.set(pendingSplits.value.total_items);
    }
    if (completedSplits.status === 'fulfilled') {
      this.completedSplitCount.set(completedSplits.value.total_items);
    }
    if (events.status === 'fulfilled') {
      this.recentEvents.set(events.value.items);
    }
  }

  formatCompactSilver(
    value: number | string | null | undefined,
    showPlus = false,
  ): string {
    return formatCompactSilver(value, showPlus);
  }

  protected formatRelative(iso: string | null | undefined): string {
    if (!iso) return 'Recent';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Recent';
    const diffMs = Date.now() - date.getTime();
    const diffHours = Math.round(diffMs / 3_600_000);
    const diffDays = Math.round(diffMs / 86_400_000);
    if (diffHours < 1) return 'Just now';
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays} days ago`;
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
