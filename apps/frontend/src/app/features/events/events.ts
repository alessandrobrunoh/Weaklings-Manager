import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { EventDetailView, EventView, PaginatedData } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

const PAGE_SIZE = 10;

/**
 * Events list page.
 *
 * Shows a paginated grid of guild events with quick state actions (join, leave,
 * start, stop). Creation now lives on a dedicated route (`/events/new`) so the
 * list stays focused on browsing; clicking any card opens the analytics view.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, ErrorState, Loading, StatusChip],
  template: `
    <app-page-header [title]="t('events.title')" [subtitle]="t('events.subtitle')">
      @if (canManage()) {
        <button type="button" class="btn btn--primary" (click)="openCreateForm()">
          {{ t('events.new') }}
        </button>
      }
    </app-page-header>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (events().length === 0) {
      <app-empty-state [message]="t('common.empty')" icon="calendar" />
    } @else {
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        @for (event of events(); track event.id) {
          <article class="card p-5">
            <header
              class="mb-3 flex cursor-pointer items-start justify-between gap-2"
              (click)="openEventDetail(event.id)"
            >
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                @if (event.call_to_arms) {
                  <span class="cta-star" title="{{ t('events.call_to_arms') }}">★</span>
                }
                {{ event.title }}
              </h2>
              <app-status-chip [value]="event.status" />
            </header>

            @if (event.description) {
              <p
                class="mb-3 cursor-pointer text-sm"
                style="color: var(--color-text-secondary)"
                (click)="openEventDetail(event.id)"
              >
                {{ event.description }}
              </p>
            }

            <p
              class="mb-4 cursor-pointer text-xs"
              style="color: var(--color-text-secondary)"
              (click)="openEventDetail(event.id)"
            >
              {{ t('common.date') }}: {{ formatDate(event.event_date_utc) }} · {{ event.comp_name }}
            </p>

            <footer class="flex flex-wrap gap-2">
              @if (event.status === 'scheduled') {
                <button type="button" class="btn btn--tonal" (click)="join(event.id)">
                  {{ t('events.viewAndJoin') }}
                </button>
                <button type="button" class="btn btn--outline" (click)="leave(event.id)">
                  {{ t('events.leave') }}
                </button>
              }
              @if (canManage() && event.status === 'scheduled') {
                <button type="button" class="btn btn--primary" (click)="start(event.id)">
                  {{ t('events.start') }}
                </button>
              }
              @if (canManage() && event.status === 'live') {
                <button type="button" class="btn btn--danger" (click)="stop(event.id)">
                  {{ t('events.stop') }}
                </button>
              }
              <button type="button" class="btn btn--outline" (click)="openEventDetail(event.id)">
                {{ t('common.view') }}
              </button>
              @if (canManage()) {
                <button type="button" class="btn btn--danger" (click)="deleteEvent(event.id)">
                  {{ t('common.delete') }}
                </button>
              }
            </footer>
          </article>
        }
      </div>

      <div class="mt-4 flex items-center justify-between">
        <p class="text-xs" style="color: var(--color-text-secondary)">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    }
  `,
})
export class Events {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly events = signal<EventView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** True when the current user can create, start, or stop events. */
  protected canManage(): boolean {
    return this.auth.hasPermission('events.manage');
  }

  /** Opens the dedicated create event route. */
  protected openCreateForm(): void {
    void this.router.navigate(['/events/new']);
  }

  /** Opens the analytics view for a single event. */
  protected openEventDetail(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  /** Formats ISO date strings using the browser locale. */
  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Opens the detail page, where picking a build is what actually joins. */
  protected async join(id: number): Promise<void> {
    void this.router.navigate(['/events', id]);
  }

  /** Cancels the current user's participation in the event. */
  protected async leave(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/participate`, 'DELETE', null);
  }

  /** Marks a scheduled event as live; reserved to officers/admins. */
  protected async start(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/start`, 'POST', {});
  }

  /** Stops a live event; reserved to officers/admins. Stopping closes
   *  participation and triggers regear extraction from every linked battle —
   *  a real, mostly-irreversible consequence — so it needs the same confirm
   *  guard event-detail.ts's identical action already has. */
  protected async stop(id: number): Promise<void> {
    if (!window.confirm(this.t('common.confirm'))) {
      return;
    }
    await this.mutate(`api/events/${id}/stop`, 'POST', {});
  }

  /** Deletes an event from the list; reserved to officers/admins. */
  protected async deleteEvent(id: number): Promise<void> {
    if (!window.confirm(this.t('common.confirm'))) {
      return;
    }
    await this.mutate(`api/events/${id}`, 'DELETE', null);
  }

  /** Advances to the next page of events. */
  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.load();
  }

  /** Returns to the previous page of events. */
  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', {
          page: this.page(),
          limit: PAGE_SIZE,
        }),
      );
      this.events.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.loadFailed.set(true);
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
