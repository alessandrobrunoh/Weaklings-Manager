import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { EnemyPlayerDossier } from '../../core/models/api.models';
import { ApiError } from '../../core/services/api.service';
import { EnemiesService } from '../../core/services/enemies.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';

/**
 * Dossier for one enemy player built from battle evidence.
 *
 * The battle history table is the point of the page: every kill traded with
 * this one character, newest first, exactly as recorded — no smoothing, no
 * aggregation beyond the KPI row above it.
 */
@Component({
  selector: 'app-enemy-player-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
  ],
  template: `
    @if (loading()) {
      <app-loading />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!dossier()) {
      <app-empty-state icon="alert" [message]="t('intel.opponents.player.notFound')" />
    } @else {
      @if (dossier(); as p) {
        <a
          class="mb-4 inline-flex items-center gap-1.5 text-sm no-underline text-[var(--color-text-secondary)]"
          routerLink="/intel/opponents"
        >
          <app-icon name="chevron-right" size="0.9rem" class="rotate-180" />
          {{ t('intel.opponents.back') }}
        </a>

        <app-page-header [title]="p.name" [subtitle]="subtitle(p)">
          @if (p.current_enemy_guild_id) {
            <a class="chip chip--neutral no-underline" [routerLink]="['/intel/opponents/guilds', p.current_enemy_guild_id]">
              {{ p.current_enemy_guild_name }}
            </a>
          }
          @if (p.is_watchlisted) {
            <span headerActions class="chip chip--warning">{{ t('intel.opponents.watchlisted') }}</span>
          }
        </app-page-header>

        <app-page-stack>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <app-stat-card [label]="t('intel.opponents.battlesFought')" [value]="p.battles_fought" />
            <app-stat-card
              [label]="t('intel.opponents.ourKills')"
              [value]="p.our_kills"
              tone="success"
            />
            <app-stat-card
              [label]="t('intel.opponents.theirKills')"
              [value]="p.their_kills"
              tone="danger"
            />
            <app-stat-card
              [label]="t('intel.kd')"
              [value]="kdRatio(p)"
              [tone]="p.our_kills >= p.their_kills ? 'success' : 'danger'"
            />
          </div>

          @if (p.notes) {
            <section class="card p-4">
              <h2 class="eyebrow mb-2">{{ t('intel.detail.notes') }}</h2>
              <p class="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">{{ p.notes }}</p>
            </section>
          }

          <section class="card overflow-x-auto">
            <h2 class="eyebrow p-4 pb-0">{{ t('intel.opponents.player.battleHistory') }}</h2>
            @if (p.battles.length === 0) {
              <p class="p-4 text-sm text-[var(--color-text-secondary)]">
                {{ t('intel.opponents.player.battleHistoryEmpty') }}
              </p>
            } @else {
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('common.date') }}</th>
                    <th>{{ t('common.role') }}</th>
                    <th>{{ t('intel.opponents.weapon') }}</th>
                    <th class="text-right">{{ t('intel.detail.itemPower') }}</th>
                    <th class="text-right">{{ t('intel.opponents.ourKills') }}</th>
                    <th class="text-right">{{ t('intel.opponents.theirKills') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (battle of p.battles; track battle.battle_id + battle.occurred_at) {
                    <tr>
                      <td>
                        <a
                          class="mono text-sm no-underline hover:underline"
                          style="color: var(--color-text)"
                          [routerLink]="['/battles', battle.battle_id]"
                        >
                          {{ battle.occurred_at | date: 'short' }}
                        </a>
                      </td>
                      <td>
                        @if (battle.role) {
                          <span class="chip chip--neutral text-[11px] capitalize">{{ roleLabel(battle.role) }}</span>
                        } @else {
                          <span class="text-xs italic" style="color: var(--color-text-tertiary)">
                            {{ t('intel.opponents.role.unobserved') }}
                          </span>
                        }
                      </td>
                      <td class="text-sm text-[var(--color-text-secondary)]">
                        {{ prettyWeapon(battle.main_hand_item_id) }}
                      </td>
                      <td class="mono text-right">{{ battle.item_power | number: '1.0-0' }}</td>
                      <td class="mono text-right" style="color: var(--color-success)">
                        {{ battle.our_kills_on_them }}
                      </td>
                      <td class="mono text-right" style="color: var(--color-error)">
                        {{ battle.their_kills_on_us }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>
        </app-page-stack>
      }
    }
  `,
})
export class EnemyPlayerDetailPage {
  private readonly enemies = inject(EnemiesService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly id = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly dossier = signal<EnemyPlayerDossier | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected subtitle(dossier: EnemyPlayerDossier): string {
    return `${this.t('intel.detail.firstSeen')} ${this.formatDate(dossier.first_seen_at)} · ${this.t('intel.detail.lastSeen')} ${this.formatDate(dossier.last_seen_at)}`;
  }

  private formatDate(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }

  protected kdRatio(dossier: EnemyPlayerDossier): string {
    if (dossier.their_kills === 0) {
      return dossier.our_kills > 0 ? '∞' : '—';
    }
    return (dossier.our_kills / dossier.their_kills).toFixed(2);
  }

  protected roleLabel(role: string): string {
    return role.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  protected prettyWeapon(id: string | null): string {
    if (!id) {
      return '—';
    }
    return id
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * `id` is a route-bound input, not a one-time constructor param — see the
   * identical note on `EnemyGuildDetailPage.load`.
   */
  protected async load(): Promise<void> {
    const numericId = Number(this.id());
    if (!Number.isFinite(numericId)) {
      this.loading.set(false);
      this.dossier.set(null);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const dossier = await firstValueFrom(this.enemies.getPlayer(numericId));
      this.dossier.set(dossier);
    } catch (error) {
      this.dossier.set(null);
      if (!(error instanceof ApiError && error.status === 404)) {
        this.loadFailed.set(true);
        this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      }
    } finally {
      this.loading.set(false);
    }
  }
}
