import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  BalanceSummary,
  EventStatus,
  EventView,
  ProgressionMeView,
  UserMetrics,
} from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import type { MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';

interface AttentionItem {
  readonly id: string;
  readonly icon: IconName;
  readonly iconTone: 'warning' | 'info';
  readonly text: string;
  readonly actionText: string;
  readonly link: string;
}

/** One row of the events tables; `when` and `comp` are already translated and formatted. */
interface EventRow {
  readonly id: number;
  readonly title: string;
  readonly when: string;
  readonly comp: string;
  readonly capText: string | null;
  readonly status: EventStatus;
}

const UPCOMING_LIMIT = 5;
const RECENT_LIMIT = 5;
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };

/**
 * Personal home for members and officers.
 *
 * Order is what needs the reader first: things waiting on them, then the events they can act on,
 * then the figures for their season and bank, then what recently finished. Every number comes from
 * the member's own endpoints; guild-wide finance and officer queues live on `/guild` and `/admin`.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
  ],
  template: `
    <app-page-header
      [title]="greeting() + ', ' + username()"
      [subtitle]="albionLabel()"
      [badge]="roleLabel()"
      [menuItems]="menuItems()"
      (menuSelect)="onMenuSelect($event)"
    >
      <a routerLink="/profile" class="btn btn--outline btn--sm no-underline">
        {{ t('dashboard.open_profile') }}
      </a>
    </app-page-header>

    <app-page-stack>
      <section class="card p-4" aria-labelledby="dash-attention">
        <h2 class="section-title" id="dash-attention">{{ t('dashboard.attention.title') }}</h2>
        @if (loading()) {
          <app-loading variant="lines" [rows]="3" [label]="t('common.loading')" />
        } @else if (attentionIncomplete()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="refreshNow()"
          />
        } @else if (attentionItems().length > 0) {
          <ul class="mt-2 divide-y divide-[var(--color-border)]">
            @for (item of attentionItems(); track item.id) {
              <li class="flex items-center justify-between gap-3 py-2.5">
                <div class="flex min-w-0 items-center gap-2.5">
                  <app-icon
                    [name]="item.icon"
                    size="1rem"
                    class="shrink-0"
                    [class.text-(--color-warning)]="item.iconTone === 'warning'"
                    [class.text-(--color-info)]="item.iconTone === 'info'"
                  />
                  <span class="min-w-0 text-sm">{{ item.text }}</span>
                </div>
                <a [routerLink]="item.link" class="btn btn--ghost btn--sm shrink-0 no-underline">
                  {{ item.actionText }}
                </a>
              </li>
            }
          </ul>
        } @else {
          <app-empty-state
            [compact]="true"
            icon="check"
            [message]="t('dashboard.attention.caught_up')"
            [hint]="t('dashboard.attention.caught_up_hint')"
          />
        }
      </section>

      <section class="card p-4" aria-labelledby="dash-events">
        <div class="mb-2 flex items-center justify-between gap-3">
          <h2 class="section-title" id="dash-events">{{ t('dashboard.events.upcoming') }}</h2>
          <a routerLink="/events" class="text-xs no-underline hover:underline" style="color: var(--color-primary)">
            {{ t('dashboard.view_all') }}
          </a>
        </div>
        @if (loading()) {
          <app-loading variant="table" [rows]="3" [label]="t('common.loading')" />
        } @else if (eventsIncomplete()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="refreshNow()"
          />
        } @else if (upcomingRows().length === 0) {
          <app-empty-state
            [compact]="true"
            icon="calendar"
            [message]="t('dashboard.events.empty')"
            [hint]="t('dashboard.next_mass.empty_hint')"
          />
        } @else {
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t('dashboard.col.when') }}</th>
                  <th scope="col">{{ t('dashboard.col.event') }}</th>
                  <th scope="col">{{ t('dashboard.col.comp') }}</th>
                  <th scope="col">{{ t('dashboard.col.status') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of upcomingRows(); track row.id) {
                  <tr>
                    <td class="num whitespace-nowrap">{{ row.when }}</td>
                    <td>
                      <a [routerLink]="['/events', row.id]" class="no-underline hover:underline">{{ row.title }}</a>
                    </td>
                    <td>
                      {{ row.comp }}
                      @if (row.capText) {
                        <span class="hint block">{{ row.capText }}</span>
                      }
                    </td>
                    <td>
                      <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (loading()) {
        <app-loading variant="summary" [cells]="4" [label]="t('common.loading')" />
      } @else {
        <app-summary-band [ariaLabel]="t('dashboard.kpis')" [items]="summaryItems()" />
      }

      <section class="card p-4" aria-labelledby="dash-recent">
        <div class="mb-2 flex items-center justify-between gap-3">
          <h2 class="section-title" id="dash-recent">{{ t('dashboard.recent_activity') }}</h2>
          <a routerLink="/events" class="text-xs no-underline hover:underline" style="color: var(--color-primary)">
            {{ t('dashboard.view_all') }}
          </a>
        </div>
        @if (loading()) {
          <app-loading variant="table" [rows]="3" [label]="t('common.loading')" />
        } @else if (recentIncomplete()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="refreshNow()"
          />
        } @else if (recentRows().length === 0) {
          <app-empty-state [compact]="true" icon="calendar" [message]="t('dashboard.recent.empty')" />
        } @else {
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t('dashboard.col.when') }}</th>
                  <th scope="col">{{ t('dashboard.col.event') }}</th>
                  <th scope="col">{{ t('dashboard.col.comp') }}</th>
                  <th scope="col">{{ t('dashboard.col.status') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of recentRows(); track row.id) {
                  <tr>
                    <td class="num whitespace-nowrap">{{ row.when }}</td>
                    <td>
                      <a [routerLink]="['/events', row.id]" class="no-underline hover:underline">{{ row.title }}</a>
                    </td>
                    <td>{{ row.comp }}</td>
                    <td>
                      <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </app-page-stack>
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
  /** Live and scheduled events, the source of the upcoming list and the attention items. */
  protected readonly recentEvents = signal<ReadonlyArray<EventView>>([]);
  /** Stopped and auto-stopped events, newest first. */
  protected readonly recentFinished = signal<ReadonlyArray<EventView>>([]);
  protected readonly loading = signal(true);
  protected readonly attentionIncomplete = signal(false);
  protected readonly eventsIncomplete = signal(false);
  protected readonly recentIncomplete = signal(false);

  protected readonly username = computed(() => this.auth.profile()?.username ?? '');
  protected readonly roleLabel = computed(() => this.auth.profile()?.highest_role ?? '');

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly menuItems = computed<MenuItem[]>(() => [
    { id: 'refresh', label: this.t('dashboard.refresh'), icon: 'refresh', disabled: this.loading() },
  ]);

  protected readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return this.t('dashboard.greeting.morning');
    if (hour >= 12 && hour < 18) return this.t('dashboard.greeting.afternoon');
    return this.t('dashboard.greeting.evening');
  });

  protected readonly albionLabel = computed(() => {
    const link = this.albionLink();
    if (!link) return this.loading() ? this.t('common.loading') : this.t('common.error');
    if (link.linked && link.albion_player_name) {
      return this.t('dashboard.albion.character', { name: link.albion_player_name });
    }
    return this.t('dashboard.albion.unlinked');
  });

  protected readonly pendingValue = computed(() =>
    this.formatCompactSilver(this.bankBalance()?.pending_total),
  );

  protected readonly earningsValue = computed(() =>
    this.formatCompactSilver(this.metrics()?.split_earnings),
  );

  protected readonly attendanceValue = computed(() => {
    const rate = this.metrics()?.attendance_rate;
    if (rate === null || rate === undefined) return null;
    return `${Math.round(rate)}%`;
  });

  protected readonly seasonRankLabel = computed(() => {
    const rank = this.progression()?.rank;
    if (rank == null) return this.t('profile.xp.unranked');
    return this.t('dashboard.stat.season_rank', { rank });
  });

  /** Figures for the summary band. Each one names its state in the hint when it is missing. */
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const xp = this.progression();
    const balance = this.bankBalance();
    const metrics = this.metrics();
    const failed = this.t('common.error');
    return [
      {
        label: xp ? (xp.season?.name || this.t('profile.xp.noSeason')) : this.t('dashboard.summary.season'),
        value: xp ? this.t('dashboard.stat.season_level', { level: xp.level }) : null,
        hint: xp
          ? `${this.seasonRankLabel()} · ${this.t('dashboard.stat.xp_progress', {
              current: this.formatAmount(xp.xp),
              next: this.formatAmount(xp.xp + xp.xp_to_next),
            })}`
          : failed,
      },
      {
        label: this.t('dashboard.summary.available'),
        value: balance ? this.pendingValue() : null,
        hint: balance ? undefined : failed,
      },
      {
        label: this.t('dashboard.stat.earnings'),
        value: metrics ? this.earningsValue() : null,
        hint: metrics ? this.t('dashboard.stat.earnings_sub', { count: metrics.splits_joined }) : failed,
      },
      {
        label: this.t('dashboard.stat.attendance'),
        value: metrics ? this.attendanceValue() : null,
        hint: metrics
          ? this.t('dashboard.stat.attendance_sub', {
              attended: metrics.events_attended,
              total: metrics.events_total,
            })
          : failed,
      },
    ];
  });

  protected readonly upcomingRows = computed<EventRow[]>(() =>
    selectUpcomingEvents(this.recentEvents())
      .slice(0, UPCOMING_LIMIT)
      .map((event) => this.toRow(event, this.dayTimeLabel(event))),
  );

  protected readonly recentRows = computed<EventRow[]>(() =>
    this.recentFinished().map((event) => this.toRow(event, this.dateTimeLabel(event))),
  );

  protected readonly attentionItems = computed<ReadonlyArray<AttentionItem>>(() => {
    const items: AttentionItem[] = [];
    const balance = this.bankBalance();
    const metrics = this.metrics();
    const link = this.albionLink();
    const nextEvent = selectNextMass(this.recentEvents());

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

    if (balance && balance.pending_total > 0) {
      items.push({
        id: 'withdraw',
        icon: 'bank',
        iconTone: 'info',
        text: this.t('dashboard.attention.withdraw_available'),
        actionText: this.t('dashboard.attention.withdraw_action'),
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
    void this.refreshNow();
  }

  protected async refreshNow(): Promise<void> {
    this.loading.set(true);
    this.bankBalance.set(null);
    this.metrics.set(null);
    this.progression.set(null);
    this.albionLink.set(null);
    this.recentEvents.set([]);
    this.recentFinished.set([]);
    try {
      await this.loadSnapshot();
    } finally {
      this.loading.set(false);
    }
  }

  protected onMenuSelect(id: string): void {
    if (id === 'refresh') void this.refreshNow();
  }

  protected statusLabel(status: EventStatus): string {
    switch (status) {
      case 'live':
        return this.t('events.status.live');
      case 'scheduled':
        return this.t('events.status.scheduled');
      case 'stopped':
        return this.t('events.status.stopped');
      case 'auto_stopped':
        return this.t('events.status.auto_stopped');
      case 'cancelled':
        return this.t('events.status.cancelled');
    }
  }

  private async loadSnapshot(): Promise<void> {
    const [balance, metrics, progression, albion, scheduledEvents, liveEvents, stoppedEvents, autoStoppedEvents] =
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
        firstValueFrom(
          this.api.get<{ items: EventView[] }>('api/events', {
            page: 1,
            limit: RECENT_LIMIT,
            status: 'stopped',
            sort: 'mass_time_utc',
            order: 'desc',
          }),
        ),
        firstValueFrom(
          this.api.get<{ items: EventView[] }>('api/events', {
            page: 1,
            limit: RECENT_LIMIT,
            status: 'auto_stopped',
            sort: 'mass_time_utc',
            order: 'desc',
          }),
        ),
      ]);

    if (balance.status === 'fulfilled') this.bankBalance.set(balance.value);
    if (metrics.status === 'fulfilled') this.metrics.set(metrics.value);
    if (progression.status === 'fulfilled') this.progression.set(progression.value);
    if (albion.status === 'fulfilled') this.albionLink.set(albion.value);

    this.eventsIncomplete.set(scheduledEvents.status === 'rejected' || liveEvents.status === 'rejected');
    this.attentionIncomplete.set(
      balance.status === 'rejected' || metrics.status === 'rejected' ||
      albion.status === 'rejected' || this.eventsIncomplete(),
    );

    const upcoming: EventView[] = [];
    if (liveEvents.status === 'fulfilled') upcoming.push(...liveEvents.value.items);
    if (scheduledEvents.status === 'fulfilled') upcoming.push(...scheduledEvents.value.items);
    this.recentEvents.set(upcoming);

    this.recentIncomplete.set(stoppedEvents.status === 'rejected' || autoStoppedEvents.status === 'rejected');
    const finished: EventView[] = [];
    if (stoppedEvents.status === 'fulfilled') finished.push(...stoppedEvents.value.items);
    if (autoStoppedEvents.status === 'fulfilled') finished.push(...autoStoppedEvents.value.items);
    this.recentFinished.set(finished.sort((a, b) => byMassTime(b, a)).slice(0, RECENT_LIMIT));
  }

  formatCompactSilver(
    value: number | string | null | undefined,
    showPlus = false,
  ): string {
    return formatCompactSilver(value, showPlus);
  }

  protected formatAmount(value: number | string): string {
    return new Intl.NumberFormat(this.translate.locale()).format(Number(value ?? 0));
  }

  private toRow(event: EventView, when: string): EventRow {
    return {
      id: event.id,
      title: event.title,
      when,
      comp: event.event_kind === 'flash' ? this.t('events.flashMass') : (event.comp_name ?? '—'),
      capText: event.player_cap ? this.t('dashboard.next_mass.cap', { count: event.player_cap }) : null,
      status: event.status,
    };
  }

  /** "Today 19:30" or "Fri 19:30" for an upcoming mass. */
  private dayTimeLabel(event: EventView): string {
    const massAt = eventMassAt(event);
    if (!massAt) return '—';
    const locale = this.translate.locale();
    const isToday = massAt.toDateString() === new Date().toDateString();
    const day = isToday
      ? this.t('dashboard.next_mass.today')
      : massAt.toLocaleDateString(locale, { weekday: 'short' });
    return `${day} ${massAt.toLocaleTimeString(locale, TIME_OPTIONS)}`;
  }

  /** "Nov 9 19:30" for a finished mass. */
  private dateTimeLabel(event: EventView): string {
    const massAt = eventMassAt(event);
    if (!massAt) return '—';
    const locale = this.translate.locale();
    const day = massAt.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    return `${day} ${massAt.toLocaleTimeString(locale, TIME_OPTIONS)}`;
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
 * Events the member can still act on, in order: live ones first, then scheduled ones whose start
 * has not passed yet. Each group is sorted by mass time.
 */
export function selectUpcomingEvents(
  events: readonly EventView[],
  now: Date = new Date(),
): EventView[] {
  const nowMs = now.getTime();
  const live = events.filter((event) => event.status === 'live').sort(byMassTime);
  const scheduled = events
    .filter((event) => event.status === 'scheduled')
    .filter((event) => {
      const startAt = eventStartAt(event);
      return startAt !== null && startAt.getTime() >= nowMs;
    })
    .sort(byMassTime);
  return [...live, ...scheduled];
}

/** The event the attention list points at: the first upcoming one, live or scheduled. */
export function selectNextMass(
  events: readonly EventView[],
  now: Date = new Date(),
): EventView | null {
  return selectUpcomingEvents(events, now)[0] ?? null;
}
