import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompSummary,
  CreateEventRequest,
  EventDetailView,
  EventStatus,
  EventView,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

/**
 * Events page for scheduling and running guild activities.
 *
 * Members can join/leave scheduled events; officers/admins additionally
 * create, start, and stop sessions from the same focused screen.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading],
  template: `
    <app-page-header [title]="t('events.title')" [subtitle]="t('events.subtitle')">
      @if (canManage()) {
        <button type="button" class="btn btn--primary" (click)="toggleCreateForm()">
          {{ showCreateForm() ? t('common.close') : t('events.new') }}
        </button>
      }
    </app-page-header>

    @if (showCreateForm()) {
      <form class="card mb-6 grid gap-4 p-5" (submit)="onCreateSubmit($event)">
        <label>
          <span class="label">{{ t('common.name') }}</span>
          <input class="input" type="text" [value]="draftTitle()" (input)="onTitleChange($event)" />
        </label>
        <label>
          <span class="label">Description</span>
          <textarea
            class="textarea"
            rows="3"
            [value]="draftDescription()"
            (input)="onDescriptionChange($event)"
          ></textarea>
        </label>
        <label>
          <span class="label">Composition</span>
          <select class="select" [value]="draftCompId()" (change)="onCompChange($event)">
            <option value="">Select comp</option>
            @for (comp of comps(); track comp.id) {
              <option [value]="comp.id">{{ comp.name }}</option>
            }
          </select>
        </label>
        <label>
          <span class="label">{{ t('common.date') }}</span>
          <input
            class="input"
            type="datetime-local"
            [value]="draftScheduledAt()"
            (input)="onScheduledAtChange($event)"
          />
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="toggleCreateForm()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ t('common.create') }}
          </button>
        </div>
      </form>
    }

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
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
              <h3 class="text-base font-semibold" style="color: var(--color-text)">
                {{ event.title }}
              </h3>
              <span class="chip" [class]="statusChip(event.status)">
                {{ event.status }}
              </span>
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
                  {{ t('events.participate') }}
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
                Stats
              </button>
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
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly saving = signal(false);
  protected readonly showCreateForm = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftScheduledAt = signal(this.defaultScheduledAt());

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    void this.loadComps();
  }

  protected canManage(): boolean {
    return this.auth.hasPermission('events.manage');
  }

  protected toggleCreateForm(): void {
    this.showCreateForm.update((isVisible) => !isVisible);
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onScheduledAtChange(event: Event): void {
    this.draftScheduledAt.set((event.target as HTMLInputElement).value);
  }

  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
  }

  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createEvent();
  }

  private async createEvent(): Promise<void> {
    const title = this.draftTitle().trim();
    const compId = Number(this.draftCompId());
    if (!title || compId <= 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.saving.set(true);
    try {
      const request: CreateEventRequest = {
        title,
        comp_id: compId,
        event_date_utc: new Date(this.draftScheduledAt()).toISOString(),
      };
      const description = this.draftDescription().trim();
      if (description) {
        request.description = description;
      }
      await firstValueFrom(this.api.post<EventView>('api/events', request));
      this.resetCreateForm();
      await this.load();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected statusChip(status: EventStatus): string {
    if (status === 'live') {
      return 'chip chip--success';
    }
    if (status === 'auto_stopped') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  protected async join(id: number): Promise<void> {
    this.toasts.info('Open event detail to select a build before joining.');
    void id;
  }

  /** Opens the dedicated event analytics route. */
  protected openEventDetail(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  protected async leave(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/participate`, 'DELETE', null);
  }

  protected async start(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/start`, 'POST', {});
  }

  protected async stop(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/stop`, 'POST', {});
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.load();
  }

  private resetCreateForm(): void {
    this.draftTitle.set('');
    this.draftDescription.set('');
    this.draftCompId.set('');
    this.draftScheduledAt.set(this.defaultScheduledAt());
    this.showCreateForm.set(false);
  }

  private defaultScheduledAt(): string {
    const nextHour = new Date(Date.now() + 60 * 60 * 1000);
    nextHour.setMinutes(0, 0, 0);
    return nextHour.toISOString().slice(0, 16);
  }

  private async loadComps(): Promise<void> {
    try {
      const comps = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 }),
      );
      this.comps.set(comps.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
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
