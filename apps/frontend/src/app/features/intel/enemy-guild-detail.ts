import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { EnemyGuildDossier } from '../../core/models/api.models';
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
 * Dossier for one enemy guild built from battle evidence.
 *
 * Everything below the KPI row is genuinely new information — nobody in this
 * guild has ever had a queryable view of an opponent's name/alliance history
 * or roster before, so the alias section in particular is written to be read
 * carefully rather than skimmed.
 */
@Component({
  selector: 'app-enemy-guild-detail',
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
      <app-empty-state icon="alert" [message]="t('intel.opponents.guild.notFound')" />
    } @else {
      @if (dossier(); as g) {
        <a
          class="mb-4 inline-flex items-center gap-1.5 text-sm no-underline text-[var(--color-text-secondary)]"
          routerLink="/intel/opponents"
        >
          <app-icon name="chevron-right" size="0.9rem" class="rotate-180" />
          {{ t('intel.opponents.back') }}
        </a>

        <app-page-header [title]="g.name" [subtitle]="subtitle(g)">
          @if (g.current_alliance_name) {
            <span headerActions class="chip chip--neutral">{{ g.current_alliance_name }}</span>
          }
          @if (g.is_watchlisted) {
            <span headerActions class="chip chip--warning">{{ t('intel.opponents.watchlisted') }}</span>
          }
        </app-page-header>

        <app-page-stack>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <app-stat-card [label]="t('intel.opponents.battlesFought')" [value]="g.battles_fought" />
            <app-stat-card
              [label]="t('intel.opponents.ourKills')"
              [value]="g.our_kills"
              tone="success"
            />
            <app-stat-card
              [label]="t('intel.opponents.theirKills')"
              [value]="g.their_kills"
              tone="danger"
            />
            <app-stat-card
              [label]="t('intel.kd')"
              [value]="kdRatio(g)"
              [tone]="g.our_kills >= g.their_kills ? 'success' : 'danger'"
            />
          </div>

          @if (g.notes) {
            <section class="card p-4">
              <h2 class="eyebrow mb-2">{{ t('intel.detail.notes') }}</h2>
              <p class="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">{{ g.notes }}</p>
            </section>
          }

          <section class="card p-4">
            <h2 class="eyebrow mb-3">{{ t('intel.opponents.guild.aliasHistory') }}</h2>
            @if (g.aliases.length === 0) {
              <p class="text-sm text-[var(--color-text-secondary)]">{{ t('intel.opponents.guild.aliasEmpty') }}</p>
            } @else {
              <div class="grid gap-4 lg:grid-cols-2">
                @for (group of g.aliases; track group.kind) {
                  <div>
                    <h3 class="text-sm font-medium mb-2" style="color: var(--color-text)">
                      {{ aliasKindLabel(group.kind) }}
                    </h3>
                    @if (group.values.length === 0) {
                      <p class="text-sm text-[var(--color-text-secondary)]">
                        {{ t('intel.opponents.guild.aliasEmpty') }}
                      </p>
                    } @else {
                      <ol class="divide-y" style="border-color: var(--color-border)">
                        @for (value of group.values; track value.value + value.first_seen_at) {
                          <li class="flex items-center justify-between gap-3 py-2 first:pt-0">
                            <span class="min-w-0 truncate text-sm" style="color: var(--color-text)">
                              {{ value.value }}
                            </span>
                            <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                              {{ value.first_seen_at | date: 'mediumDate' }} – {{ value.last_seen_at | date: 'mediumDate' }}
                            </span>
                          </li>
                        }
                      </ol>
                    }
                  </div>
                }
              </div>
            }
          </section>

          <section class="card overflow-x-auto">
            <h2 class="eyebrow p-4 pb-0">{{ t('intel.opponents.guild.roster') }}</h2>
            @if (g.roster.length === 0) {
              <p class="p-4 text-sm text-[var(--color-text-secondary)]">
                {{ t('intel.opponents.guild.rosterEmpty') }}
              </p>
            } @else {
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ t('common.name') }}</th>
                    <th>{{ t('common.role') }}</th>
                    <th>{{ t('intel.opponents.weapon') }}</th>
                    <th class="text-right">{{ t('intel.detail.itemPower') }}</th>
                    <th>{{ t('intel.detail.lastSeen') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (player of g.roster; track player.id) {
                    <tr>
                      <td>
                        <a
                          class="no-underline hover:underline"
                          style="color: var(--color-text)"
                          [routerLink]="['/intel/opponents/players', player.id]"
                        >
                          {{ player.name }}
                        </a>
                      </td>
                      <td>
                        @if (player.role) {
                          <span class="chip chip--neutral text-[11px] capitalize">{{ roleLabel(player.role) }}</span>
                        } @else {
                          <span class="text-xs italic" style="color: var(--color-text-tertiary)">
                            {{ t('intel.opponents.role.unobserved') }}
                          </span>
                        }
                      </td>
                      <td class="text-sm text-[var(--color-text-secondary)]">
                        {{ prettyWeapon(player.main_hand_item_id) }}
                      </td>
                      <td class="mono text-right">
                        {{ player.item_power !== null ? (player.item_power | number: '1.0-0') : '—' }}
                      </td>
                      <td class="text-sm text-[var(--color-text-secondary)]">
                        {{ player.last_seen_at | date: 'short' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </section>

          <section class="card p-4">
            <h2 class="eyebrow mb-3">{{ t('intel.opponents.guild.weaponHistogram') }}</h2>
            @if (g.weapon_histogram.length === 0) {
              <p class="text-sm text-[var(--color-text-secondary)]">
                {{ t('intel.opponents.guild.weaponHistogramEmpty') }}
              </p>
            } @else {
              <div class="space-y-2">
                @for (bucket of g.weapon_histogram; track bucket.main_hand_item_id) {
                  <div class="flex items-center gap-3">
                    <span class="w-36 shrink-0 truncate text-xs" style="color: var(--color-text-secondary)">
                      {{ prettyWeapon(bucket.main_hand_item_id) }}
                    </span>
                    <div class="h-2 flex-1 overflow-hidden rounded-full" style="background: var(--color-surface-2)">
                      <div
                        class="h-full rounded-full"
                        style="background: var(--color-primary)"
                        [style.width.%]="weaponBarWidth(bucket.count, g)"
                      ></div>
                    </div>
                    <span class="mono w-10 shrink-0 text-right text-xs" style="color: var(--color-text-secondary)">
                      {{ bucket.count }}
                    </span>
                  </div>
                }
              </div>
            }
          </section>
        </app-page-stack>
      }
    }
  `,
})
export class EnemyGuildDetailPage {
  private readonly enemies = inject(EnemiesService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly id = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly dossier = signal<EnemyGuildDossier | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly maxWeaponCount = computed(() => {
    const histogram = this.dossier()?.weapon_histogram ?? [];
    return Math.max(1, ...histogram.map((bucket) => bucket.count));
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected subtitle(dossier: EnemyGuildDossier): string {
    return `${this.t('intel.detail.firstSeen')} ${this.formatDate(dossier.first_seen_at)} · ${this.t('intel.detail.lastSeen')} ${this.formatDate(dossier.last_seen_at)}`;
  }

  private formatDate(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }

  protected kdRatio(dossier: EnemyGuildDossier): string {
    if (dossier.their_kills === 0) {
      return dossier.our_kills > 0 ? '∞' : '—';
    }
    return (dossier.our_kills / dossier.their_kills).toFixed(2);
  }

  protected aliasKindLabel(kind: string): string {
    if (kind === 'alliance') {
      return this.t('intel.opponents.guild.aliasKind.alliance');
    }
    return this.t('intel.opponents.guild.aliasKind.name');
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

  protected weaponBarWidth(count: number, dossier: EnemyGuildDossier): number {
    void dossier;
    return (count / this.maxWeaponCount()) * 100;
  }

  /**
   * `id` is a route-bound input, not a one-time constructor param. Angular's
   * default route-reuse strategy keeps this component instance alive across
   * navigations within the same route config (e.g. clicking from one
   * guild's roster to a player and back), so the load must re-run whenever
   * the signal changes rather than only once at construction.
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
      const dossier = await firstValueFrom(this.enemies.getGuild(numericId));
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
