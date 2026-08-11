import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  AlbionLinkRequest,
  AlbionLinkStatus,
  PaginatedData,
} from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../icon/icon';
import { Loading } from '../loading/loading';
import { WeaklingsLogo } from '../weaklings-logo/weaklings-logo';

/**
 * Blocking character-link gate for authenticated users.
 *
 * The guild requires every Discord account to be linked to an Albion character
 * before using operational tools. This component intentionally has no close or
 * escape action; it disappears only after the backend confirms a successful
 * link. Unlinking is no longer self-service, so changing character remains an
 * administrator workflow.
 *
 * # Example
 * ```html
 * <app-albion-link-gate (linked)="reloadUserContext()" />
 * ```
 */
@Component({
  selector: 'app-albion-link-gate',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Loading, WeaklingsLogo],
  template: `
    @if (loadingStatus()) {
      <div class="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
        <section class="card w-full max-w-lg p-8">
          <app-loading [label]="t('common.loading')" />
        </section>
      </div>
    } @else if (status()?.linked === false) {
      <div class="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
        <section class="card w-full max-w-2xl p-6 sm:p-8" role="dialog" aria-modal="true">
          <div class="mb-6 flex flex-col items-center text-center">
            <app-weaklings-logo />
            <h2 class="mt-5 text-2xl font-semibold" style="color: var(--color-text)">
              {{ t('albion.required.title') }}
            </h2>
            <p class="mt-2 max-w-xl text-sm" style="color: var(--color-text-secondary)">
              {{ t('albion.required.subtitle') }}
            </p>
          </div>

          <form class="mb-4 flex flex-col gap-2 sm:flex-row" (submit)="onSearchSubmit($event)">
            <input
              type="text"
              class="input"
              [placeholder]="t('albion.search_roster')"
              [value]="query()"
              (input)="onQueryChange($event)"
            />
            <button
              type="submit"
              class="btn btn--primary"
              [disabled]="searching() || !query().trim()"
            >
              <app-icon name="search" size="1rem" />
              {{ t('common.search') }}
            </button>
          </form>

          @if (searching()) {
            <app-loading />
          } @else if (roster().length > 0) {
            <div class="grid max-h-80 gap-2 overflow-y-auto pr-1 scrollbar-thin sm:grid-cols-2">
              @for (member of roster(); track member.id) {
                <button
                  type="button"
                  class="surface flex items-center justify-between gap-3 p-3 text-left"
                  (click)="link(member)"
                >
                  <span class="font-medium" style="color: var(--color-text)">{{
                    member.name
                  }}</span>
                  <app-icon name="chevron-right" size="1rem" />
                </button>
              }
            </div>
          } @else if (searched()) {
            <p
              class="rounded-lg px-4 py-3 text-sm"
              style="background-color: var(--color-surface-1); color: var(--color-text-secondary)"
            >
              {{ t('common.empty') }}
            </p>
          }
        </section>
      </div>
    }
  `,
})
export class AlbionLinkGate {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly linked = output<AlbionLinkStatus>();

  protected readonly status = signal<AlbionLinkStatus | null>(null);
  protected readonly roster = signal<AlbionGuildMember[]>([]);
  protected readonly loadingStatus = signal(false);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly query = signal('');

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.loadStatus();
  }

  protected onQueryChange(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.search();
  }

  private async search(): Promise<void> {
    const query = this.query().trim();
    if (!query || this.searching()) {
      return;
    }

    this.searching.set(true);
    try {
      const rosterPage = await firstValueFrom(
        this.api.get<PaginatedData<AlbionGuildMember>>('api/albion/guild/roster', {
          q: query,
          limit: 50,
        }),
      );
      this.roster.set(rosterPage.items);
      this.searched.set(true);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searching.set(false);
    }
  }

  protected async link(member: AlbionGuildMember): Promise<void> {
    const request: AlbionLinkRequest = {
      albion_player_id: member.id,
      albion_player_name: member.name,
    };

    try {
      const linkStatus = await firstValueFrom(
        this.api.post<AlbionLinkStatus>('api/albion/link', request),
      );
      this.status.set(linkStatus);
      this.linked.emit(linkStatus);
      this.roster.set([]);
      this.query.set('');
      this.toasts.success(this.translate.t('albion.linked', { name: member.name }));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async loadStatus(): Promise<void> {
    this.loadingStatus.set(true);
    try {
      const linkStatus = await firstValueFrom(this.api.get<AlbionLinkStatus>('api/albion/link/me'));
      this.status.set(linkStatus);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loadingStatus.set(false);
    }
  }
}
