import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AutoRoleSettingsView,
  DiscordRoleView,
  GuildSettingsView,
  UpdateAutoRoleRequest,
  UpdateGuildSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const EMPTY_GUILD_SETTINGS_DRAFT: Record<keyof GuildSettingsView, string> = {
  discord_events_channel_id: '',
  discord_battles_channel_id: '',
  discord_battles_cta_channel_id: '',
  discord_audit_log_channel_id: '',
  discord_transaction_spam_channel_id: '',
  discord_event_role_id: '',
  discord_auto_role_id: '',
  discord_splits_forum_channel_id: '',
  discord_split_pending_tag_id: '',
  discord_split_completed_tag_id: '',
  discord_split_not_completed_tag_id: '',
  discord_split_lost_tag_id: '',
  discord_event_voice_category_id: '',
};

/**
 * Discord channel IDs and the automatic member role.
 */
@Component({
  selector: 'app-admin-discord',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader, PageStack],
  template: `
    <app-page-header [title]="t('admin.discord.title')" [subtitle]="t('admin.discord.hint')" />

    <app-page-stack>
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
              <span class="label">{{ t('admin.discord.splitsForumChannel') }}</span>
              <input
                class="input mono"
                type="text"
                [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_splits_forum_channel_id"
                (input)="updateDraftField('discord_splits_forum_channel_id', $event)"
              />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.discord.splitsForumChannelHint') }}
              </span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.splitPendingTag') }}</span>
              <input class="input mono" type="text" [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_split_pending_tag_id"
                (input)="updateDraftField('discord_split_pending_tag_id', $event)" />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.splitCompletedTag') }}</span>
              <input class="input mono" type="text" [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_split_completed_tag_id"
                (input)="updateDraftField('discord_split_completed_tag_id', $event)" />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.splitNotCompletedTag') }}</span>
              <input class="input mono" type="text" [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_split_not_completed_tag_id"
                (input)="updateDraftField('discord_split_not_completed_tag_id', $event)" />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.splitLostTag') }}</span>
              <input class="input mono" type="text" [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_split_lost_tag_id"
                (input)="updateDraftField('discord_split_lost_tag_id', $event)" />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.eventVoiceCategory') }}</span>
              <input
                class="input mono"
                type="text"
                name="discord-event-voice-category-id"
                inputmode="numeric"
                [placeholder]="t('admin.discord.placeholder')"
                [value]="guildSettingsDraft().discord_event_voice_category_id"
                [attr.aria-describedby]="'discord-event-voice-category-hint'"
                (input)="updateDraftField('discord_event_voice_category_id', $event)"
              />
              <span id="discord-event-voice-category-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.discord.eventVoiceCategoryHint') }}
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

    @if (canManageAutoRole()) {
      <section class="card p-5">
        <h2 class="eyebrow mb-1">{{ t('admin.autorole.title') }}</h2>
        <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
          {{ t('admin.autorole.hint') }}
        </p>

        @if (autoRoleLoading()) {
          <app-loading />
        } @else {
          <form class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" (submit)="saveAutoRole($event)">
            <label>
              <span class="label">{{ t('admin.autorole.role') }}</span>
              <select
                class="select mt-1 w-full"
                [value]="autoRoleDraft()"
                (change)="updateAutoRoleDraft($event)"
                [attr.aria-label]="t('admin.autorole.role')"
              >
                <option value="">{{ t('admin.autorole.disabled') }}</option>
                @for (role of discordRoles(); track role.id) {
                  <option [value]="role.id">
                    {{ role.name }} ({{ role.id }})
                  </option>
                }
              </select>
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.autorole.roleHint') }}
              </span>
            </label>
            <button type="submit" class="btn btn--primary" [disabled]="autoRoleSaving()">
              {{ t('admin.autorole.save') }}
            </button>
          </form>
        }
      </section>
    }
    </app-page-stack>
  `,
})
export class AdminDiscord {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly canManageDiscordSettings = computed(() =>
    this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly guildSettingsLoading = signal(true);
  protected readonly guildSettingsSaving = signal(false);
  protected readonly guildSettingsDraft = signal<Record<keyof GuildSettingsView, string>>({
    ...EMPTY_GUILD_SETTINGS_DRAFT,
  });

  protected readonly canManageAutoRole = computed(() => this.auth.hasPermission('autorole.manage'));
  protected readonly autoRoleLoading = signal(true);
  protected readonly autoRoleSaving = signal(false);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly autoRoleDraft = signal('');

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    if (this.canManageDiscordSettings()) {
      void this.loadGuildSettings();
    } else {
      this.guildSettingsLoading.set(false);
    }
    if (this.canManageAutoRole()) {
      void this.loadAutoRole();
    } else {
      this.autoRoleLoading.set(false);
    }
  }

