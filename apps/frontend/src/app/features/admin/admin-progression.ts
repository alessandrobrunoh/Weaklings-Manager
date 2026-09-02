import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ProgressionSeasonView,
  ProgressionSettingsView,
  UpdateProgressionSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface ProgressionDraft {
  xp_base: number;
  xp_exponent: number;
  max_level: number;
  xp_message: number;
  xp_event_create: number;
  xp_event_join: number;
  xp_event_complete: number;
  xp_vod: number;
  message_cooldown_secs: number;
  message_min_chars: number;
  warn_threshold: number;
  vod_forum_channel_id: string;
}

interface SeasonEdit {
  name: string;
  starts_at: string;
  ends_at: string;
}

interface NewSeasonDraft {
  name: string;
  starts_at: string;
  ends_at: string;
  activate: boolean;
}

const EMPTY_PROGRESSION_DRAFT: ProgressionDraft = {
  xp_base: 100,
  xp_exponent: 1.5,
  max_level: 50,
  xp_message: 1,
  xp_event_create: 25,
  xp_event_join: 10,
  xp_event_complete: 15,
  xp_vod: 40,
  message_cooldown_secs: 60,
  message_min_chars: 2,
  warn_threshold: 3,
  vod_forum_channel_id: '',
};

/**
 * Season XP curve, rates, and season calendar.
 */
