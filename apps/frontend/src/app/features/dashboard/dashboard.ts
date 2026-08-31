import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
  EventStatus,
  EventView,
  GuildBankSummary,
  PaginatedData,
  SplitSummary,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

interface QuickAction {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  readonly desc: string;
}

type StatTone = 'primary' | 'warning' | 'success' | 'neutral';

interface DashboardStat {
  readonly labelKey: TranslationKey;
  readonly sublabelKey?: TranslationKey;
  readonly icon: IconName;
  readonly tone: StatTone;
  readonly value: () => string;
  readonly hint: () => string;
  readonly tooltip: string;
}

/**
 * Landing page of the authenticated experience.
 *
 * Provides a high-utility command center with real-time guild KPIs,
 * quick action portals, live events, and recent loot splits.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink, StatCard, StatusChip, TooltipDirective],
  styles: `
    .dashboard-shortcut {
      display: flex;
      min-block-size: 2.75rem;
      align-items: center;
      gap: 0.625rem;
      padding: 0.5rem 0.625rem;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface);
      color: var(--color-text);
      text-decoration: none;
    }
    .dashboard-shortcut:hover { border-color: var(--color-border-strong); background: var(--color-surface-hover); }
    .dashboard-shortcut__icon { display: inline-flex; inline-size: 1.75rem; block-size: 1.75rem; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 4px; background: var(--color-surface-2); color: var(--color-text-tertiary); }
    .dashboard-shortcut__copy { min-inline-size: 0; }
  `,
  template: `
    <app-page-header [title]="welcomeText()" [subtitle]="t('app.tagline')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="'Aggiorna dati in tempo reale'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- Guild operational snapshot -->
      <section aria-label="Guild snapshot">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
          @for (stat of stats; track stat.labelKey) {
            <div [appTooltip]="stat.tooltip" tooltipPosition="top">
              <app-stat-card
                [label]="t(stat.labelKey)"
                [value]="stat.value()"
                [sub]="stat.hint()"
                [icon]="stat.icon"
                [tone]="stat.tone"
              />
            </div>
          }
        </div>
      </section>

      <!-- Quick action navigation hubs -->
      <section aria-label="Quick actions">
        <h2 class="eyebrow mb-2">
          {{ t('dashboard.quick_actions') }}
        </h2>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
          @for (action of actions; track action.path) {
            <a
              [routerLink]="action.path"
              class="dashboard-shortcut"
              style="color: var(--color-text)"
              [appTooltip]="action.desc"
              tooltipPosition="top"
            >
              <span
                class="dashboard-shortcut__icon"
                style="background-color: var(--color-surface-2); color: var(--color-text)"
                aria-hidden="true"
              >
                <app-icon [name]="action.icon" size="1.125rem" />
              </span>
              <div class="dashboard-shortcut__copy">
                <span class="text-xs font-medium block truncate group-hover:underline">{{ t(action.labelKey) }}</span>
                <span class="text-[11px] block truncate mt-0.5" style="color: var(--color-text-secondary)">{{ action.desc }}</span>
              </div>
            </a>
          }
        </div>
      </section>

      <!-- Two-column activity panels -->
      <section class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <!-- Live & upcoming events -->
        <div class="card p-4">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="inline-block h-2 w-2 rounded-full" style="background-color: var(--color-success)"></span>
              <h2 class="eyebrow">
                {{ t('dashboard.events.upcoming') }}
              </h2>
            </div>
            <a
              routerLink="/events"
              class="text-xs font-medium no-underline hover:underline"
              style="color: var(--color-text-secondary)"
              [appTooltip]="'Tutti gli eventi di gilda'"
              tooltipPosition="left"
            >
              {{ t('dashboard.view_all') }} →
            </a>
          </div>

          @if (visibleEvents().length === 0) {
            <div class="py-8 text-center" style="color: var(--color-text-secondary)">
              <app-icon name="calendar" size="2rem" class="opacity-40 mx-auto mb-2" />
              <p class="text-sm">{{ t('dashboard.events.empty') }}</p>
            </div>
          } @else {
            <ul class="flex flex-col gap-2">
              @for (event of visibleEvents(); track event.id) {
                <li>
                  <a
                    [routerLink]="['/events', event.id]"
                    class="flex items-center gap-3 rounded-md px-2 py-2 no-underline transition-colors hover:bg-[var(--color-surface-hover)]"
                    style="color: var(--color-text)"
                  >
                    <span
                      class="h-2.5 w-2.5 shrink-0 rounded-full"
                      [style.backgroundColor]="eventDotColor(event.status)"
                      [appTooltip]="event.status"
                      aria-hidden="true"
                    ></span>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium flex items-center gap-1.5">
                        @if (event.call_to_arms) {
                          <span
                            class="cta-star font-bold text-xs"
                            [appTooltip]="t('events.call_to_arms')"
                            style="color: var(--color-warning)"
                          >★ CTA</span>
                        }
                        {{ event.title }}
                      </p>
                      <p class="truncate text-xs mt-0.5" style="color: var(--color-text-secondary)">
                        {{ event.comp_name }} · {{ formatEventDate(event.event_date_utc) }}
                      </p>
                    </div>
                    <app-status-chip [value]="event.status" />
                  </a>
                </li>
              }
            </ul>
          }
        </div>

        <!-- Recent splits -->
        <div class="card p-4">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="inline-block h-2 w-2 rounded-full" style="background-color: var(--color-primary)"></span>
              <h2 class="eyebrow">
                {{ t('dashboard.splits.recent') }}
              </h2>
            </div>
            <a
              routerLink="/splits"
              class="text-xs font-medium no-underline hover:underline"
              style="color: var(--color-text-secondary)"
              [appTooltip]="'Tutte le split di bottino'"
              tooltipPosition="left"
            >
              {{ t('dashboard.view_all') }} →
            </a>
          </div>

          @if (visibleSplits().length === 0) {
            <div class="py-8 text-center" style="color: var(--color-text-secondary)">
              <app-icon name="swords" size="2rem" class="opacity-40 mx-auto mb-2" />
              <p class="text-sm">{{ t('dashboard.splits.empty') }}</p>
            </div>
          } @else {
            <ul class="flex flex-col gap-2">
              @for (split of visibleSplits(); track split.id) {
                <li>
                  <a
                    [routerLink]="['/splits', split.id]"
                    class="flex items-center gap-3 rounded-md px-2 py-2 no-underline transition-colors hover:bg-[var(--color-surface-hover)]"
                    style="color: var(--color-text)"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">
                        {{ split.event_title ?? split.created_by_username }}
                      </p>
                      <p class="truncate text-xs mt-0.5" style="color: var(--color-text-secondary)">
                        {{ split.participant_count }} partecipanti · {{ formatRelative(split.created_at) }}
                      </p>
                    </div>
                    <span class="text-sm font-semibold tabular-nums mono" style="color: var(--color-success)">
                      {{ formatValue(split.estimated_market_value) }}
                    </span>
                    <app-status-chip [value]="split.status" />
                  </a>
                </li>
              }
            </ul>
          }
        </div>
      </section>
    </app-page-stack>
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
  protected readonly liveEventCount = signal<number | null>(null);
  protected readonly scheduledEventCount = signal<number | null>(null);

  protected readonly recentEvents = signal<ReadonlyArray<EventView>>([]);
  protected readonly recentSplits = signal<ReadonlyArray<SplitSummary>>([]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly welcomeText = computed(() => {
    const name = this.auth.profile()?.username ?? '';
    const greetingKey = this.greetingKeyForNow();
    const greeting = this.translate.t(greetingKey);
    return name ? `${greeting}, ${name}` : greeting;
  });

  protected readonly actions: ReadonlyArray<QuickAction> = [
    { path: '/bank', icon: 'bank', labelKey: 'nav.bank', desc: 'Saldo e prelievi' },
    { path: '/splits', icon: 'swords', labelKey: 'nav.splits', desc: 'Divisione bottino' },
    { path: '/events', icon: 'calendar', labelKey: 'nav.events', desc: 'Attività & CTA' },
    { path: '/battles', icon: 'shield', labelKey: 'nav.battles', desc: 'Registro PvP' },
    { path: '/comps', icon: 'package', labelKey: 'nav.comps', desc: 'Build & setup' },
    { path: '/siphoned', icon: 'activity', labelKey: 'nav.siphoned', desc: 'Monitor energia' },
  ];

  protected readonly stats: ReadonlyArray<DashboardStat> = [
    {
      labelKey: 'dashboard.stat.balance',
      icon: 'bank',
      tone: 'primary',
      value: () => this.formatNumber(this.bankBalance()?.pending_total ?? null),
      hint: () =>
        this.formatCountHint(this.bankBalance()?.pending_count ?? null, 'dashboard.stat.balance'),
      tooltip: 'Argento in attesa nel bilancio personale',
    },
    {
      labelKey: 'dashboard.stat.requested',
      icon: 'bank',
      tone: 'warning',
      value: () => this.formatNumber(this.bankBalance()?.requested_total ?? null),
      hint: () =>
        this.formatCountHint(
          this.bankBalance()?.requested_count ?? null,
          'dashboard.stat.requested',
        ),
      tooltip: 'Argento richiesto per il prelievo',
    },
    {
      labelKey: 'dashboard.stat.pending_splits',
      icon: 'swords',
      tone: 'neutral',
      value: () => this.formatCount(this.pendingSplitCount()),
      hint: () => this.translate.t('nav.splits'),
      tooltip: 'Divisioni di bottino in attesa di liquidazione',
    },
    {
      labelKey: 'dashboard.stat.completed_splits',
      icon: 'package',
      tone: 'success',
      value: () => this.formatCount(this.completedSplitCount()),
      hint: () => this.translate.t('nav.splits'),
      tooltip: 'Divisioni di bottino completate con successo',
    },
    {
      labelKey: 'dashboard.stat.live_events',
      icon: 'activity',
      tone: 'success',
      value: () => this.formatCount(this.liveEventCount()),
      hint: () => this.translate.t('dashboard.stat.scheduled_events'),
      tooltip: 'Eventi e attività di gilda attualmente in corso',
    },
    {
      labelKey: 'dashboard.stat.guild_paid',
      icon: 'bank',
      tone: 'primary',
      value: () => this.formatNumber(this.guildSummary()?.paid_total ?? null),
      hint: () =>
        this.formatCountHint(this.guildSummary()?.paid_count ?? null, 'dashboard.stat.guild_paid'),
      tooltip: 'Totale argento liquidato complessivamente dalla gilda',
    },
  ];

  /** Up to 5 most recent events, prioritising live then scheduled. */
  protected visibleEvents = computed<ReadonlyArray<EventView>>(() => {
    const items = [...this.recentEvents()];
    return items.sort((a, b) => this.eventRank(a) - this.eventRank(b)).slice(0, 5);
  });

  protected visibleSplits = computed<ReadonlyArray<SplitSummary>>(() =>
    this.recentSplits().slice(0, 5),
  );

  protected readonly loading = signal(false);

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
    const [balance, guildSummary, pendingSplits, completedSplits, events, recentSplits] =
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
          this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 25 }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<SplitSummary>>('api/splits', { page: 1, limit: 5 }),
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
      const list = events.value.items;
      this.recentEvents.set(list);
      this.liveEventCount.set(list.filter((event) => event.status === 'live').length);
      this.scheduledEventCount.set(list.filter((event) => event.status === 'scheduled').length);
    }
    if (recentSplits.status === 'fulfilled') {
      this.recentSplits.set(recentSplits.value.items);
    }
  }

  private greetingKeyForNow(): TranslationKey {
    const hour = new Date().getHours();
    if (hour < 12) return 'dashboard.greeting.morning';
    if (hour < 18) return 'dashboard.greeting.afternoon';
    return 'dashboard.greeting.evening';
  }

  private eventRank(event: EventView): number {
    // Live first, then scheduled, then by date ascending.
    if (event.status === 'live') return 0;
    if (event.status === 'scheduled') return 1;
    return 2;
  }

  private formatCount(value: number | null): string {
    return value === null ? '—' : value.toLocaleString();
  }

  protected formatNumber(value: number | null): string {
    return value === null ? '—' : value.toLocaleString();
  }

  private formatCountHint(count: number | null, _key: TranslationKey): string {
    if (count === null) return '';
    return `${count} tx`;
  }

  protected formatValue(value: number): string {
    return value.toLocaleString();
  }

  protected formatEventDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected formatRelative(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const diffMs = date.getTime() - Date.now();
    const diffDays = Math.round(diffMs / 86_400_000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (Math.abs(diffDays) >= 1) return rtf.format(diffDays, 'day');
    const diffHours = Math.round(diffMs / 3_600_000);
    return rtf.format(diffHours, 'hour');
  }

  // --- Tone palettes for stat cards ---

  protected toneBg(tone: StatTone): string {
    return TONE_BG[tone];
  }

  protected toneFg(tone: StatTone): string {
    return TONE_FG[tone];
  }

  protected eventDotColor(status: EventStatus): string {
    if (status === 'live') return 'var(--color-success)';
    if (status === 'scheduled') return 'var(--color-primary)';
    return 'var(--color-text-disabled)';
  }
}

const TONE_BG: Record<StatTone, string> = {
  primary: 'var(--color-primary-container)',
  warning: 'var(--color-warning-container)',
  success: 'var(--color-success-container)',
  neutral: 'var(--color-surface-2)',
};

const TONE_FG: Record<StatTone, string> = {
  primary: 'var(--color-primary)',
  warning: 'var(--color-warning)',
  success: 'var(--color-success)',
  neutral: 'var(--color-text-secondary)',
};