  private async loadGuildSettings(): Promise<void> {
    this.guildSettingsLoading.set(true);
    try {
      const settings = await firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings'));
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
        discord_splits_forum_channel_id: draft.discord_splits_forum_channel_id.trim(),
        discord_split_pending_tag_id: draft.discord_split_pending_tag_id.trim(),
        discord_split_completed_tag_id: draft.discord_split_completed_tag_id.trim(),
        discord_split_not_completed_tag_id: draft.discord_split_not_completed_tag_id.trim(),
        discord_split_lost_tag_id: draft.discord_split_lost_tag_id.trim(),
        discord_event_voice_category_id: draft.discord_event_voice_category_id.trim(),
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

  private async loadAutoRole(): Promise<void> {
    this.autoRoleLoading.set(true);
    try {
      const [roles, settings] = await Promise.all([
        firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/autorole/roles')),
        firstValueFrom(this.api.get<AutoRoleSettingsView>('api/admin/autorole')),
      ]);
      this.discordRoles.set(roles);
      const savedRoleId = settings.discord_auto_role_id ?? '';
      this.autoRoleDraft.set(savedRoleId);

      // Keep a saved selection visible even if the Discord role list is temporarily
      // incomplete (for example while the bot cache/token is being refreshed).
      if (savedRoleId && !roles.some((role) => role.id === savedRoleId)) {
        this.discordRoles.update((current) => [
          ...current,
          { id: savedRoleId, name: `Linked role (${savedRoleId})`, position: 0, managed: false },
        ]);
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.autoRoleLoading.set(false);
    }
  }

  protected updateAutoRoleDraft(event: Event): void {
    this.autoRoleDraft.set((event.target as HTMLSelectElement).value);
  }

  protected async saveAutoRole(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.autoRoleSaving.set(true);
    try {
      const body: UpdateAutoRoleRequest = {
        discord_auto_role_id: this.autoRoleDraft(),
      };
      const updated = await firstValueFrom(
        this.api.put<AutoRoleSettingsView>('api/admin/autorole', body),
      );
      this.autoRoleDraft.set(updated.discord_auto_role_id ?? '');
      this.toasts.success(this.t('admin.autorole.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      await this.loadAutoRole();
    } finally {
      this.autoRoleSaving.set(false);
    }
  }
}

function toDraft(settings: GuildSettingsView): Record<keyof GuildSettingsView, string> {
  return {
    discord_events_channel_id: settings.discord_events_channel_id ?? '',
    discord_battles_channel_id: settings.discord_battles_channel_id ?? '',
    discord_battles_cta_channel_id: settings.discord_battles_cta_channel_id ?? '',
    discord_audit_log_channel_id: settings.discord_audit_log_channel_id ?? '',
    discord_transaction_spam_channel_id: settings.discord_transaction_spam_channel_id ?? '',
    discord_event_role_id: settings.discord_event_role_id ?? '',
    discord_auto_role_id: settings.discord_auto_role_id ?? '',
    discord_splits_forum_channel_id: settings.discord_splits_forum_channel_id ?? '',
    discord_split_pending_tag_id: settings.discord_split_pending_tag_id ?? '',
    discord_split_completed_tag_id: settings.discord_split_completed_tag_id ?? '',
    discord_split_not_completed_tag_id: settings.discord_split_not_completed_tag_id ?? '',
    discord_split_lost_tag_id: settings.discord_split_lost_tag_id ?? '',
    discord_event_voice_category_id: settings.discord_event_voice_category_id ?? '',
  };
}
