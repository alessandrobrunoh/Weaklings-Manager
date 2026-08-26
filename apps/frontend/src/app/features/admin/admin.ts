import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  GuildSettingsView,
  PermissionMatrix,
  ProgressionSeasonView,
  ProgressionSettingsView,
  RolePermissionsView,
  UpdateGuildSettingsRequest,
  UpdateProgressionSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/** Where each editable setting actually lives, so admins can find it. */
interface SettingsLink {
  readonly path: string;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
}

const EMPTY_GUILD_SETTINGS_DRAFT: Record<keyof GuildSettingsView, string> = {
  discord_events_channel_id: '',
  discord_battles_channel_id: '',
  discord_battles_cta_channel_id: '',
  discord_audit_log_channel_id: '',
  discord_transaction_spam_channel_id: '',
  discord_event_role_id: '',
};

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
 * Administration console.
 *
 * The authorization matrix is the substance of this page. Roles themselves are
 * owned by Discord — every login overwrites `users.role` from the member's
 * Discord roles — so the meaningful thing an administrator controls is not who
 * holds a role, but what a role is permitted to do. That mapping is data, by
 * design, and until now it could only be changed with direct SQL.
 *
 * The rest of the guild's settings live next to the features they configure;
 * rather than duplicate them here, this page points to where they are.
 */