@Component({
  selector: 'app-admin-progression',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorState, Loading, PageHeader, PageStack],
  template: `
    <app-page-header
      [title]="t('admin.progression.title')"
      [subtitle]="t('admin.progression.hint')"
    />

    @if (progressionLoading()) {
      <app-loading />
    } @else if (progressionSettings(); as settings) {
      <app-page-stack>
      <section class="card p-5">
        <form class="grid gap-4 sm:grid-cols-3" (submit)="saveProgressionSettings($event)">
          <p class="sm:col-span-3 eyebrow">{{ t('admin.progression.curve') }}</p>
          <label>
            <span class="label">{{ t('admin.progression.xpBase') }}</span>
            <input class="input mono" type="number" min="1" [value]="progressionDraft().xp_base"
              (input)="updateProgressionNumber('xp_base', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.xpExponent') }}</span>
            <input class="input mono" type="number" min="1" step="0.1"
              [value]="progressionDraft().xp_exponent"
              (input)="updateProgressionNumber('xp_exponent', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.maxLevel') }}</span>
            <input class="input mono" type="number" min="1" [value]="progressionDraft().max_level"
              (input)="updateProgressionNumber('max_level', $event)" />
          </label>

          <p class="sm:col-span-3 eyebrow mt-2">{{ t('admin.progression.rates') }}</p>
          <label>
            <span class="label">{{ t('admin.progression.xpMessage') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().xp_message"
              (input)="updateProgressionNumber('xp_message', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.xpEventCreate') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().xp_event_create"
              (input)="updateProgressionNumber('xp_event_create', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.xpEventJoin') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().xp_event_join"
              (input)="updateProgressionNumber('xp_event_join', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.xpEventComplete') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().xp_event_complete"
              (input)="updateProgressionNumber('xp_event_complete', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.xpVod') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().xp_vod"
              (input)="updateProgressionNumber('xp_vod', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.warnThreshold') }}</span>
            <input class="input mono" type="number" min="1" [value]="progressionDraft().warn_threshold"
              (input)="updateProgressionNumber('warn_threshold', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.cooldown') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().message_cooldown_secs"
              (input)="updateProgressionNumber('message_cooldown_secs', $event)" />
          </label>
          <label>
            <span class="label">{{ t('admin.progression.minChars') }}</span>
            <input class="input mono" type="number" min="0" [value]="progressionDraft().message_min_chars"
              (input)="updateProgressionNumber('message_min_chars', $event)" />
          </label>
          <label class="sm:col-span-3">
            <span class="label">{{ t('admin.progression.vodForum') }}</span>
            <input class="input mono" type="text" [value]="progressionDraft().vod_forum_channel_id"
              (input)="updateProgressionString('vod_forum_channel_id', $event)" />
          </label>
          <div class="sm:col-span-3">
            <button type="submit" class="btn btn--primary" [disabled]="progressionSaving()">
              {{ t('admin.progression.save') }}
            </button>
          </div>
        </form>

        @if (settings.level_preview.length > 0) {
          <div class="mt-6 overflow-x-auto">
            <h3 class="eyebrow mb-2">{{ t('admin.progression.preview') }}</h3>
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('admin.progression.level') }}</th>
                  <th>{{ t('admin.progression.xpNeeded') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of settings.level_preview; track row.level) {
                  <tr>
                    <td class="mono">{{ row.level }}</td>
                    <td class="mono">{{ row.xp }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        <div class="mt-8">
          <h3 class="eyebrow mb-3">{{ t('admin.progression.seasons') }}</h3>
          <ul class="flex flex-col gap-3" role="list">
            @for (season of progressionSeasons(); track season.id) {
              <li class="rounded-2xl p-3" style="background: var(--color-surface-2); border: 1px solid var(--color-border)">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <strong>{{ season.name }}</strong>
                  @if (season.is_active) {
                    <span class="chip">{{ t('admin.progression.active') }}</span>
                  } @else {
                    <button type="button" class="btn btn--outline btn--sm"
                      (click)="activateSeason(season.id)">
                      {{ t('admin.progression.activate') }}
                    </button>
                  }
                </div>
                <div class="grid gap-3 sm:grid-cols-3">
                  <label>
                    <span class="label">{{ t('admin.progression.seasonName') }}</span>
                    <input class="input" type="text" [value]="seasonEdits()[season.id]?.name ?? season.name"
                      (input)="updateSeasonEdit(season.id, 'name', $event)" />
                  </label>
                  <label>
                    <span class="label">{{ t('admin.progression.startsAt') }}</span>
                    <input class="input mono" type="datetime-local"
                      [value]="seasonEdits()[season.id]?.starts_at ?? toLocalInput(season.starts_at)"
                      (input)="updateSeasonEdit(season.id, 'starts_at', $event)" />
                  </label>
                  <label>
                    <span class="label">{{ t('admin.progression.endsAt') }}</span>
                    <input class="input mono" type="datetime-local"
                      [value]="seasonEdits()[season.id]?.ends_at ?? toLocalInput(season.ends_at)"
                      (input)="updateSeasonEdit(season.id, 'ends_at', $event)" />
                  </label>
                </div>
                <button type="button" class="btn btn--outline btn--sm mt-3"
                  (click)="saveSeason(season.id)">
                  {{ t('common.save') }}
                </button>
              </li>
            }
          </ul>

          <form class="mt-4 grid gap-3 sm:grid-cols-3" (submit)="createSeason($event)">
            <label>
              <span class="label">{{ t('admin.progression.seasonName') }}</span>
              <input class="input" type="text" [value]="newSeason().name"
                (input)="updateNewSeason('name', $event)" required />
            </label>
            <label>
              <span class="label">{{ t('admin.progression.startsAt') }}</span>
              <input class="input mono" type="datetime-local" [value]="newSeason().starts_at"
                (input)="updateNewSeason('starts_at', $event)" required />
            </label>
            <label>
              <span class="label">{{ t('admin.progression.endsAt') }}</span>
              <input class="input mono" type="datetime-local" [value]="newSeason().ends_at"
                (input)="updateNewSeason('ends_at', $event)" required />
            </label>
            <label class="flex items-center gap-2 sm:col-span-2">
              <input class="checkbox" type="checkbox" [checked]="newSeason().activate"
                (change)="toggleNewSeasonActivate($event)" />
              <span>{{ t('admin.progression.activateOnCreate') }}</span>
            </label>
            <div>
              <button type="submit" class="btn btn--primary">
                {{ t('admin.progression.createSeason') }}
              </button>
            </div>
          </form>
        </div>
      </section>
      </app-page-stack>
    } @else {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="loadProgression()"
      />
    }
  `,
})
export class AdminProgression {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly progressionLoading = signal(true);
  protected readonly progressionSaving = signal(false);
  protected readonly progressionSettings = signal<ProgressionSettingsView | null>(null);
  protected readonly progressionDraft = signal<ProgressionDraft>({ ...EMPTY_PROGRESSION_DRAFT });
  protected readonly progressionSeasons = signal<ProgressionSeasonView[]>([]);
  protected readonly seasonEdits = signal<Record<number, SeasonEdit>>({});
  protected readonly newSeason = signal<NewSeasonDraft>({
    name: '',
    starts_at: '',
    ends_at: '',
    activate: true,
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.loadProgression();
  }

  protected async loadProgression(): Promise<void> {
    this.progressionLoading.set(true);
    try {
      const [settings, seasons] = await Promise.all([
        firstValueFrom(this.api.get<ProgressionSettingsView>('api/progression/settings')),
        firstValueFrom(this.api.get<ProgressionSeasonView[]>('api/progression/seasons')),
      ]);
      this.progressionSettings.set(settings);
      this.progressionDraft.set(toProgressionDraft(settings));
      this.progressionSeasons.set(seasons);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.progressionLoading.set(false);
    }
  }

  protected updateProgressionNumber(field: keyof ProgressionDraft, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.progressionDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected updateProgressionString(field: 'vod_forum_channel_id', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.progressionDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected async saveProgressionSettings(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.progressionSaving.set(true);
    try {
      const draft = this.progressionDraft();
      const body: UpdateProgressionSettingsRequest = {
        xp_base: draft.xp_base,
        xp_exponent: draft.xp_exponent,
        max_level: draft.max_level,
        xp_message: draft.xp_message,
        xp_event_create: draft.xp_event_create,
        xp_event_join: draft.xp_event_join,
        xp_event_complete: draft.xp_event_complete,
        xp_vod: draft.xp_vod,
        message_cooldown_secs: draft.message_cooldown_secs,
        message_min_chars: draft.message_min_chars,
        warn_threshold: draft.warn_threshold,
        vod_forum_channel_id: draft.vod_forum_channel_id.trim(),
      };
      const updated = await firstValueFrom(
        this.api.put<ProgressionSettingsView>('api/progression/settings', body),
      );
      this.progressionSettings.set(updated);
      this.progressionDraft.set(toProgressionDraft(updated));
      this.toasts.success(this.t('admin.progression.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.progressionSaving.set(false);
    }
  }

  protected toLocalInput(iso: string): string {
    return toLocalInput(iso);
  }

  protected updateSeasonEdit(id: number, field: keyof SeasonEdit, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.seasonEdits.update((edits) => {
      const current = edits[id] ?? this.seedSeasonEdit(id);
      return { ...edits, [id]: { ...current, [field]: value } };
    });
  }

  private seedSeasonEdit(id: number): SeasonEdit {
    const season = this.progressionSeasons().find((row) => row.id === id);
    return {
      name: season?.name ?? '',
      starts_at: season ? toLocalInput(season.starts_at) : '',
      ends_at: season ? toLocalInput(season.ends_at) : '',
    };
  }

  protected async saveSeason(id: number): Promise<void> {
    const edit = this.seasonEdits()[id] ?? this.seedSeasonEdit(id);
    try {
      const updated = await firstValueFrom(
        this.api.put<ProgressionSeasonView>(`api/progression/seasons/${id}`, {
          name: edit.name.trim(),
          starts_at: fromLocalInput(edit.starts_at),
          ends_at: fromLocalInput(edit.ends_at),
        }),
      );
      this.progressionSeasons.update((rows) =>
        rows.map((row) => (row.id === id ? updated : row)),
      );
      this.toasts.success(this.t('admin.progression.seasonSaved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async activateSeason(id: number): Promise<void> {
    try {
      await firstValueFrom(
        this.api.put<ProgressionSeasonView>(`api/progression/seasons/${id}/activate`, {}),
      );
      await this.loadProgression();
      this.toasts.success(this.t('admin.progression.seasonActivated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected updateNewSeason(field: 'name' | 'starts_at' | 'ends_at', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newSeason.update((draft) => ({ ...draft, [field]: value }));
  }

  protected toggleNewSeasonActivate(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.newSeason.update((draft) => ({ ...draft, activate: checked }));
  }

  protected async createSeason(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const draft = this.newSeason();
    try {
      await firstValueFrom(
        this.api.post<ProgressionSeasonView>('api/progression/seasons', {
          name: draft.name.trim(),
          starts_at: fromLocalInput(draft.starts_at),
          ends_at: fromLocalInput(draft.ends_at),
          activate: draft.activate,
        }),
      );
      this.newSeason.set({ name: '', starts_at: '', ends_at: '', activate: true });
      await this.loadProgression();
      this.toasts.success(this.t('admin.progression.seasonCreated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}

function toProgressionDraft(settings: ProgressionSettingsView): ProgressionDraft {
  return {
    xp_base: settings.xp_base,
    xp_exponent: Number(settings.xp_exponent),
    max_level: settings.max_level,
    xp_message: settings.xp_message,
    xp_event_create: settings.xp_event_create,
    xp_event_join: settings.xp_event_join,
    xp_event_complete: settings.xp_event_complete,
    xp_vod: settings.xp_vod,
    message_cooldown_secs: settings.message_cooldown_secs,
    message_min_chars: settings.message_min_chars,
    warn_threshold: settings.warn_threshold,
    vod_forum_channel_id: settings.vod_forum_channel_id ?? '',
  };
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}
