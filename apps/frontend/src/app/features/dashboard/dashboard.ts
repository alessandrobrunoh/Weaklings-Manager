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
import { PageHeader } from '../../shared/components/page-header/page-header';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

interface QuickAction {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
}

type StatTone = 'primary' | 'warning' | 'success' | 'neutral';

interface DashboardStat {
  readonly labelKey: TranslationKey;
  readonly sublabelKey?: TranslationKey;
  readonly icon: IconName;
  readonly tone: StatTone;
  readonly value: () => string;
  readonly hint: () => string;
}

/**
 * Landing page of the authenticated experience.
 *
 * Aggregates a cross-module snapshot (bank, splits, events, members) so the
 * first screen is useful without duplicating the richer workflows that live
 * on each feature page. Data loads are best-effort: a failing endpoint only
 * blanks its own card.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, RouterLink, StatusChip],
  template: `
    <app-page-header [title]="welcomeText()" [subtitle]="t('app.tagline')" [actions]="false" />

    <!-- Quick actions -->
    <section class="mb-8">
      <h2
        class="mb-3 text-sm font-semibold uppercase tracking-wider"
        style="color: var(--color-text-secondary)"
      >
        {{ t('dashboard.quick_actions') }}
      </h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        @for (action of actions; track action.path) {
          <a
            [routerLink]="action.path"
            class="card flex flex-col items-start gap-3 p-4 no-underline transition hover:-translate-y-0.5"
            style="color: var(--color-text)"
          >
            <span
              class="flex h-9 w-9 items-center justify-center rounded-full"
              style="background-color: var(--color-primary-container); color: var(--color-primary)"
              aria-hidden="true"
            >
              <app-icon [name]="action.icon" size="1.1rem" />
            </span>
            <span class="text-xs font-medium">{{ t(action.labelKey) }}</span>
          </a>
        }
      </div>
    </section>

    <!-- Guild snapshot -->
    <section class="mb-8">
      <h2
        class="mb-3 text-sm font-semibold uppercase tracking-wider"
        style="color: var(--color-text-secondary)"
      >
        {{ t('dashboard.snapshot') }}
      </h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        @for (stat of stats; track stat.labelKey) {
          <div class="card flex flex-col gap-2 p-4">
            <div class="flex items-center justify-between">
              <span
                class="flex h-8 w-8 items-center justify-center rounded-full"
                [style.backgroundColor]="toneBg(stat.tone)"
                [style.color]="toneFg(stat.tone)"
                aria-hidden="true"
              >
                <app-icon [name]="stat.icon" size="1rem" />
              </span>
              @if (stat.sublabelKey) {
                <span class="text-[10px] uppercase tracking-wider opacity-60">
                  {{ t(stat.sublabelKey) }}
                </span>
              }
            </div>
            <p
              class="text-xl font-semibold leading-tight"
              style="color: var(--color-text)"
              [class.animate-pulse]="stat.value() === '—'"
            >
              {{ stat.value() }}
            </p>
            <p class="text-[11px] font-medium uppercase tracking-wider opacity-70">
              {{ t(stat.labelKey) }}
            </p>
            <p class="text-[11px]" style="color: var(--color-text-secondary)">
              {{ stat.hint() }}
            </p>
          </div>
        }
      </div>
    </section>

    <!-- Two-column activity panels -->
    <section class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <!-- Live & upcoming events -->
      <div class="card p-5">
        <div class="mb-4 flex items-center justify-between">
          <h2
            class="text-sm font-semibold uppercase tracking-wider"
            style="color: var(--color-text-secondary)"
          >
            {{ t('dashboard.events.upcoming') }}
          </h2>
          <a
            routerLink="/events"
            class="text-xs font-medium no-underline hover:underline"
            style="color: var(--color-primary)"
          >
            {{ t('dashboard.view_all') }}
          </a>
        </div>

        @if (visibleEvents().length === 0) {
          <p class="py-6 text-center text-sm" style="color: var(--color-text-secondary)">
            {{ t('dashboard.events.empty') }}
          </p>
        } @else {
          <ul class="flex flex-col gap-2">
            @for (event of visibleEvents(); track event.id) {
              <li>
                <a
                  [routerLink]="['/events', event.id]"
                  class="flex items-center gap-3 rounded-lg p-2 no-underline transition hover:bg-(--color-surface-hover)"
                  style="color: var(--color-text)"
                >
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    [style.backgroundColor]="eventDotColor(event.status)"
                    aria-hidden="true"
                  ></span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">
                      @if (event.call_to_arms) {
                        <span class="cta-star" title="{{ t('events.call_to_arms') }}">★</span>
                      }
                      {{ event.title }}
                    </p>
                    <p class="truncate text-xs" style="color: var(--color-text-secondary)">
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
      <div class="card p-5">
        <div class="mb-4 flex items-center justify-between">
          <h2
            class="text-sm font-semibold uppercase tracking-wider"
            style="color: var(--color-text-secondary)"
          >
            {{ t('dashboard.splits.recent') }}
          </h2>
          <a
            routerLink="/splits"
            class="text-xs font-medium no-underline hover:underline"
            style="color: var(--color-primary)"
          >
            {{ t('dashboard.view_all') }}
          </a>
        </div>

        @if (visibleSplits().length === 0) {
          <p class="py-6 text-center text-sm" style="color: var(--color-text-secondary)">
            {{ t('dashboard.splits.empty') }}
          </p>
        } @else {
          <ul class="flex flex-col gap-2">
            @for (split of visibleSplits(); track split.id) {
              <li>
                <a
                  [routerLink]="['/splits', split.id]"
                  class="flex items-center gap-3 rounded-lg p-2 no-underline transition hover:bg-(--color-surface-hover)"
                  style="color: var(--color-text)"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">
                      {{ split.event_title ?? split.created_by_username }}
                    </p>
                    <p class="truncate text-xs" style="color: var(--color-text-secondary)">
                      {{ split.participant_count }} · {{ formatRelative(split.created_at) }}
                    </p>
                  </div>
                  <span class="text-sm font-semibold tabular-nums">
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
    { path: '/bank', icon: 'bank', labelKey: 'nav.bank' },
    { path: '/splits', icon: 'swords', labelKey: 'nav.splits' },
    { path: '/events', icon: 'calendar', labelKey: 'nav.events' },
    { path: '/battles', icon: 'shield', labelKey: 'nav.battles' },
    { path: '/comps', icon: 'package', labelKey: 'nav.comps' },
    { path: '/siphoned', icon: 'activity', labelKey: 'nav.siphoned' },
  ];

  protected readonly stats: ReadonlyArray<DashboardStat> = [
    {
      labelKey: 'dashboard.stat.balance',
      icon: 'bank',
      tone: 'primary',
      value: () => this.formatNumber(this.bankBalance()?.pending_total ?? null),
      hint: () =>
        this.formatCountHint(this.bankBalance()?.pending_count ?? null, 'dashboard.stat.balance'),
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
    },
    {
      labelKey: 'dashboard.stat.pending_splits',
      icon: 'swords',
      tone: 'neutral',
      value: () => this.formatCount(this.pendingSplitCount()),
      hint: () => this.translate.t('nav.splits'),
    },
    {
      labelKey: 'dashboard.stat.completed_splits',
      icon: 'package',
      tone: 'success',
      value: () => this.formatCount(this.completedSplitCount()),
      hint: () => this.translate.t('nav.splits'),
    },
    {
      labelKey: 'dashboard.stat.live_events',
      icon: 'activity',
      tone: 'success',
      value: () => this.formatCount(this.liveEventCount()),
      hint: () => this.translate.t('dashboard.stat.scheduled_events'),
    },
    {
      labelKey: 'dashboard.stat.guild_paid',
      icon: 'bank',
      tone: 'primary',
      value: () => this.formatNumber(this.guildSummary()?.paid_total ?? null),
      hint: () =>
        this.formatCountHint(this.guildSummary()?.paid_count ?? null, 'dashboard.stat.guild_paid'),
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

  constructor() {
    void this.loadSnapshot();
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
