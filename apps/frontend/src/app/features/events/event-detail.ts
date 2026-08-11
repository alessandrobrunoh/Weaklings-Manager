import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  EventDetailView,
  EventStatus,
  OpponentPerformanceView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';

/**
 * Full-page analytics view for a single guild event.
 *
 * Replaces the legacy inline "Stats" expansion on the events list: instead of
 * cramming performance, opponents, battles, splits and participants inside a
 * small card, the whole route is dedicated to a single event so every metric
 * gets its own section and remains usable on small screens.
 *
 * @example
 * ```ts
 * routes.push({
 *   path: 'events/:eventId',
 *   loadComponent: () => import('./event-detail').then(m => m.EventDetailPage),
 * });
 * ```
 */
@Component({
  selector: 'app-event-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, Loading],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (event(); as detail) {
      <header class="event-detail__hero card p-5">
        <button type="button" class="btn btn--ghost" (click)="backToEvents()">
          ← {{ t('events.detail.back') }}
        </button>

        <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <h1 class="text-3xl font-bold" style="color: var(--color-text)">
                {{ detail.title }}
              </h1>
              <span class="chip" [class]="statusChip(detail.status)">{{ detail.status }}</span>
            </div>
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ formatDate(detail.event_date_utc) }} · {{ t('events.detail.comp') }}:
              {{ detail.active_comp_name || detail.comp_name }} ·
              {{ t('events.detail.comp_capacity') }}: {{ detail.active_comp_capacity }}
            </p>
            @if (detail.description) {
              <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
                {{ detail.description }}
              </p>
            }
          </div>

          <div class="flex flex-wrap gap-2">
            @if (detail.status === 'scheduled') {
              <button type="button" class="btn btn--tonal" (click)="join(detail.id)">
                {{ t('events.participate') }}
              </button>
              <button type="button" class="btn btn--outline" (click)="leave(detail.id)">
                {{ t('events.leave') }}
              </button>
            }
            @if (canManage() && detail.status === 'scheduled') {
              <button type="button" class="btn btn--primary" (click)="start(detail.id)">
                {{ t('events.start') }}
              </button>
            }
            @if (canManage() && detail.status === 'live') {
              <button type="button" class="btn btn--danger" (click)="stop(detail.id)">
                {{ t('events.stop') }}
              </button>
            }
          </div>
        </div>
      </header>

      <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Performance">
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.win_rate') }}</p>
          <p class="event-detail__value">{{ formatPercent(detail.stats.win_rate) }}</p>
          <p class="event-detail__sub">
            {{ detail.stats.wins }} {{ t('events.detail.wins') }} · {{ detail.stats.losses }}
            {{ t('events.detail.losses') }}
          </p>
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.kd') }}</p>
          <p class="event-detail__value">{{ formatRatio(detail.stats.kill_death_ratio) }}</p>
          <p class="event-detail__sub">
            {{ detail.stats.total_kills }} {{ t('events.detail.kills') }} ·
            {{ detail.stats.total_deaths }} {{ t('events.detail.deaths') }}
          </p>
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.kill_fame') }}</p>
          <p class="event-detail__value">{{ formatCompact(detail.stats.total_kill_fame) }}</p>
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.battles_count') }}</p>
          <p class="event-detail__value">{{ detail.stats.total_battles }}</p>
          <p class="event-detail__sub">
            {{ t('events.detail.avg_players') }}:
            {{ formatRatio(detail.stats.average_guild_players) }}
          </p>
        </article>
      </section>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.opponents') }}</h2>
        </header>
        @if (detail.stats.top_opponents.length > 0) {
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('common.name') }}</th>
                  <th>{{ t('events.detail.battles_count') }}</th>
                  <th>{{ t('events.detail.wins') }}</th>
                  <th>{{ t('events.detail.losses') }}</th>
                  <th>{{ t('events.detail.kill_fame') }}</th>
                  <th>{{ t('battles.opponent') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (opponent of detail.stats.top_opponents; track opponentKey(opponent)) {
                  <tr>
                    <td class="font-medium">{{ opponent.guild_name || t('common.none') }}</td>
                    <td>{{ opponent.battles }}</td>
                    <td>{{ opponent.wins }}</td>
                    <td>{{ opponent.losses }}</td>
                    <td>{{ formatCompact(opponent.guild_kill_fame) }}</td>
                    <td style="color: var(--color-text-secondary)">
                      {{ formatCompact(opponent.opponent_kill_fame) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_opponents') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.battles') }}</h2>
          @if (detail.battles.length > 0) {
            <button type="button" class="btn btn--outline" (click)="openBattleGroup(detail)">
              {{ t('battles.group_selected') }}
            </button>
          }
        </header>
        @if (detail.battles.length > 0) {
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{{ t('common.date') }}</th>
                  <th>{{ t('common.status') }}</th>
                  <th>{{ t('battles.players') }}</th>
                  <th>{{ t('battles.kills') }}</th>
                  <th>{{ t('battles.deaths') }}</th>
                  <th>{{ t('battles.kill_fame') }}</th>
                  <th>{{ t('battles.opponent') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (battle of detail.battles; track battle.id) {
                  <tr>
                    <td class="font-medium">{{ battle.albionbb_battle_id }}</td>
                    <td style="color: var(--color-text-secondary)">
                      {{ formatDate(battle.battle_started_at) }}
                    </td>
                    <td>
                      <span
                        class="chip"
                        [class.chip--success]="battle.is_win"
                        [class.chip--danger]="!battle.is_win"
                      >
                        {{ battle.is_win ? t('events.detail.wins') : t('events.detail.losses') }}
                      </span>
                    </td>
                    <td>{{ battle.guild_players_count }}</td>
                    <td>{{ battle.guild_kills }}</td>
                    <td>{{ battle.guild_deaths }}</td>
                    <td>{{ formatCompact(battle.guild_kill_fame) }}</td>
                    <td>{{ battle.opponent_guild_name ?? t('common.none') }}</td>
                    <td>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        (click)="openBattle(battle.albionbb_battle_id)"
                      >
                        {{ t('events.detail.open_battle') }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_battles') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.splits') }}</h2>
        </header>
        @if (detail.split_stats.total_splits > 0) {
          <section class="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Split summary">
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_total') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.total_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_completed') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.completed_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_pending') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.pending_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_lost') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ detail.split_stats.lost_splits }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_not_completed') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.not_completed_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_estimated') }}</p>
              <p class="event-detail__value-sm">
                {{ formatNumber(detail.split_stats.estimated_market_value) }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_repair') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ formatNumber(detail.split_stats.repair_value) }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_bags') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ formatNumber(detail.split_stats.bags_value) }}
              </p>
            </article>
            <article class="surface p-3 sm:col-span-2 xl:col-span-2">
              <p class="event-detail__label">{{ t('events.detail.split_net') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-success)">
                {{ formatNumber(detail.split_stats.completed_net_value) }}
              </p>
            </article>
            <article class="surface p-3 sm:col-span-2 xl:col-span-2">
              <p class="event-detail__label">{{ t('events.detail.split_participant_entries') }}</p>
              <p class="event-detail__value-sm">
                {{ detail.split_stats.participant_entries }}
              </p>
            </article>
          </section>

          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{{ t('common.status') }}</th>
                  <th>{{ t('splits.estimated') }}</th>
                  <th>{{ t('events.detail.split_repair') }}</th>
                  <th>{{ t('splits.net_value') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (split of detail.splits; track split.id) {
                  <tr>
                    <td class="font-medium">#{{ split.id }}</td>
                    <td>
                      <span class="chip">{{ split.status }}</span>
                    </td>
                    <td>{{ formatNumber(split.estimated_market_value) }}</td>
                    <td style="color: var(--color-danger)">
                      {{ formatNumber(split.repair_value) }}
                    </td>
                    <td>
                      {{ formatNumber(split.net_value ?? split.estimated_market_value) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_splits') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.participants') }}</h2>
          <span class="text-xs" style="color: var(--color-text-secondary)">
            {{ detail.participants.length }} / {{ detail.active_comp_capacity }}
          </span>
        </header>
        @if (detail.participants.length > 0) {
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('common.username') }}</th>
                  <th>{{ t('events.detail.primary_build') }}</th>
                  <th>{{ t('events.detail.secondary_build') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (participant of detail.participants; track participant.user_id) {
                  <tr>
                    <td class="font-medium">{{ participant.username }}</td>
                    <td>{{ participant.primary_build_name || t('common.none') }}</td>
                    <td style="color: var(--color-text-secondary)">
                      {{ participant.secondary_build_name ?? t('common.none') }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_participants') }}</p>
        }
      </article>
    } @else {
      <app-empty-state [message]="t('common.empty')" icon="calendar" />
    }
  `,
  styles: `
    @layer components {
      .event-detail__hero {
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .event-detail__label {
        color: var(--color-text-disabled);
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .event-detail__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.75rem);
        font-weight: 700;
      }
      .event-detail__value-sm {
        color: var(--color-text);
        font-size: 1.125rem;
        font-weight: 700;
      }
      .event-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.8rem;
        margin-top: 0.25rem;
      }
      .event-detail__section-header {
        align-items: center;
        border-bottom: 1px solid var(--color-border);
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: space-between;
        padding: 1rem;
      }
      .event-detail__section-header h2 {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
      }
      .event-detail__empty {
        color: var(--color-text-secondary);
        font-size: 0.875rem;
        padding: 1rem;
      }
    }
  `,
})
export class EventDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly event = signal<EventDetailView | null>(null);
  protected readonly loading = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** Returns to the events list without relying on browser history state. */
  protected backToEvents(): void {
    void this.router.navigate(['/events']);
  }

  /** True when the current user can start/stop or edit this event. */
  protected canManage(): boolean {
    return this.auth.hasPermission('events.manage');
  }

  /** Joins the scheduled event as a participant. */
  protected async join(id: number): Promise<void> {
    this.toasts.info('Open event detail to select a build before joining.');
    void id;
  }

  /** Leaves the scheduled event. */
  protected async leave(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/participate`, 'DELETE', null);
  }

  /** Marks the event as live; reserved to officers/admins. */
  protected async start(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/start`, 'POST', {});
  }

  /** Stops a live event; reserved to officers/admins. */
  protected async stop(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/stop`, 'POST', {});
  }

  /** Opens the battle detail route for a specific AlbionBB battle. */
  protected openBattle(albionbbBattleId: string): void {
    void this.router.navigate(['/battles', albionbbBattleId]);
  }

  /** Groups every linked battle for side-by-side comparison. */
  protected openBattleGroup(detail: EventDetailView): void {
    const ids = detail.battles.map((battle) => battle.albionbb_battle_id);
    if (ids.length === 0) {
      return;
    }
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }

  /** Formats ISO date strings using the browser locale. */
  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Formats large numbers with locale separators. */
  protected formatNumber(value: number | string): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  /** Compacts large fame/silver values for compact display. */
  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  /** Formats a 0–100 win-rate value. */
  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  /** Formats kill/death or other ratios with two decimals. */
  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  /** Maps event lifecycle to chip color modifiers. */
  protected statusChip(status: EventStatus): string {
    if (status === 'live') {
      return 'chip chip--success';
    }
    if (status === 'auto_stopped') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  /** Provides a stable track key when AlbionBB omits the opponent guild id. */
  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  private async load(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('eventId');
    if (!id) {
      this.toasts.error(this.t('common.error'));
      void this.router.navigate(['/events']);
      return;
    }

    this.loading.set(true);
    try {
      const detail = await firstValueFrom(this.api.get<EventDetailView>(`api/events/${id}`));
      this.event.set(detail);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async mutate(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<void> {
    try {
      if (method === 'POST') {
        await firstValueFrom(this.api.post<EventDetailView>(path, body));
      } else {
        await firstValueFrom(this.api.delete<EventDetailView>(path));
      }
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}
