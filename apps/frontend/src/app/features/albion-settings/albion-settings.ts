import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionLinkStatus,
  AlbionPlayer,
  AlbionSearchResult,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';

/** Shortest term the upstream search will accept without returning noise. */
const MIN_QUERY_LENGTH = 2;

/** Pause after the last keystroke before the live lookup fires. */
const SEARCH_DEBOUNCE_MS = 350;

/** State of the one write this page makes (unlinking the character). */
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Albion account settings: the character linked to this account, and a live
 * lookup of players and guilds against the Albion API.
 *
 * Linking applies at once and is reached from the shell gate that blocks
 * unlinked members; this page shows the link and lets it be removed. The
 * lookup helps officers size up an opponent before a fight.
 *
 * Guild and region are tenant settings, set by the platform admin, so they are
 * not edited here.
 */
@Component({
  selector: 'app-albion-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    COMPACT_FEATURE_STYLES,
    `
    .row-link {
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-text);
      font: inherit;
      text-align: left;
      text-decoration: underline;
      text-decoration-color: var(--color-border);
      text-underline-offset: 0.2em;
      cursor: pointer;
    }
    .row-link:hover {
      text-decoration-color: currentColor;
    }
    .row-link[aria-current='true'] {
      font-weight: 600;
    }
    `,
  ],
  imports: [
    DatePipe,
    DecimalPipe,
    Dialog,
    EmptyState,
    ErrorState,
    FilterBar,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    Stat,
    StatusChip,
    SummaryBand,
  ],
  template: `
    <app-page-header
      [title]="t('albionSettings.title')"
      [subtitle]="t('albionSettings.subtitle')"
    />

    <app-page-stack>
      <!-- Linked character -->
      <section class="card p-4" aria-labelledby="alb-link-heading">
        <header class="mb-3">
          <h2 id="alb-link-heading" class="section-title">{{ t('albionSettings.link.title') }}</h2>
          <p class="hint mt-1">{{ t('albionSettings.link.helper') }}</p>
        </header>

        @if (linkLoading()) {
          <app-loading variant="table" [rows]="1" [cells]="3" />
        } @else if (linkLoadFailed()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="loadLink()"
          />
        } @else if (link(); as status) {
          @if (status.linked) {
            <div class="table-scroll">
              <table class="table">
                <caption class="sr-only">{{ t('albionSettings.link.title') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">{{ t('albionSettings.link.character') }}</th>
                    <th scope="col">{{ t('albionSettings.link.since') }}</th>
                    <th scope="col">{{ t('common.status') }}</th>
                    <th scope="col"><span class="sr-only">{{ t('common.actions') }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="mono">{{ status.albion_player_name ?? '—' }}</td>
                    <td>
                      {{
                        status.linked_at
                          ? (status.linked_at | date: 'mediumDate')
                          : '—'
                      }}
                    </td>
                    <td>
                      <app-status-chip
                        value="linked"
                        toneOverride="success"
                        icon="check"
                        [label]="t('albionSettings.link.linkedStatus')"
                      />
                    </td>
                    <td class="text-right">
                      <app-menu
                        [items]="linkMenu()"
                        [label]="t('albionSettings.link.rowActions')"
                        appearance="ghost"
                        align="end"
                        (itemSelect)="onLinkAction($event)"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          } @else {
            <app-empty-state
              [compact]="true"
              icon="user-x"
              [message]="t('albionSettings.link.notLinked')"
              [hint]="t('albionSettings.link.notLinkedHint')"
            />
          }
        }

        @switch (saveState()) {
          @case ('saving') {
            <p class="hint mt-3" role="status">{{ t('albionSettings.save.saving') }}</p>
          }
          @case ('saved') {
            <p class="hint mt-3" role="status" style="color: var(--color-success)">
              {{ t('albionSettings.link.unlinked') }}
            </p>
          }
          @case ('failed') {
            <p class="hint mt-3" role="alert" style="color: var(--color-error)">
              {{ t('albionSettings.save.failed') }}
            </p>
          }
        }
      </section>

      <!-- Live lookup -->
      <section class="card p-4" aria-labelledby="alb-lookup-heading">
        <header class="mb-3">
          <h2 id="alb-lookup-heading" class="section-title">
            {{ t('albionSettings.lookup.title') }}
          </h2>
          <p class="hint mt-1">{{ t('albionSettings.lookup.hint') }}</p>
        </header>

        <app-filter-bar
          [searchLabel]="t('albionSettings.lookup.searchLabel')"
          [searchPlaceholder]="t('albionSettings.lookup.placeholder')"
          [query]="query()"
          [activeCount]="query() ? 1 : 0"
          (queryChange)="onQueryChange($event)"
          (clear)="clearLookup()"
        />

        @if (needsMoreText()) {
          <p class="hint mt-2">{{ t('albionSettings.lookup.minChars') }}</p>
        }

        @if (searching()) {
          <app-loading variant="lines" [rows]="3" />
        } @else if (lookupFailed()) {
          <app-error-state
            [message]="t('common.error')"
            [retryLabel]="t('common.retry')"
            (retry)="search()"
          />
        } @else if (results(); as found) {
          @if (found.partial) {
            <p class="hint mt-3" role="status">{{ t('albionSettings.lookup.partial') }}</p>
          }

          @if (found.players.length === 0 && found.guilds.length === 0) {
            <app-empty-state [compact]="true" icon="search" [message]="t('albionSettings.lookup.noResults')" />
          } @else {
            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <h3 class="section-title section-title--sm mb-2">
                  {{ t('albionSettings.lookup.players') }}
                </h3>
                @if (found.players.length > 0) {
                  <div class="table-scroll">
                    <table class="table">
                      <caption class="sr-only">{{ t('albionSettings.lookup.players') }}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{{ t('common.name') }}</th>
                          <th scope="col">{{ t('albionSettings.lookup.guild') }}</th>
                          <th scope="col" class="text-right">
                            {{ t('albionSettings.lookup.killFame') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (player of found.players; track player.id) {
                          <tr>
                            <td>
                              <button
                                type="button"
                                class="row-link"
                                [attr.aria-current]="isSelected(player.id) ? 'true' : null"
                                (click)="selectPlayer(player)"
                              >
                                {{ player.name }}
                              </button>
                            </td>
                            <td>{{ player.guild_name ?? t('albionSettings.lookup.noGuild') }}</td>
                            <td class="num text-right">
                              {{ player.kill_fame | number: '1.0-0' }}
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <p class="hint">{{ t('albionSettings.lookup.noPlayers') }}</p>
                }
              </div>

              <div>
                <h3 class="section-title section-title--sm mb-2">
                  {{ t('albionSettings.lookup.guilds') }}
                </h3>
                @if (found.guilds.length > 0) {
                  <div class="table-scroll">
                    <table class="table">
                      <caption class="sr-only">{{ t('albionSettings.lookup.guilds') }}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{{ t('albionSettings.lookup.guild') }}</th>
                          <th scope="col" class="text-right">
                            {{ t('albionSettings.lookup.memberCount') }}
                          </th>
                          <th scope="col" class="text-right">
                            {{ t('albionSettings.lookup.killFame') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (guild of found.guilds; track guild.id) {
                          <tr>
                            <td>{{ guild.name }}</td>
                            <td class="num text-right">{{ guild.member_count | number: '1.0-0' }}</td>
                            <td class="num text-right">{{ guild.kill_fame | number: '1.0-0' }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <p class="hint">{{ t('albionSettings.lookup.noGuilds') }}</p>
                }
              </div>
            </div>

            @if (selected(); as player) {
              <div class="mt-5 border-t pt-4" style="border-color: var(--color-border)">
                <h3 class="section-title section-title--sm mb-3">{{ player.name }}</h3>
                <app-summary-band [ariaLabel]="t('albionSettings.lookup.dossierLabel')">
                  <app-stat
                    [label]="t('albionSettings.lookup.killFame')"
                    [value]="player.kill_fame | number: '1.0-0'"
                  />
                  <app-stat
                    [label]="t('albionSettings.lookup.deathFame')"
                    [value]="player.death_fame | number: '1.0-0'"
                  />
                  <app-stat
                    [label]="t('albionSettings.lookup.fameRatio')"
                    [value]="fameRatio(player)"
                    [hint]="t('albionSettings.lookup.fameRatioSub')"
                  />
                  <app-stat
                    [label]="t('albionSettings.lookup.guild')"
                    [value]="player.guild_name ?? t('albionSettings.lookup.noGuild')"
                  />
                </app-summary-band>
              </div>
            } @else if (found.players.length > 0) {
              <p class="hint mt-4">{{ t('albionSettings.lookup.selectHint') }}</p>
            }
          }
        }
      </section>
    </app-page-stack>

    @if (unlinkConfirm()) {
      <app-dialog
        [title]="t('albionSettings.link.unlink')"
        size="sm"
        (closed)="closeUnlink()"
      >
        <p>{{ t('albionSettings.link.unlinkConfirm') }}</p>
        @if (saveState() === 'failed') {
          <p class="hint mt-3" role="alert" style="color: var(--color-error)">
            {{ t('albionSettings.save.failed') }}
          </p>
        }
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeUnlink()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="saveState() === 'saving'"
            (click)="confirmUnlink()"
          >
            {{ t('albionSettings.link.unlink') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class AlbionSettings {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly linkLoading = signal(true);
  protected readonly linkLoadFailed = signal(false);
  protected readonly link = signal<AlbionLinkStatus | null>(null);
  protected readonly saveState = signal<SaveState>('idle');
  protected readonly unlinkConfirm = signal(false);

  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly lookupFailed = signal(false);
  protected readonly results = signal<AlbionSearchResult | null>(null);
  protected readonly selected = signal<AlbionPlayer | null>(null);

  /** Latest search id; a response for an older query is dropped. */
  private searchSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly needsMoreText = computed(() => {
    const length = this.query().trim().length;
    return length > 0 && length < MIN_QUERY_LENGTH;
  });

  /** Row actions on the linked character. Unlinking is destructive, so it confirms. */
  protected readonly linkMenu = computed<MenuItem[]>(() => [
    { id: 'unlink', label: this.t('albionSettings.link.unlink'), icon: 'user-x', danger: true },
  ]);

  /** Kill fame over death fame — the usual shorthand for how a player trades. */
  protected fameRatio(player: AlbionPlayer): string {
    if (player.death_fame <= 0) {
      return player.kill_fame === 0 ? '0.00' : '∞';
    }
    return (player.kill_fame / player.death_fame).toFixed(2);
  }

  protected isSelected(id: string): boolean {
    return this.selected()?.id === id;
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelScheduledSearch());
    void this.loadLink();
  }

  protected async loadLink(): Promise<void> {
    this.linkLoading.set(true);
    this.linkLoadFailed.set(false);
    try {
      this.link.set(await firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me')));
    } catch {
      this.linkLoadFailed.set(true);
    } finally {
      this.linkLoading.set(false);
    }
  }

  protected onLinkAction(id: string): void {
    if (id === 'unlink') {
      this.saveState.set('idle');
      this.unlinkConfirm.set(true);
    }
  }

  protected closeUnlink(): void {
    if (this.saveState() === 'saving') {
      return;
    }
    this.unlinkConfirm.set(false);
    this.saveState.set('idle');
  }

  /** Unlinking drops the identity every regear/split/battle lookup in the
   *  app resolves through — a misclick has real consequences elsewhere. */
  protected async confirmUnlink(): Promise<void> {
    if (this.saveState() === 'saving') {
      return;
    }
    this.saveState.set('saving');
    try {
      await firstValueFrom(this.api.delete<null>('api/albion/link'));
      this.link.set({ linked: false });
      this.unlinkConfirm.set(false);
      this.saveState.set('saved');
      this.toasts.success(this.t('albionSettings.link.unlinked'));
    } catch {
      this.saveState.set('failed');
      this.toasts.error(this.t('albionSettings.save.failed'));
    }
  }

  /** Live lookup: waits for a pause in typing, then asks Albion. */
  protected onQueryChange(value: string): void {
    this.query.set(value);
    this.cancelScheduledSearch();
    if (value.trim().length < MIN_QUERY_LENGTH) {
      this.clearLookup();
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.search();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected clearLookup(): void {
    this.cancelScheduledSearch();
    this.searchSeq++;
    this.query.set('');
    this.results.set(null);
    this.selected.set(null);
    this.searching.set(false);
    this.lookupFailed.set(false);
  }

  protected async search(): Promise<void> {
    const q = this.query().trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return;
    }
    const seq = ++this.searchSeq;
    this.searching.set(true);
    this.lookupFailed.set(false);
    this.selected.set(null);
    try {
      const found = await firstValueFrom(
        this.api.get<AlbionSearchResult>('api/albion/search', { q }),
      );
      if (seq === this.searchSeq) {
        this.results.set(found);
      }
    } catch {
      if (seq === this.searchSeq) {
        this.results.set(null);
        this.lookupFailed.set(true);
      }
    } finally {
      if (seq === this.searchSeq) {
        this.searching.set(false);
      }
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
      if (this.selected()?.id === player.id) {
        this.selected.set(detail);
      }
    } catch {
      // Keep the search-result view.
    }
  }

  private cancelScheduledSearch(): void {
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }
}