@Component({
  selector: 'app-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Icon, Loading, PageHeader, RouterLink],
  template: `
    <app-page-header [title]="t('admin.title')" [subtitle]="t('admin.subtitle')" />

    @if (loading()) {
      <app-loading />
    } @else if (matrix(); as data) {
      <section class="card mb-6 overflow-x-auto">
        <header class="flex flex-wrap items-center justify-between gap-3 p-4 pb-2">
          <div>
            <h2 class="eyebrow">{{ t('admin.permissions.title') }}</h2>
            <p class="mt-1 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
              {{ t('admin.permissions.hint') }}
            </p>
          </div>
          <button type="button" class="btn btn--outline btn--sm" (click)="reload()">
            <app-icon name="activity" size="0.9rem" />
            {{ t('admin.reload') }}
          </button>
        </header>

        <table class="table">
          <thead>
            <tr>
              <th class="min-w-64">{{ t('admin.permissions.permission') }}</th>
              @for (role of data.roles; track role.role_id) {
                <th class="text-center">
                  {{ role.role_name }}
                  <span class="mono block text-[10px]" style="color: var(--color-text-disabled)">
                    {{ t('admin.permissions.priority') }} {{ role.priority }}
                  </span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (permission of data.available_permissions; track permission) {
              <tr>
                <td class="mono text-xs">{{ permission }}</td>
                @for (role of data.roles; track role.role_id) {
                  <td class="text-center p-0">
                    <!-- The checkbox itself stays the usual 16px, but the
                         label wraps the full cell so the actual tap target
                         is the whole square — a bare 16px control in a dense
                         per-role grid is well under any reasonable touch
                         target size. -->
                    <label class="flex items-center justify-center p-3">
                      <input
                        class="checkbox"
                        type="checkbox"
                        [checked]="hasPermission(role, permission)"
                        [disabled]="isSaving(role, permission)"
                        (change)="toggle(role, permission, $event)"
                        [attr.aria-label]="permission + ' for ' + role.role_name"
                      />
                    </label>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </section>

      <section class="card p-5">
        <h2 class="eyebrow mb-1">{{ t('admin.elsewhere.title') }}</h2>
        <p class="mb-3 text-xs" style="color: var(--color-text-secondary)">
          {{ t('admin.elsewhere.hint') }}
        </p>
        <ul class="flex flex-col gap-1" role="list">
          @for (link of settingsLinks; track link.path) {
            <li>
              <a
                class="flex items-center justify-between rounded-2xl px-3 py-2 no-underline"
                style="color: var(--color-text)"
                [routerLink]="link.path"
              >
                <span>
                  {{ t(link.labelKey) }}
                  <span class="block text-xs" style="color: var(--color-text-secondary)">
                    {{ t(link.hintKey) }}
                  </span>
                </span>
                <app-icon name="chevron-right" size="1rem" />
              </a>
            </li>
          }
        </ul>
      </section>

      @if (canManageDiscordSettings()) {
        <section class="card p-5">
          <h2 class="eyebrow mb-1">{{ t('admin.discord.title') }}</h2>
          <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
            {{ t('admin.discord.hint') }}
          </p>

          @if (guildSettingsLoading()) {
            <app-loading />
          } @else {
            <form class="grid gap-4 sm:grid-cols-2" (submit)="saveGuildSettings($event)">
              <label>
                <span class="label">{{ t('admin.discord.eventsChannel') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_events_channel_id"
                  (input)="updateDraftField('discord_events_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.eventsChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.battlesChannel') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_battles_channel_id"
                  (input)="updateDraftField('discord_battles_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.battlesChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.ctaChannel') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_battles_cta_channel_id"
                  (input)="updateDraftField('discord_battles_cta_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.ctaChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.eventRole') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_event_role_id"
                  (input)="updateDraftField('discord_event_role_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.eventRoleHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.auditLogChannel') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_audit_log_channel_id"
                  (input)="updateDraftField('discord_audit_log_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.auditLogChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.transactionSpamChannel') }}</span>
                <input
                  class="input mono"
                  type="text"
                  [placeholder]="t('admin.discord.placeholder')"
                  [value]="guildSettingsDraft().discord_transaction_spam_channel_id"
                  (input)="updateDraftField('discord_transaction_spam_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.transactionSpamChannelHint') }}
                </span>
              </label>

              <div class="sm:col-span-2">
                <button type="submit" class="btn btn--primary" [disabled]="guildSettingsSaving()">
                  {{ t('admin.discord.save') }}
                </button>
              </div>
            </form>
          }
        </section>
      }

      @if (canManageProgression()) {
        <section class="card p-5">
          <h2 class="eyebrow mb-1">{{ t('admin.progression.title') }}</h2>
          <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
            {{ t('admin.progression.hint') }}
          </p>

          @if (progressionLoading()) {
            <app-loading />
          } @else if (progressionSettings(); as settings) {
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
                  <li class="rounded-2xl p-3" style="background: var(--color-cream, #f9f8f6)">
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
          }
        </section>
      }
    } @else {
      <app-error-state
        [message]="t('admin.loadError')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    }
  `,
})
export class Admin {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(true);
  /** Keys of `(role, permission)` pairs currently being saved. */
  private readonly savingKeys = signal<ReadonlySet<string>>(new Set());
  protected readonly matrix = signal<PermissionMatrix | null>(null);

  /** Gates the whole Discord settings section — these are more sensitive than
   *  the page's own Officer+ route guard, so a non-admin never even sees the
   *  form or triggers the fetch that would 403. */
  protected readonly canManageDiscordSettings = computed(() =>
    this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly guildSettingsLoading = signal(true);
  protected readonly guildSettingsSaving = signal(false);
  protected readonly guildSettingsDraft = signal<Record<keyof GuildSettingsView, string>>({
    ...EMPTY_GUILD_SETTINGS_DRAFT,
  });

  protected readonly canManageProgression = computed(() =>
    this.auth.hasPermission('progression.settings.manage'),
  );
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

  protected readonly settingsLinks: SettingsLink[] = [
    { path: '/regears', labelKey: 'admin.link.regear', hintKey: 'admin.link.regearHint' },
    { path: '/comps', labelKey: 'admin.link.comps', hintKey: 'admin.link.compsHint' },
    { path: '/users', labelKey: 'admin.link.users', hintKey: 'admin.link.usersHint' },
    { path: '/audit', labelKey: 'admin.link.audit', hintKey: 'admin.link.auditHint' },
  ];

  protected hasPermission(role: RolePermissionsView, permission: string): boolean {
    return role.permissions.includes(permission);
  }

  private cellKey(role: RolePermissionsView, permission: string): string {
    return `${role.role_id}:${permission}`;
  }

  protected isSaving(role: RolePermissionsView, permission: string): boolean {
    return this.savingKeys().has(this.cellKey(role, permission));
  }

  /**
   * Grants or revokes one permission.
   *
   * The whole set is sent rather than a delta, so the result does not depend
   * on what the server happened to hold when the request arrived.
   *
   * Only the cell being changed disables — the previous version gated the
   * *entire* matrix behind one `saving` flag, so toggling a single checkbox
   * froze every other role and permission until the request returned, which
   * on a slow connection read as the whole page being unresponsive.
   */
  protected async toggle(
    role: RolePermissionsView,
    permission: string,
    event: Event,
  ): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    const next = checked
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission);

