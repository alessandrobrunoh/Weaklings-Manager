import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { IntelService } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import type { ScoutedCompDetail, SimilarityHit } from '../../core/models/api.models';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { Meter } from '../../shared/components/meter/meter';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

/**
 * Dossier for one scouted enemy composition.
 *
 * Reads as an intelligence brief rather than a data dump: what they field,
 * what has actually beaten them, and how confident any of it is. Where the
 * kill feed only sampled part of the enemy force, that is stated on the page
 * instead of being smoothed over — an officer picking a counter needs to know
 * whether they are reading evidence or inference.
 */
@Component({
  selector: 'app-intel-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    Meter,
    PageHeader,
    RouterLink,
    StatCard,
    StatusChip,
  ],
  template: `
    @if (loading()) {
      <app-loading />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!scout()) {
      <app-empty-state icon="alert" [message]="t('intel.detail.notFound')" />
    } @else {
      @if (scout(); as s) {
        <a
          class="mb-4 inline-flex items-center gap-1.5 text-sm no-underline"
          routerLink="/intel"
          style="color: var(--color-text-secondary)"
        >
          <app-icon name="chevron-right" size="0.9rem" class="rotate-180" />
          {{ t('intel.detail.back') }}
        </a>

        <app-page-header [title]="s.opponent_guild_name" [subtitle]="s.name">
          <app-status-chip [value]="s.category" />
        </app-page-header>

        <div class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <app-stat-card [label]="t('intel.players')" [value]="s.player_count.toString()" />
          <app-stat-card [label]="t('intel.avgIp')" [value]="(s.avg_ip | number: '1.0-0') ?? '—'" />
          <app-stat-card
            [label]="t('intel.threat')"
            [value]="s.threat_score.toString()"
            tone="danger"
          />
          <app-stat-card
            [label]="t('intel.fights')"
            [value]="s.source_battle_count.toString()"
            [sub]="t('intel.detail.lastSeen') + ' ' + (s.saved_at | date: 'shortDate')"
          />
        </div>

        @if (!s.full_weapon_coverage) {
          <div
            class="mb-6 flex items-start gap-2.5 rounded-2xl border p-3.5 text-sm"
            style="background-color: var(--color-warning-container); border-color: var(--color-warning); color: var(--color-warning)"
            role="note"
          >
            <app-icon name="info" size="1rem" />
            <span>
              {{ t('intel.partialCoverage') }} — {{ s.weapon_sample_size }}/{{ s.player_count }}.
              {{ t('intel.partialCoverageHint') }}
            </span>
          </div>
        }

        <div class="grid gap-4 lg:grid-cols-2">
          <!-- Composition shape -->
          <section class="card p-4">
            <h2 class="eyebrow mb-2">{{ t('intel.detail.roles') }}</h2>
            @for (role of roleRows(); track role.name) {
              <app-meter
                [label]="role.name"
                [value]="role.count"
                [max]="s.player_count"
                [display]="role.count.toString()"
              />
            }
          </section>

          <section class="card p-4">
            <h2 class="eyebrow mb-2">{{ t('intel.detail.weapons') }}</h2>
            @if (weaponRows().length === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">—</p>
            } @else {
              @for (weapon of weaponRows(); track weapon.name) {
                <app-meter
                  [label]="prettyWeapon(weapon.name)"
                  [value]="weapon.count"
                  [max]="s.weapon_sample_size || 1"
                  [display]="weapon.count.toString()"
                  tone="neutral"
                />
              }
            }
          </section>

          <!-- What has actually worked -->
          <section class="card p-4">
            <h2 class="eyebrow mb-2">{{ t('intel.detail.counters') }}</h2>
            @if (s.recommended_counter; as best) {
              <div
                class="mb-3 rounded-2xl p-3"
                style="background-color: var(--color-success-container)"
              >
                <p class="eyebrow" style="color: var(--color-success)">
                  {{ t('intel.detail.recommended') }}
                </p>
                <a
                  class="mt-0.5 block font-medium no-underline"
                  [routerLink]="['/comps', best.comp_id]"
                  style="color: var(--color-text)"
                >
                  {{ best.comp_name }}
                </a>
                <p class="mono mt-1 text-xs" style="color: var(--color-text-secondary)">
                  {{ best.wins }}–{{ best.losses }} · {{ best.win_rate | number: '1.0-0' }}%
                </p>
              </div>
            } @else {
              <p class="mb-3 text-sm" style="color: var(--color-text-secondary)">
                {{ t('intel.detail.noCounter') }}
              </p>
            }

            @for (row of s.matchups; track row.our_comp_id) {
              <div class="flex items-center justify-between border-t py-2" style="border-color: var(--color-border)">
                <a
                  class="truncate text-sm no-underline"
                  [routerLink]="['/comps', row.our_comp_id]"
                  style="color: var(--color-text)"
                >
                  {{ row.our_comp_name }}
                </a>
                <span class="mono shrink-0 text-xs">
                  <span style="color: var(--color-success)">{{ row.wins }}</span>
                  <span style="color: var(--color-text-disabled)">/</span>
                  <span style="color: var(--color-error)">{{ row.losses }}</span>
                </span>
              </div>
            }
          </section>

          <section class="card p-4">
            <h2 class="eyebrow mb-2">{{ t('intel.detail.similar') }}</h2>
            @if (similar().length === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">—</p>
            } @else {
              @for (hit of similar(); track hit.id) {
                <a
                  class="flex items-center justify-between border-t py-2 no-underline"
                  style="border-color: var(--color-border); color: var(--color-text)"
                  [routerLink]="['/intel', hit.id]"
                >
                  <span class="truncate text-sm">{{ hit.name }}</span>
                  <span class="mono shrink-0 text-xs" [style.color]="simColor(hit)">
                    {{ hit.score }}%{{ hit.full_weapon_coverage ? '' : '*' }}
                  </span>
                </a>
              }
              @if (hasSampledSimilarity()) {
                <p class="mt-2 text-[11px]" style="color: var(--color-text-secondary)">
                  * {{ t('intel.partialCoverage') }}
                </p>
              }
            }
          </section>

          <!-- Observed roster -->
          <section class="card overflow-x-auto lg:col-span-2">
            <h2 class="eyebrow p-4 pb-0">{{ t('intel.detail.roster') }}</h2>
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('common.player') }}</th>
                  <th>{{ t('common.role') }}</th>
                  <th>{{ t('intel.detail.weapons') }}</th>
                  <th class="text-right">{{ t('intel.detail.itemPower') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (player of s.players; track player.name) {
                  <tr>
                    <td>{{ player.name }}</td>
                    <td>
                      <span class="capitalize">{{ player.role.replace('_', ' ') }}</span>
                      @if (player.role_inferred) {
                        <!-- decorative=false: the default hides the icon from
                             the accessibility tree via aria-hidden, which
                             would silently swallow this aria-label too — the
                             "inferred, not observed" signal is real content
                             here, not decoration. -->
                        <app-icon
                          name="info"
                          size="0.8rem"
                          class="ml-1 align-middle"
                          [decorative]="false"
                          [attr.aria-label]="t('intel.detail.inferredRole')"
                        />
                      }
                    </td>
                    <td class="text-sm" style="color: var(--color-text-secondary)">
                      {{ player.weapon ? prettyWeapon(player.weapon) : '—' }}
                    </td>
                    <td class="mono text-right">{{ player.item_power | number: '1.0-0' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>
      }
    }
  `,
})
export class IntelDetailPage {
  private readonly intel = inject(IntelService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly scoutId = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly scout = signal<ScoutedCompDetail | null>(null);
  protected readonly similar = signal<SimilarityHit[]>([]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly roleRows = computed(() =>
    Object.entries(this.scout()?.roles ?? {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  );

  protected readonly weaponRows = computed(() =>
    Object.entries(this.scout()?.weapons ?? {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  );

  protected readonly hasSampledSimilarity = computed(() =>
    this.similar().some((hit) => !hit.full_weapon_coverage),
  );

  /** Banding mirrors the reference: strong, plausible, weak. */
  protected simColor(hit: SimilarityHit): string {
    if (hit.score >= 70) {
      return 'var(--color-success)';
    }
    if (hit.score >= 45) {
      return 'var(--color-warning)';
    }
    return 'var(--color-text-secondary)';
  }

  protected prettyWeapon(id: string): string {
    return id
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * `scoutId` is a route-bound input, not a one-time constructor param.
   * Angular's default route-reuse strategy keeps this component instance
   * alive across navigations within the same route config (e.g. clicking a
   * "similar comp" link from one dossier to another) — without watching
   * the signal here, the URL and `scoutId()` change but the page keeps
   * showing the previous scout until a hard refresh.
   */
  constructor() {
    effect(() => {
      void this.load();
    });
  }

  protected async load(): Promise<void> {
    const id = Number(this.scoutId());
    if (!Number.isFinite(id)) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(this.intel.getScout(id));
      this.scout.set(detail);
      // Secondary and non-blocking: a failure here must not blank the dossier.
      try {
        this.similar.set(await firstValueFrom(this.intel.similarScouts(id)));
      } catch {
        this.similar.set([]);
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      this.scout.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
