import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { BattleLossEstimate, EventDetailView } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Avatar } from '../../../shared/components/avatar/avatar';
import { Icon } from '../../../shared/components/icon/icon';
import { undecidedFights, winRatePercent } from '../../battles/battle-metrics';
import {
  formatAmount,
  formatCompact,
  formatNumber,
  formatPercent,
  formatRatio,
} from './event-detail.utils';

/** Overview tab of the event detail page: performance and financial KPIs, intel and losses. */
@Component({
  selector: 'app-event-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Icon, RouterLink],
  template: `
    @let detail = event();
    <!-- Performance & Financial KPI Cards -->
    <section
      class="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-4 mb-5"
      aria-label="Event Overview KPIs"
    >
      <!-- Card 1: Win Rate -->
      <article class="surface p-4">
        <p class="event-detail__label">{{ t('events.detail.win_rate') }}</p>
        <p class="event-detail__value mt-1">
          {{ winRate() === null ? '—' : formatPercent(winRate()!) }}
        </p>
        <p class="event-detail__sub mb-2">
          {{ detail.stats.wins }} {{ t('events.detail.wins') }} &middot; {{ detail.stats.losses }}
          {{ t('events.detail.losses') }}
        </p>
        @if (winRate() !== null) {
          <div class="event-detail__fill-bar" style="background: var(--color-danger)">
            <span [style.width.%]="winRate()" style="background: var(--color-success)"></span>
          </div>
        }
        @if (undecided() > 0) {
          <p class="event-detail__sub mt-2">
            {{ t('events.detail.win_rate_undecided', { count: undecided() }) }}
          </p>
        }
      </article>

      <!-- Card 2: K/D Ratio & Kill Fame -->
      <article class="surface p-4">
        <p class="event-detail__label">
          {{ t('events.detail.kd') }} &middot; {{ t('events.detail.kill_fame') }}
        </p>
        <p class="event-detail__value mt-1">
          {{ formatRatio(detail.stats.kill_death_ratio) }}
        </p>
        <p class="event-detail__sub mb-2">
          {{ detail.stats.total_kills }} {{ t('events.detail.kills') }} &middot;
          {{ detail.stats.total_deaths }} {{ t('events.detail.deaths') }}
        </p>
        <p class="text-xs font-mono text-[var(--color-text-secondary)]">
          {{ t('battles.fame') }}:
          <strong class="text-[var(--color-text)]">{{
            formatCompact(detail.stats.total_kill_fame)
          }}</strong>
        </p>
      </article>

      <!-- Card 3: Estimated Combat Losses / Regear Expenses -->
      <article class="surface p-4">
        <p class="event-detail__label">{{ t('events.detail.our_guild_loss') }}</p>
        <p class="event-detail__value mt-1 text-[var(--color-danger)] font-mono">
          -{{ formatAmount(eventLossEstimate().total_estimated_loss) }}
        </p>
        <p class="event-detail__sub">
          {{ eventLossEstimate().priced_items }}/{{ eventLossEstimate().total_items }}
          {{ t('events.detail.our_guild_loss_hint') }}
        </p>
      </article>

      <!-- Card 4: Net Financial Outcome (Loot vs Expenses) -->
      <article
        class="surface p-4"
        [class.border-[var(--color-success)]]="eventBalance().isProfitable"
        [class.border-[var(--color-danger)]]="!eventBalance().isProfitable"
      >
        <p class="event-detail__label">{{ t('events.detail.net_balance') }}</p>
        <p
          class="event-detail__value mt-1 font-mono"
          [class.text-[var(--color-success)]]="eventBalance().isProfitable"
          [class.text-[var(--color-danger)]]="!eventBalance().isProfitable"
        >
          {{ eventBalance().netBalance >= 0 ? '+' : ''
          }}{{ formatAmount(eventBalance().netBalance) }}
        </p>
        <p class="event-detail__sub">
          {{
            t('events.detail.balance_breakdown', {
              loot: formatCompact(eventBalance().totalLoot),
              loss: formatCompact(eventBalance().totalLoss),
            })
          }}
        </p>
      </article>
    </section>

    <!-- 2-Column Analytical Breakdown -->
    <div class="grid gap-5 lg:grid-cols-2">
      <!-- Left Column: Guild Member Equipment Losses -->
      <section class="card p-0 overflow-hidden shadow-sm">
        <header class="event-detail__section-header">
          <div class="flex items-center gap-2">
            <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
              {{ t('events.detail.our_guild_losses_by_player') }}
            </h2>
            <span class="chip chip--tonal font-mono text-xs">{{
              eventLossEstimate().players.length
            }}</span>
          </div>
        </header>
        @if (eventLossEstimate().players.length > 0) {
          <div class="p-3 space-y-2 max-h-96 overflow-y-auto">
            @for (player of eventLossEstimate().players; track player.player_name) {
              <div class="surface flex items-center justify-between gap-3 p-3">
                <div class="flex items-center gap-2.5 min-w-0">
                  <app-avatar [username]="player.player_name" size="sm" />
                  <div class="min-w-0">
                    <p class="text-xs font-bold text-[var(--color-text)] truncate">
                      {{ player.player_name }}
                    </p>
                    <p class="text-xs text-[var(--color-text-secondary)]">
                      {{
                        t(
                          player.deaths === 1
                            ? 'events.detail.death_one'
                            : 'events.detail.death_other',
                          {
                            count: player.deaths,
                          }
                        )
                      }}
                      &middot;
                      {{
                        t('events.detail.items_priced', {
                          priced: player.priced_items,
                          total: player.total_items,
                        })
                      }}
                    </p>
                  </div>
                </div>

                <div class="text-right flex-shrink-0">
                  <span class="font-mono text-xs font-bold text-[var(--color-danger)]">
                    -{{ formatAmount(player.estimated_loss) }}
                  </span>
                  <span class="block text-xs font-mono text-[var(--color-text-secondary)]">
                    {{ t('events.detail.silver') }}
                  </span>
                </div>
              </div>
            }
          </div>
        } @else {
          <p class="event-detail__empty text-center py-8">
            {{ t('events.detail.no_losses') }}
          </p>
        }
      </section>

      <!-- Right Column: Top Opponents -->
      <section class="card p-0 overflow-hidden shadow-sm">
        <header class="event-detail__section-header">
          <div class="flex items-center gap-2">
            <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
              {{ t('events.detail.opponents') }}
            </h2>
            <span class="chip chip--tonal font-mono text-xs">{{
              detail.stats.top_opponents.length
            }}</span>
          </div>
        </header>
        @if (detail.stats.top_opponents.length > 0) {
          <div class="p-3 space-y-2 max-h-96 overflow-y-auto">
            @for (
              opponent of detail.stats.top_opponents;
              track opponent.guild_id || opponent.guild_name
            ) {
              <div class="surface p-3 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  @if (canViewOpponents()) {
                    <a
                      class="text-xs font-bold text-[var(--color-primary)] hover:underline truncate inline-flex items-center gap-1"
                      routerLink="/intel/opponents"
                      [queryParams]="{ q: opponent.guild_name }"
                      [title]="t('events.detail.view_opponent_intel')"
                    >
                      <span>{{ opponent.guild_name || t('events.detail.unknown_guild') }}</span>
                      <app-icon name="arrow-right" size="0.75rem" />
                    </a>
                  } @else {
                    <span class="text-xs font-bold text-[var(--color-text)] truncate">
                      {{ opponent.guild_name || t('events.detail.unknown_guild') }}
                    </span>
                  }
                  <span class="text-xs font-mono font-medium text-[var(--color-text-secondary)]">
                    {{ opponent.wins }}W / {{ opponent.losses }}L ({{
                      t('events.detail.battles_short', { count: opponent.battles })
                    }})
                  </span>
                </div>

                <div class="space-y-1">
                  <div
                    class="flex items-center justify-between text-xs font-mono text-[var(--color-text-secondary)]"
                  >
                    <span>{{ t('nav.guild') }}: {{ formatCompact(opponent.guild_kill_fame) }}</span>
                    <span
                      >{{ t('events.detail.enemies') }}:
                      {{ formatCompact(opponent.opponent_kill_fame) }}</span
                    >
                  </div>
                  @if (opponent.guild_kill_fame + opponent.opponent_kill_fame > 0) {
                    <div class="event-detail__fill-bar" style="background: var(--color-danger)">
                      <span
                        [style.width.%]="
                          (opponent.guild_kill_fame /
                            (opponent.guild_kill_fame + opponent.opponent_kill_fame)) *
                          100
                        "
                        style="background: var(--color-success)"
                      ></span>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        } @else {
          <p class="event-detail__empty text-center py-8">
            {{ t('events.detail.no_opponents') }}
          </p>
        }
      </section>
    </div>
  `,
})
export class EventOverviewTab {
  private readonly translate = inject(TranslateService);

  readonly event = input.required<EventDetailView>();
  readonly eventLossEstimate = input.required<BattleLossEstimate>();
  readonly canViewOpponents = input.required<boolean>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
  protected readonly formatAmount = formatAmount;
  protected readonly formatCompact = formatCompact;
  protected readonly formatNumber = formatNumber;
  protected readonly formatPercent = formatPercent;
  protected readonly formatRatio = formatRatio;

  protected readonly winRate = computed(() => {
    const stats = this.event().stats;
    return winRatePercent(stats.wins, stats.losses);
  });

  protected readonly undecided = computed(() => {
    const stats = this.event().stats;
    return undecidedFights(stats.total_battles, stats.wins, stats.losses);
  });

  protected readonly eventBalance = computed(() => {
    const detail = this.event();
    if (!detail) return { netBalance: 0, totalLoot: 0, totalLoss: 0, isProfitable: true };
    const totalLoot = Number(detail.split_stats?.completed_net_value ?? 0);
    const totalLoss = Number(this.eventLossEstimate()?.total_estimated_loss ?? 0);
    const netBalance = totalLoot - totalLoss;
    return {
      netBalance,
      totalLoot,
      totalLoss,
      isProfitable: netBalance >= 0,
    };
  });
}