    const key = this.cellKey(role, permission);
    this.savingKeys.update((keys) => new Set(keys).add(key));
    try {
      const updated = await firstValueFrom(
        this.api.put<PermissionMatrix>(
          `api/admin/roles/${encodeURIComponent(role.role_id)}/permissions`,
          { permissions: next },
        ),
      );
      this.matrix.set(updated);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      // Re-read rather than trusting the local guess: a rejected change must
      // not leave the grid showing something the server did not accept.
      await this.load();
    } finally {
      this.savingKeys.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }

  protected async reload(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<string>('api/admin/permissions/reload'));
      this.toasts.success(this.t('admin.reloaded'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  constructor() {
    void this.load();
    if (this.canManageDiscordSettings()) {
      void this.loadGuildSettings();
    } else {
      this.guildSettingsLoading.set(false);
    }
    if (this.canManageProgression()) {
      void this.loadProgression();
    } else {
      this.progressionLoading.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.matrix.set(await firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions')));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadGuildSettings(): Promise<void> {
    this.guildSettingsLoading.set(true);
    try {
      const settings = await firstValueFrom(
        this.api.get<GuildSettingsView>('api/admin/settings'),
      );
      this.guildSettingsDraft.set(toDraft(settings));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildSettingsLoading.set(false);
    }
  }

  protected updateDraftField(field: keyof GuildSettingsView, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.guildSettingsDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected async saveGuildSettings(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.guildSettingsSaving.set(true);
    try {
      const draft = this.guildSettingsDraft();
      const body: UpdateGuildSettingsRequest = {
        discord_events_channel_id: draft.discord_events_channel_id.trim(),
        discord_battles_channel_id: draft.discord_battles_channel_id.trim(),
        discord_battles_cta_channel_id: draft.discord_battles_cta_channel_id.trim(),
        discord_audit_log_channel_id: draft.discord_audit_log_channel_id.trim(),
        discord_transaction_spam_channel_id: draft.discord_transaction_spam_channel_id.trim(),
        discord_event_role_id: draft.discord_event_role_id.trim(),
      };
      const updated = await firstValueFrom(
        this.api.put<GuildSettingsView>('api/admin/settings', body),
      );
      this.guildSettingsDraft.set(toDraft(updated));
      this.toasts.success(this.t('admin.discord.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildSettingsSaving.set(false);
    }
  }

  private async loadProgression(): Promise<void> {
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

/** `null` reads oddly in a text input — the form works in empty strings, same
 *  convention the backend's own PUT handler normalizes back to `null`. */
function toDraft(settings: GuildSettingsView): Record<keyof GuildSettingsView, string> {
  return {
    discord_events_channel_id: settings.discord_events_channel_id ?? '',
    discord_battles_channel_id: settings.discord_battles_channel_id ?? '',
    discord_battles_cta_channel_id: settings.discord_battles_cta_channel_id ?? '',
    discord_audit_log_channel_id: settings.discord_audit_log_channel_id ?? '',
    discord_transaction_spam_channel_id: settings.discord_transaction_spam_channel_id ?? '',
    discord_event_role_id: settings.discord_event_role_id ?? '',
  };
}
