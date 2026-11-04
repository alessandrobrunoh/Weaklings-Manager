import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  DiscordChannelView,
  DiscordRoleView,
  GuildRankView,
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
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { channelSelectOptions } from '../../shared/discord/discord-options';

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
  styles: [COMPACT_FEATURE_STYLES],
  imports: [ErrorState, Loading, PageHeader, PageStack, SearchableSelect],
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
          <p class="text-xs sm:col-span-3" style="color: var(--color-text-secondary)">
            {{ t('validation.requiredLegend') }}
          </p>
          <p class="sm:col-span-3 eyebrow">{{ t('admin.progression.curve') }}</p>
          <label>
            <span class="label">
              {{ t('admin.progression.xpBase') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="1" required [value]="progressionDraft().xp_base"
              (input)="updateProgressionNumber('xp_base', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.xpExponent') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="1" step="0.1" required
              [value]="progressionDraft().xp_exponent"
              (input)="updateProgressionNumber('xp_exponent', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.maxLevel') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="1" required [value]="progressionDraft().max_level"
              (input)="updateProgressionNumber('max_level', $event)" />
          </label>

          <p class="sm:col-span-3 eyebrow mt-2">{{ t('admin.progression.rates') }}</p>
          <label>
            <span class="label">
              {{ t('admin.progression.xpMessage') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().xp_message"
              (input)="updateProgressionNumber('xp_message', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.xpEventCreate') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().xp_event_create"
              (input)="updateProgressionNumber('xp_event_create', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.xpEventJoin') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().xp_event_join"
              (input)="updateProgressionNumber('xp_event_join', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.xpEventComplete') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().xp_event_complete"
              (input)="updateProgressionNumber('xp_event_complete', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.xpVod') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().xp_vod"
              (input)="updateProgressionNumber('xp_vod', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.warnThreshold') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="1" required [value]="progressionDraft().warn_threshold"
              (input)="updateProgressionNumber('warn_threshold', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.cooldown') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().message_cooldown_secs"
              (input)="updateProgressionNumber('message_cooldown_secs', $event)" />
          </label>
          <label>
            <span class="label">
              {{ t('admin.progression.minChars') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input mono" type="number" min="0" required [value]="progressionDraft().message_min_chars"
              (input)="updateProgressionNumber('message_min_chars', $event)" />
          </label>
          <label class="sm:col-span-3">
            <span class="label">{{ t('admin.progression.vodForum') }}</span>
            <app-searchable-select
              class="mt-1 block"
              [options]="forumChannelOptions()"
              [value]="progressionDraft().vod_forum_channel_id"
              [emptyLabel]="t('admin.discord.placeholder')"
              [searchPlaceholder]="t('common.search')"
              [noMatchesLabel]="t('picker.noMatches')"
              [emptyOptionsLabel]="t('picker.empty')"
              [ariaLabel]="t('admin.progression.vodForum')"
              (valueChange)="setVodForumChannel($event)"
            />
          </label>
          <div class="sm:col-span-3">
            <button type="submit" class="btn btn--primary" [disabled]="progressionSaving()">
              {{ t('admin.progression.save') }}
            </button>
          </div>
        </form>

        <form class="mt-8 border-t pt-6" style="border-color: var(--color-border)"
          (submit)="saveGuildRanks($event)">
          <h3 class="eyebrow mb-2">{{ t('admin.progression.ranksTitle') }}</h3>
          <p class="mb-4 text-sm" style="color: var(--color-text-secondary)">
            {{ t('admin.progression.ranksHint') }}
          </p>
          <p class="mb-4 text-xs" style="color: var(--color-text-secondary)">
            {{ t('validation.requiredLegend') }}
          </p>
          <ul class="grid gap-3" role="list">
            @for (rank of guildRanks(); track $index; let i = $index) {
              <li class="grid gap-3 sm:grid-cols-3">
                <label>
                  <span class="label">
                    {{ t('admin.progression.rankName') }}
                    <span style="color: var(--color-error)" aria-hidden="true">*</span>
                  </span>
                  <input class="input" [id]="'guild-rank-name-' + i" [value]="rank.name"
                    maxlength="40" required
                    (input)="updateGuildRank(i, 'name', $event)" />
                </label>
                <label>
                  <span class="label">
                    {{ t('admin.progression.rankMinXp') }}
                    <span style="color: var(--color-error)" aria-hidden="true">*</span>
                  </span>
                  <input class="input mono" type="number" min="0" [value]="rank.min_xp"
                    [readonly]="i === 0" required
                    (input)="updateGuildRank(i, 'min_xp', $event)" />
                </label>
                <label>
                  <span class="label">{{ t('admin.progression.rankDiscordRole') }}</span>
                  <select class="input" [value]="rank.discord_role_id ?? ''"
                    (change)="updateGuildRole(i, $event)">
                    <option value="">{{ t('admin.progression.rankUnmapped') }}</option>
                    @for (role of discordRoles(); track role.id) {
                      <option [value]="role.id">{{ role.name }} ({{ role.id }})</option>
                    }
                    @if (rank.discord_role_id && !hasDiscordRole(rank.discord_role_id)) {
                      <option [value]="rank.discord_role_id">
                        {{ rank.discord_role_id }} ({{ t('admin.progression.rankUnavailable') }})
                      </option>
                    }
                  </select>
                </label>
                @if (i > 0) {
                  <button type="button" class="btn btn--outline btn--sm sm:col-span-3 justify-self-start"
                    (click)="removeGuildRank(i)">
                    {{ t('admin.progression.rankRemove', { name: rank.name }) }}
                  </button>
                }
              </li>
            }
          </ul>
          <div class="mt-4 flex flex-wrap gap-3">
            <button type="button" class="btn btn--outline" [disabled]="guildRanks().length >= 20"
              (click)="addGuildRank()">
              {{ t('admin.progression.rankAdd') }}
            </button>
            <button type="submit" class="btn btn--primary" [disabled]="rankSaving()">
              {{ t('admin.progression.rankSave') }}
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
                <form class="grid gap-3 sm:grid-cols-3" (submit)="saveSeason($event, season.id)">
                  <p class="text-xs sm:col-span-3" style="color: var(--color-text-secondary)">
                    {{ t('validation.requiredLegend') }}
                  </p>
                  <label>
                    <span class="label">
                      {{ t('admin.progression.seasonName') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input" type="text" [value]="seasonEdits()[season.id]?.name ?? season.name"
                      required (input)="updateSeasonEdit(season.id, 'name', $event)" />
                  </label>
                  <label>
                    <span class="label">
                      {{ t('admin.progression.startsAt') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="datetime-local"
                      required
                      [value]="seasonEdits()[season.id]?.starts_at ?? toLocalInput(season.starts_at)"
                      (input)="updateSeasonEdit(season.id, 'starts_at', $event)" />
                  </label>
                  <label>
                    <span class="label">
                      {{ t('admin.progression.endsAt') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="datetime-local"
                      required
                      [value]="seasonEdits()[season.id]?.ends_at ?? toLocalInput(season.ends_at)"
                      (input)="updateSeasonEdit(season.id, 'ends_at', $event)" />
                  </label>
                  <div class="sm:col-span-3">
                    <button type="submit" class="btn btn--outline btn--sm">
                      {{ t('common.save') }}
                    </button>
                  </div>
                </form>
              </li>
            }
          </ul>

          <form class="mt-4 grid gap-3 sm:grid-cols-3" (submit)="createSeason($event)">
            <p class="text-xs sm:col-span-3" style="color: var(--color-text-secondary)">
              {{ t('validation.requiredLegend') }}
            </p>
            <label>
              <span class="label">
                {{ t('admin.progression.seasonName') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input" type="text" [value]="newSeason().name"
                (input)="updateNewSeason('name', $event)" required />
            </label>
            <label>
              <span class="label">
                {{ t('admin.progression.startsAt') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input mono" type="datetime-local" [value]="newSeason().starts_at"
                (input)="updateNewSeason('starts_at', $event)" required />
            </label>
            <label>
              <span class="label">
                {{ t('admin.progression.endsAt') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
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
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly guildRanks = signal<GuildRankView[]>([]);
  protected readonly rankSaving = signal(false);
  protected readonly seasonEdits = signal<Record<number, SeasonEdit>>({});
  protected readonly newSeason = signal<NewSeasonDraft>({
    name: '',
    starts_at: '',
    ends_at: '',
    activate: true,
  });

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

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
      this.guildRanks.set(settings.guild_ranks);
      this.progressionSeasons.set(seasons);
      void this.loadDiscordChannels();
      void this.loadDiscordRoles();
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

  protected forumChannelOptions() {
    return channelSelectOptions(
      this.discordChannels(),
      ['forum'],
      this.progressionDraft().vod_forum_channel_id,
    );
  }

  protected setVodForumChannel(channelId: string): void {
    this.progressionDraft.update((draft) => ({ ...draft, vod_forum_channel_id: channelId }));
  }

  private async loadDiscordChannels(): Promise<void> {
    try {
      const channels = await firstValueFrom(
        this.api.get<DiscordChannelView[]>('api/admin/discord/channels'),
      );
      this.discordChannels.set(channels);
    } catch {
      // The VOD picker stays empty until Discord listing is available.
    }
  }

  private async loadDiscordRoles(): Promise<void> {
    try {
      this.discordRoles.set(await firstValueFrom(
        this.api.get<DiscordRoleView[]>('api/admin/discord/roles'),
      ));
    } catch {
      // Existing mappings remain visible as unavailable options.
    }
  }

  protected hasDiscordRole(roleId: string): boolean {
    return this.discordRoles().some((role) => role.id === roleId);
  }

  protected updateGuildRank(index: number, field: 'name' | 'min_xp', event: Event): void {
    const value = field === 'name'
      ? (event.target as HTMLInputElement).value
      : Number((event.target as HTMLInputElement).value);
    this.guildRanks.update((ranks) => ranks.map((rank, i) =>
      i === index ? { ...rank, [field]: value } : rank,
    ));
  }

  protected updateGuildRole(index: number, event: Event): void {
    const roleId = (event.target as HTMLSelectElement).value;
    this.guildRanks.update((ranks) => ranks.map((rank, i) =>
      i === index ? { ...rank, discord_role_id: roleId || null } : rank,
    ));
  }

  protected addGuildRank(): void {
    this.guildRanks.update((ranks) => ranks.length >= 20
      ? ranks
      : [...ranks, {
          name: this.t('admin.progression.rankNewName'),
          min_xp: (ranks.at(-1)?.min_xp ?? -1) + 1,
          discord_role_id: null,
        }]);
  }

  protected removeGuildRank(index: number): void {
    if (index === 0) {
      return;
    }
    this.guildRanks.update((ranks) => ranks.filter((_, i) => i !== index));
  }

  protected async saveGuildRanks(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.rankSaving.set(true);
    try {
      const updated = await firstValueFrom(this.api.put<ProgressionSettingsView>(
        'api/progression/settings',
        { guild_ranks: this.guildRanks() },
      ));
      this.guildRanks.set(updated.guild_ranks);
      this.progressionSettings.set(updated);
      this.toasts.success(this.t('admin.progression.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.rankSaving.set(false);
    }
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

  protected async saveSeason(submit: SubmitEvent, id: number): Promise<void> {
    submit.preventDefault();
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
