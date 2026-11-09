import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AlbionLinkRequestView, AlbionLinkStatus } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';

/**
 * Officer queue for self-service Albion link requests.
 *
 * Albion cannot prove who owns a character, so a member's link is only a request until someone
 * with `roles.manage` approves it here. Renders nothing for everyone else, and nothing while the
 * queue is empty, so it costs no space on the members page.
 *
 * Approving can fail with `409` when the character was linked in the meantime; the officer then
 * rejects the request or removes the other link first.
 */
@Component({
  selector: 'app-albion-link-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (requests().length > 0) {
      <section class="card p-4 sm:p-5" [attr.aria-label]="t('albion.requests.title')">
        <header class="mb-3">
          <h2 class="text-sm font-semibold" style="color: var(--color-text)">
            {{ t('albion.requests.title') }}
            <span class="font-mono" style="color: var(--color-warning)">
              ({{ requests().length }})
            </span>
          </h2>
          <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
            {{ t('albion.requests.subtitle') }}
          </p>
        </header>

        <ul class="flex flex-col gap-2">
          @for (request of requests(); track request.id) {
            <li class="surface flex flex-wrap items-center justify-between gap-3 p-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium" style="color: var(--color-text)">
                  {{ request.username ?? request.discord_id }}
                  <span style="color: var(--color-text-secondary)">→</span>
                  {{ request.albion_player_name }}
                </p>
                <p class="eyebrow">
                  {{ request.albion_guild_name ?? t('albionSettings.lookup.noGuild') }}
                </p>
                @if (request.character_already_linked) {
                  <p class="mt-1 text-xs" style="color: var(--color-error)">
                    {{ t('albion.requests.alreadyLinked') }}
                  </p>
                } @else if (request.competing_requests > 0) {
                  <p class="mt-1 text-xs" style="color: var(--color-warning)">
                    {{ t('albion.requests.competing', { count: request.competing_requests }) }}
                  </p>
                }
              </div>
              <div class="flex shrink-0 gap-2">
                <button
                  type="button"
                  class="btn btn--primary btn--sm"
                  [disabled]="busyId() === request.id || request.character_already_linked"
                  (click)="approve(request)"
                >
                  <app-icon name="check" size="0.875rem" />
                  {{ t('albion.requests.approve') }}
                </button>
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  [disabled]="busyId() === request.id"
                  (click)="reject(request)"
                >
                  <app-icon name="close" size="0.875rem" />
                  {{ t('albion.requests.reject') }}
                </button>
              </div>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class AlbionLinkRequests {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly requests = signal<AlbionLinkRequestView[]>([]);
  protected readonly busyId = signal<number | null>(null);
  private readonly canReview = computed(() => this.auth.hasPermission('roles.manage'));

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.canReview()) {
      return;
    }
    try {
      const rows = await firstValueFrom(
        this.api.get<AlbionLinkRequestView[]>('api/albion/link/requests'),
      );
      this.requests.set(rows ?? []);
    } catch {
      // The queue is a convenience on the members page; a failure must not block the page.
      this.requests.set([]);
    }
  }

  protected async approve(request: AlbionLinkRequestView): Promise<void> {
    await this.decide(request, async () => {
      await firstValueFrom(
        this.api.post<AlbionLinkStatus>(`api/albion/link/requests/${request.id}/approve`, {}),
      );
      this.toasts.success(
        this.t('albion.requests.approved', {
          name: request.albion_player_name,
          username: request.username ?? request.discord_id,
        }),
      );
    });
  }

  protected async reject(request: AlbionLinkRequestView): Promise<void> {
    await this.decide(request, async () => {
      await firstValueFrom(
        this.api.post<null>(`api/albion/link/requests/${request.id}/reject`, {}),
      );
      this.toasts.success(this.t('albion.requests.rejected'));
    });
  }

  private async decide(request: AlbionLinkRequestView, action: () => Promise<void>): Promise<void> {
    if (this.busyId() !== null) {
      return;
    }
    this.busyId.set(request.id);
    try {
      await action();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
      // Reload either way: an approval also drops competing claims, and a failure usually means
      // the queue changed under us.
      await this.load();
    }
  }
}
