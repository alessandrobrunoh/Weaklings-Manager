import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompSummary,
  CreateEventRequest,
  EventView,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/**
 * Dedicated creation form for guild events.
 *
 * Lives at `/events/new` (registered before `/events/:eventId` so Angular does
 * not treat the literal segment as an id). Extracted from the legacy inline
 * form on the events list so members do not see empty creation scaffolding and
 * officers get a clearer, focused flow.
 *
 * @example
 * ```ts
 * routes.push({
 *   path: 'events/new',
 *   loadComponent: () => import('./event-create').then(m => m.EventCreatePage),
 * });
 * ```
 */
@Component({
  selector: 'app-event-create-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader],
  template: `
    <app-page-header [title]="t('events.new')" [subtitle]="t('events.subtitle')" />

    <form class="card grid gap-4 p-5" (submit)="onSubmit($event)">
        <label>
          <span class="label">{{ t('common.name') }}</span>
          <input class="input" type="text" [value]="draftTitle()" (input)="onTitleChange($event)" />
        </label>

        <label>
          <span class="label">{{ t('common.description') }}</span>
          <textarea
            class="textarea"
            rows="3"
            [value]="draftDescription()"
            (input)="onDescriptionChange($event)"
          ></textarea>
        </label>

        <div class="grid gap-4 sm:grid-cols-2">
          <label>
            <span class="label">{{ t('events.detail.comp') }}</span>
            <select
              class="select"
              [value]="draftCompId()"
              [disabled]="loading()"
              (change)="onCompChange($event)"
            >
              <option value="">{{ loading() ? t('common.loading') : '—' }}</option>
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
              [attr.min]="minScheduledAt"
              [value]="draftScheduledAt()"
              (input)="onScheduledAtChange($event)"
            />
          </label>
        </div>

        <label class="flex items-center gap-2">
          <input
            class="checkbox"
            type="checkbox"
            [checked]="draftCallToArms()"
            (change)="onCallToArmsChange($event)"
          />
          <span>{{ t('events.call_to_arms') }}</span>
        </label>

        <label class="flex items-start gap-2">
          <input
            class="checkbox mt-0.5"
            type="checkbox"
            [checked]="draftCreateSplit()"
            (change)="onCreateSplitChange($event)"
          />
          <span>
            {{ t('events.createSplit') }}
            <span class="mt-0.5 block text-xs" style="color: var(--color-text-secondary)">
              {{ t('events.createSplitHint') }}
            </span>
          </span>
        </label>

        @if (compError()) {
          <p class="text-sm" style="color: var(--color-danger)">{{ compError() }}</p>
        }

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="cancel()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ t('common.create') }}
          </button>
        </div>
      </form>
  `,
})
export class EventCreatePage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftScheduledAt = signal(defaultScheduledAt());
  protected readonly minScheduledAt = minScheduledAt();
  protected readonly draftCallToArms = signal(false);
  /** Pre-create the loot split so it is already attached to the event. */
  protected readonly draftCreateSplit = signal(false);
  protected readonly compError = signal<string | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.loadComps();
  }

  /** Two-way bind helper for the title input. */
  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  /** Two-way bind helper for the description textarea. */
  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  /** Two-way bind helper for the scheduled-at input. */
  protected onScheduledAtChange(event: Event): void {
    this.draftScheduledAt.set((event.target as HTMLInputElement).value);
  }

  /** Two-way bind helper for the comp select. */
  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
    this.compError.set(null);
  }

  /** Two-way bind helper for the call-to-arms checkbox. */
  protected onCreateSplitChange(event: Event): void {
    this.draftCreateSplit.set((event.target as HTMLInputElement).checked);
  }

  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
  }

  /** Returns to the events list without creating anything. */
  protected cancel(): void {
    void this.router.navigate(['/events']);
  }

  /** Validates input then POSTs to `/api/events` and redirects to detail. */
  protected async onSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();

    const title = this.draftTitle().trim();
    const compId = Number(this.draftCompId());

    if (!title) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (compId <= 0) {
      this.compError.set(this.t('events.create.comp_required'));
      return;
    }

    // The datetime-local input has no native `required` that actually
    // fires — `submit.preventDefault()` above runs unconditionally, so the
    // browser's own constraint validation never gets a chance to block
    // this. Without this check, a cleared field reached `new Date('')`,
    // whose `.toISOString()` throws uncaught: the form went silently dead,
    // no toast, `saving` never reset.
    const scheduledAt = new Date(this.draftScheduledAt());
    if (Number.isNaN(scheduledAt.getTime())) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const request: CreateEventRequest = {
      title,
      comp_id: compId,
      event_date_utc: scheduledAt.toISOString(),
      call_to_arms: this.draftCallToArms(),
      create_split: this.draftCreateSplit(),
    };
    const description = this.draftDescription().trim();
    if (description) {
      request.description = description;
    }

    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.post<EventView>('api/events', request));
      this.toasts.success(this.t('common.create'));
      void this.router.navigate(['/events', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Pre-populates the composition dropdown for officers. */
  private async loadComps(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 }),
      );
      this.comps.set(result.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}

/** Formats a `Date` as `YYYY-MM-DDTHH:mm` in the user's local timezone, the
 *  shape `<input type="datetime-local">` round-trips through. */
function formatDatetimeLocal(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Snap to the next whole hour so the default event time is human-readable. */
function defaultScheduledAt(): string {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  nextHour.setMinutes(0, 0, 0);
  return formatDatetimeLocal(nextHour);
}

/** Floor for the date picker — the form has no business scheduling an event
 *  in the past. Uses "now" rather than the snapped-forward default so an
 *  officer can still pick a moment sooner than the next whole hour. */
function minScheduledAt(): string {
  return formatDatetimeLocal(new Date());
}
