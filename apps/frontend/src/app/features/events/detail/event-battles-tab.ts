import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type {
  EventBattleSummary,
  EventDetailView,
  EventFight,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { albionBattlesUrl, formatConfidence } from '../../battles/battle-metrics';
import { battleOutcomeLabel } from '../../battles/battle-outcome';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { Icon } from '../../../shared/components/icon/icon';
import { fightMetrics, formatCompact, formatDate, formatNumber } from './event-detail.utils';

/** Battles tab of the event detail page: linked battle segments, canonical fights and combat logs. */
@Component({
  selector: 'app-event-battles-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, Icon, RouterLink],
  template: `
    @let detail = event();
    <div class="space-y-5">
      <!-- Battles Management Bar -->
      <section class="card p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
              {{ t('events.detail.battles') }}
            </h2>
            <span class="font-mono text-xs font-semibold text-[var(--color-text-secondary)]">
              {{
                t('events.detail.fights_battles_count', {
                  fights: detail.fights.length,
                  battles: detail.battles.length,
                })
              }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            @if (detail.battles.length > 0) {
              <button
                type="button"
                class="btn btn--outline btn--sm text-xs"
                (click)="openBattleGroup(detail)"
              >
                <app-icon name="chart" size="0.75rem" />
                {{ t('battles.group_selected') }}
              </button>
            }
            @if (canEdit()) {
              <button
                type="button"
                class="btn btn--primary btn--sm text-xs"
                (click)="toggleBattleLinkForm.emit()"
              >
                <app-icon name="link" size="0.75rem" />
                {{ t('events.detail.manage_battles') }}
              </button>
            }
          </div>
        </div>
      </section>

      @if (detail.fights.length > 0) {
        <section class="space-y-3" [attr.aria-label]="t('events.detail.canonical_fights')">
          @for (fight of detail.fights; track fight.id) {
            @let metrics = fightMetrics(fight, detail.battles);
            <article class="card p-5 shadow-sm space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <span
                      class="chip font-mono text-xs font-bold"
                      [class.chip--success]="metrics.outcome === 'victory'"
                      [class.chip--error]="metrics.outcome === 'defeat'"
                    >
                      {{ outcomeLabel(metrics.outcome) }}
                    </span>
                    <h3 class="font-bold text-base text-[var(--color-text)]">
                      {{ t('events.detail.fight_number', { id: fight.id }) }}
                    </h3>
                  </div>
                  <p class="text-xs text-[var(--color-text-secondary)]">
                    {{ formatDate(fight.started_at) }} &middot; {{ fight.grouping_method }}
                    @if (fight.needs_review) {
                      &middot;
                      <span class="text-warning font-semibold">{{ t('fights.needsReview') }}</span>
                    }
                  </p>
                </div>

                <button type="button" class="btn btn--outline btn--sm" (click)="openFight(fight)">
                  {{ t('events.detail.open_fight') }} &rarr;
                </button>
              </div>

              <div
                class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 pt-3 border-t border-[var(--color-border)]"
              >
                <div class="surface p-3">
                  <p class="event-detail__label">{{ t('battles.segments') }}</p>
                  <p class="event-detail__value-sm mt-1">{{ metrics.segments }}</p>
                </div>
                <div class="surface p-3">
                  <p class="event-detail__label">{{ t('events.detail.confidence') }}</p>
                  <p class="event-detail__value-sm mt-1">
                    {{ formatConfidence(fight.grouping_confidence) }}
                  </p>
                </div>
                @if (metrics.players !== null) {
                  <div class="surface p-3">
                    <p class="event-detail__label">{{ t('battles.players') }}</p>
                    <p class="event-detail__value-sm mt-1">
                      {{ formatNumber(metrics.players) }}
                    </p>
                  </div>
                }
                @if (metrics.kills !== null) {
                  <div class="surface p-3">
                    <p class="event-detail__label">{{ t('battles.kills') }}</p>
                    <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                      {{ formatNumber(metrics.kills) }}
                    </p>
                  </div>
                }
                @if (metrics.fame !== null) {
                  <div class="surface p-3">
                    <p class="event-detail__label">{{ t('battles.kill_fame') }}</p>
                    <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                      {{ formatCompact(metrics.fame) }}
                    </p>
                  </div>
                }
              </div>
            </article>
          }
        </section>
      }

      <!-- Raw Battle segment drill-down -->
      @if (detail.battles.length > 0) {
        <div class="space-y-3">
          @for (battle of detail.battles; track battle.id) {
            <article class="card p-5 shadow-sm space-y-3">
              <div
                class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]"
              >
                <div class="flex items-center gap-2.5 flex-wrap">
                  <span
                    class="chip font-mono text-xs font-bold"
                    [class.chip--success]="battle.outcome === 'victory'"
                    [class.chip--error]="battle.outcome === 'defeat'"
                  >
                    {{ outcomeLabel(battle.outcome) }}
                  </span>
                  <a
                    class="font-mono text-xs text-[var(--color-primary)] font-bold hover:underline"
                    [routerLink]="['/battles', battle.albionbb_battle_id]"
                  >
                    {{ t('events.detail.battle_number', { id: battle.albionbb_battle_id }) }}
                  </a>
                  <span class="text-xs text-[var(--color-text-secondary)]">
                    &middot; {{ formatDate(battle.battle_started_at) }}
                  </span>
                  @if (battle.opponent_guild_name) {
                    <span class="chip chip--tonal text-xs font-semibold">
                      {{ t('events.detail.vs_opponent', { name: battle.opponent_guild_name }) }}
                    </span>
                  }
                </div>

                <div class="flex items-center gap-2">
                  <a
                    class="btn btn--ghost btn--sm text-xs"
                    [href]="albionBattlesUrl(battle.albionbb_battle_id)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ t('battles.view_on_albion_battles') }} &rarr;
                  </a>
                  <button
                    type="button"
                    class="btn btn--primary btn--sm text-xs"
                    (click)="openBattle(battle.albionbb_battle_id)"
                  >
                    {{ t('events.detail.open_battle') }}
                  </button>
                </div>
              </div>

              <!-- 3-Column Combat Metrics -->
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div class="surface p-3">
                  <span class="event-detail__label">{{ t('events.detail.forces') }}</span>
                  <p class="font-mono text-sm font-bold text-[var(--color-text)] mt-0.5">
                    {{ battle.guild_players_count }}
                    <span class="text-xs text-[var(--color-text-secondary)]">{{
                      t('events.detail.vs')
                    }}</span>
                    {{ battle.opponent_players_count ?? '—' }}
                  </p>
                </div>

                <div class="surface p-3">
                  <span class="event-detail__label">{{ t('events.detail.kills_deaths') }}</span>
                  <p class="font-mono text-sm font-bold text-[var(--color-text)] mt-0.5">
                    <span class="text-[var(--color-success)]">{{ battle.guild_kills }}</span>
                    /
                    <span class="text-[var(--color-danger)]">{{ battle.guild_deaths }}</span>
                  </p>
                </div>

                <div class="surface p-3">
                  <span class="event-detail__label">{{ t('events.detail.kill_fame') }}</span>
                  <p class="font-mono text-sm font-bold text-[var(--color-success)] mt-0.5">
                    +{{ formatCompact(battle.guild_kill_fame) }}
                  </p>
                </div>
              </div>
            </article>
          }
        </div>
      } @else {
        <div class="card p-10 text-center">
          <app-empty-state [message]="t('events.detail.no_battles')" icon="swords" />
        </div>
      }
    </div>
  `,
})
export class EventBattlesTab {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);

  readonly event = input.required<EventDetailView>();
  readonly canEdit = input.required<boolean>();
  readonly toggleBattleLinkForm = output<void>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
  protected readonly formatCompact = formatCompact;
  protected readonly formatDate = formatDate;
  protected readonly formatNumber = formatNumber;
  protected readonly formatConfidence = formatConfidence;
  protected readonly albionBattlesUrl = albionBattlesUrl;
  protected readonly fightMetrics = fightMetrics;

  protected outcomeLabel(outcome: EventBattleSummary['outcome']): string {
    return this.t(battleOutcomeLabel(outcome));
  }

  protected openBattle(albionbbBattleId: string): void {
    void this.router.navigate(['/battles', albionbbBattleId]);
  }

  protected openFight(fight: EventFight): void {
    void this.router.navigate(['/fights', fight.id]);
  }

  protected openBattleGroup(detail: EventDetailView): void {
    const ids = detail.battles.map((battle) => battle.albionbb_battle_id);
    if (ids.length === 0) return;
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }
}
