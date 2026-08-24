import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuild,
  AlbionLinkStatus,
  AlbionPlayer,
  AlbionSearchResult,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { StatCard } from '../../shared/components/stat-card/stat-card';

/** Shortest term the upstream search will accept without returning noise. */
const MIN_QUERY_LENGTH = 2;

/**
 * Albion account settings: manage the character link, and look up players and
 * guilds against the live Albion API.
 *
 * The lookup half exists because three backend routes — `search`,
 * `players/{id}` and `guilds/{id}` — had no interface at all. Officers sizing
 * up an opponent had to leave the app to do it.
 *
 * Linking itself is also reachable from the shell gate that blocks unlinked
 * members; this page is where it can be reviewed and changed afterwards.
 */
@Component({
  selector: 'app-albion-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, EmptyState, FormsModule, Icon, Loading, PageHeader, StatCard],
  template: `
    <app-page-header [title]="t('albionSettings.title')" [subtitle]="t('albionSettings.subtitle')" />

    <!-- Character link -->
    <section class="card mb-6 p-5">
      <h2 class="eyebrow mb-3">{{ t('albionSettings.link.title') }}</h2>
      @if (linkLoading()) {
        <app-loading />
      } @else if (link(); as status) {
        @if (status.linked) {
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                {{ t('albionSettings.link.linkedAs') }}
              </p>
              <p class="mono mt-0.5 text-lg" style="color: var(--color-text)">
                {{ status.albion_player_name }}
              </p>
              @if (status.linked_at) {
                <p class="eyebrow mt-1">
                  {{ t('albionSettings.link.since') }} {{ status.linked_at | date: 'mediumDate' }}
                </p>
              }
            </div>
            <button
              type="button"
              class="btn btn--outline"
              [disabled]="unlinking()"
              (click)="unlink()"
            >
              {{ t('albionSettings.link.unlink') }}
            </button>
          </div>
        } @else {
          <p class="text-sm" style="color: var(--color-warning)">
            {{ t('albionSettings.link.notLinked') }}
          </p>
          <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
            {{ t('albionSettings.link.notLinkedHint') }}
          </p>
        }
      }
    </section>

    <!-- Live lookup -->
    <section class="card p-5">
      <h2 class="eyebrow mb-1">{{ t('albionSettings.lookup.title') }}</h2>
      <p class="mb-4 text-xs" style="color: var(--color-text-secondary)">
        {{ t('albionSettings.lookup.hint') }}
      </p>

      <form class="flex flex-wrap gap-2" (ngSubmit)="search()">
        <input
          class="input max-w-sm"
          type="search"
          [placeholder]="t('albionSettings.lookup.placeholder')"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          name="q"
        />
        <button type="submit" class="btn btn--primary" [disabled]="!canSearch() || searching()">
          <app-icon name="search" size="1rem" />
          {{ t('common.search') }}
        </button>
      </form>

      @if (searching()) {
        <app-loading />
      } @else if (results(); as found) {
        @if (found.players.length === 0 && found.guilds.length === 0) {
          <app-empty-state icon="search" [message]="t('albionSettings.lookup.noResults')" />
        } @else {
          <div class="mt-5 grid gap-5 lg:grid-cols-2">
            <div>
              <h3 class="eyebrow mb-2">{{ t('albionSettings.lookup.players') }}</h3>
              @for (player of found.players; track player.id) {
                <button
                  type="button"
                  class="flex w-full items-center justify-between border-t px-1 py-2 text-left"
                  style="border-color: var(--color-border)"
                  (click)="selectPlayer(player)"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm" style="color: var(--color-text)">
                      {{ player.name }}
                    </span>
                    <span class="eyebrow">{{ player.guild_name ?? t('albionSettings.lookup.noGuild') }}</span>
                  </span>
                  <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                    {{ player.kill_fame | number: '1.0-0' }}
                  </span>
                </button>
              }
              @if (found.players.length === 0) {
                <p class="text-sm" style="color: var(--color-text-secondary)">—</p>
              }
            </div>

            <div>
              <h3 class="eyebrow mb-2">{{ t('albionSettings.lookup.guilds') }}</h3>
              @for (guild of found.guilds; track guild.id) {
                <div
                  class="flex items-center justify-between border-t px-1 py-2"
                  style="border-color: var(--color-border)"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm" style="color: var(--color-text)">
                      {{ guild.name }}
                    </span>
                    <span class="eyebrow">
                      {{ guild.member_count }} {{ t('albionSettings.lookup.members') }}
                    </span>
                  </span>
                  <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                    {{ guild.kill_fame | number: '1.0-0' }}
                  </span>
                </div>
              }
              @if (found.guilds.length === 0) {
                <p class="text-sm" style="color: var(--color-text-secondary)">—</p>
              }
            </div>
          </div>
        }
      }

      <!-- Player dossier -->
      @if (selected(); as player) {
        <div class="mt-6 border-t pt-5" style="border-color: var(--color-border)">
          <h3 class="eyebrow mb-3">{{ player.name }}</h3>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <app-stat-card
              [label]="t('albionSettings.lookup.killFame')"
              [value]="player.kill_fame | number: '1.0-0'"
              tone="success"
            />
            <app-stat-card
              [label]="t('albionSettings.lookup.deathFame')"
              [value]="player.death_fame | number: '1.0-0'"
              tone="danger"
            />
            <app-stat-card
              [label]="t('albionSettings.lookup.fameRatio')"
              [value]="fameRatio(player)"
              [sub]="t('albionSettings.lookup.fameRatioSub')"
            />
            <app-stat-card
              [label]="t('albionSettings.lookup.guild')"
              [value]="player.guild_name ?? '—'"
            />
          </div>
        </div>
      }
    </section>
  `,
})
export class AlbionSettings {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly linkLoading = signal(true);
  protected readonly link = signal<AlbionLinkStatus | null>(null);
  protected readonly unlinking = signal(false);

  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly results = signal<AlbionSearchResult | null>(null);
  protected readonly selected = signal<AlbionPlayer | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly canSearch = computed(
    () => this.query().trim().length >= MIN_QUERY_LENGTH,
  );

  /** Kill fame over death fame — the usual shorthand for how a player trades. */
  protected fameRatio(player: AlbionPlayer): string {
    if (player.death_fame <= 0) {
      return player.kill_fame === 0 ? '0.00' : '∞';
    }
    return (player.kill_fame / player.death_fame).toFixed(2);
  }

  constructor() {
    void this.loadLink();
  }

  private async loadLink(): Promise<void> {
    this.linkLoading.set(true);
    try {
      this.link.set(await firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me')));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.linkLoading.set(false);
    }
  }

  /** Unlinking drops the identity every regear/split/battle lookup in the
   *  app resolves through — a misclick has real consequences elsewhere. */
  protected async unlink(): Promise<void> {
    if (!confirm(this.t('common.confirm'))) return;
    this.unlinking.set(true);
    try {
      await firstValueFrom(this.api.delete<null>('api/albion/link'));
      this.link.set({ linked: false });
      this.toasts.success(this.t('albionSettings.link.unlinked'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.unlinking.set(false);
    }
  }

  protected async search(): Promise<void> {
    const q = this.query().trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return;
    }
    this.searching.set(true);
    this.selected.set(null);
    try {
      this.results.set(
        await firstValueFrom(this.api.get<AlbionSearchResult>('api/albion/search', { q })),
      );
    } catch (error) {
      this.results.set(null);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searching.set(false);
    }
  }

  /**
   * Opens a dossier, refreshing from the player endpoint when it can.
   *
   * Search results already carry enough to render, so a failed refresh falls
   * back to what we have rather than showing nothing.
   */
  protected async selectPlayer(player: AlbionPlayer): Promise<void> {
    this.selected.set(player);
    try {
      const detail = await firstValueFrom(
        this.api.get<AlbionPlayer>(`api/albion/players/${encodeURIComponent(player.id)}`),
      );
      this.selected.set(detail);
    } catch {
      // Keep the search-result view.
    }
  }
}
