import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AutoRoleSettingsView,
  DiscordChannelKind,
  DiscordChannelView,
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
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import {
  channelSelectOptions,
  roleSelectOptions,
  tagSelectOptions,
} from '../../shared/discord/discord-options';

interface DiscordSettingsDraft {
  discord_events_channel_id: string;
  discord_battles_channel_id: string;
  discord_battles_cta_channel_id: string;
  discord_audit_log_channel_id: string;
  discord_transaction_spam_channel_id: string;
  discord_event_role_id: string;
  discord_splits_forum_channel_id: string;
  discord_split_pending_tag_id: string;
  discord_split_completed_tag_id: string;
  discord_split_not_completed_tag_id: string;
  discord_split_lost_tag_id: string;
  discord_event_voice_category_id: string;
  default_split_fee: string;
}

const EMPTY_GUILD_SETTINGS_DRAFT: DiscordSettingsDraft = {
  discord_events_channel_id: '',
  discord_battles_channel_id: '',
  discord_battles_cta_channel_id: '',
  discord_audit_log_channel_id: '',
  discord_transaction_spam_channel_id: '',
  discord_event_role_id: '',
  discord_splits_forum_channel_id: '',
  discord_split_pending_tag_id: '',
  discord_split_completed_tag_id: '',
  discord_split_not_completed_tag_id: '',
  discord_split_lost_tag_id: '',
  discord_event_voice_category_id: '',
  default_split_fee: '20',
};

const SPLIT_TAG_FIELDS = [
  'discord_split_pending_tag_id',
  'discord_split_completed_tag_id',
  'discord_split_not_completed_tag_id',
  'discord_split_lost_tag_id',
] as const;

/**
 * Discord channel IDs and the automatic member role.
 */
@Component({
  selector: 'app-admin-discord',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader, PageStack, SearchableSelect],
  template: `
    <app-page-header [title]="t('admin.discord.title')" [subtitle]="t('admin.discord.hint')" />

    <app-page-stack>
    @if (pageLoading()) {
      <app-loading />
    } @else {
      <form class="flex flex-col gap-[var(--page-gap,1.5rem)]" (submit)="save($event)">
        @if (canManageDiscordSettings()) {
          <section class="card p-5">
            <fieldset class="grid gap-4 sm:grid-cols-2">
              <legend class="eyebrow mb-1">{{ t('admin.discord.groupAnnouncements') }}</legend>
              <label>
                <span class="label">{{ t('admin.discord.eventsChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_events_channel_id)"
                  [value]="guildSettingsDraft().discord_events_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.eventsChannel')"
                  (valueChange)="setDraftValue('discord_events_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.eventsChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.battlesChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_battles_channel_id)"
                  [value]="guildSettingsDraft().discord_battles_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.battlesChannel')"
                  (valueChange)="setDraftValue('discord_battles_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.battlesChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.ctaChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_battles_cta_channel_id)"
                  [value]="guildSettingsDraft().discord_battles_cta_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.ctaChannel')"
                  (valueChange)="setDraftValue('discord_battles_cta_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.ctaChannelHint') }}
                </span>
              </label>
            </fieldset>
          </section>

          <section class="card p-5">
            <fieldset class="grid gap-4 sm:grid-cols-2">
              <legend class="eyebrow mb-1">{{ t('admin.discord.groupSplits') }}</legend>
              <label class="sm:col-span-2">
                <span class="label">{{ t('admin.discord.splitsForumChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['forum'], guildSettingsDraft().discord_splits_forum_channel_id)"
                  [value]="guildSettingsDraft().discord_splits_forum_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.splitsForumChannel')"
                  (valueChange)="setDraftValue('discord_splits_forum_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.splitsForumChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.splitPendingTag') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="tagOptions(guildSettingsDraft().discord_split_pending_tag_id)"
                  [value]="guildSettingsDraft().discord_split_pending_tag_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [disabled]="!guildSettingsDraft().discord_splits_forum_channel_id"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.splitPendingTag')"
                  (valueChange)="setDraftValue('discord_split_pending_tag_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.splitCompletedTag') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="tagOptions(guildSettingsDraft().discord_split_completed_tag_id)"
                  [value]="guildSettingsDraft().discord_split_completed_tag_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [disabled]="!guildSettingsDraft().discord_splits_forum_channel_id"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.splitCompletedTag')"
                  (valueChange)="setDraftValue('discord_split_completed_tag_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.splitNotCompletedTag') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="tagOptions(guildSettingsDraft().discord_split_not_completed_tag_id)"
                  [value]="guildSettingsDraft().discord_split_not_completed_tag_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [disabled]="!guildSettingsDraft().discord_splits_forum_channel_id"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.splitNotCompletedTag')"
                  (valueChange)="setDraftValue('discord_split_not_completed_tag_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.splitLostTag') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="tagOptions(guildSettingsDraft().discord_split_lost_tag_id)"
                  [value]="guildSettingsDraft().discord_split_lost_tag_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [disabled]="!guildSettingsDraft().discord_splits_forum_channel_id"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.splitLostTag')"
                  (valueChange)="setDraftValue('discord_split_lost_tag_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.splitTagHint') }}</span>
              </label>
            </fieldset>
          </section>

          <section class="card p-5">
            <fieldset>
              <legend class="eyebrow mb-1">{{ t('admin.discord.groupVoice') }}</legend>
              <label>
                <span class="label">{{ t('admin.discord.eventVoiceCategory') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['category'], guildSettingsDraft().discord_event_voice_category_id)"
                  [value]="guildSettingsDraft().discord_event_voice_category_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.eventVoiceCategory')"
                  (valueChange)="setDraftValue('discord_event_voice_category_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.eventVoiceCategoryHint') }}
                </span>
              </label>
            </fieldset>
          </section>

          <section class="card p-5">
            <fieldset>
              <legend class="eyebrow mb-1">{{ t('admin.discord.groupPings') }}</legend>
              <label>
                <span class="label">{{ t('admin.discord.eventRole') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="roleOptions(guildSettingsDraft().discord_event_role_id)"
                  [value]="guildSettingsDraft().discord_event_role_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.eventRole')"
                  (valueChange)="setDraftValue('discord_event_role_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.eventRoleHint') }}
                </span>
              </label>
            </fieldset>
          </section>

          <section class="card p-5">
            <fieldset class="grid gap-4 sm:grid-cols-2">
              <legend class="eyebrow mb-1">{{ t('admin.discord.groupLogs') }}</legend>
              <label>
                <span class="label">{{ t('admin.discord.auditLogChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_audit_log_channel_id)"
                  [value]="guildSettingsDraft().discord_audit_log_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.auditLogChannel')"
                  (valueChange)="setDraftValue('discord_audit_log_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.auditLogChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.transactionSpamChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_transaction_spam_channel_id)"
                  [value]="guildSettingsDraft().discord_transaction_spam_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.transactionSpamChannel')"
                  (valueChange)="setDraftValue('discord_transaction_spam_channel_id', $event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.discord.transactionSpamChannelHint') }}
                </span>
              </label>
            </fieldset>
          </section>

          <section class="card p-5">
            <fieldset>
              <legend class="eyebrow mb-1">{{ t('admin.split.defaultFee') }}</legend>
              <label>
                <span class="label">{{ t('admin.split.defaultFee') }}</span>
                <div class="mt-1 flex items-center gap-2">
                  <input
                    class="input mono"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    inputmode="decimal"
                    [value]="guildSettingsDraft().default_split_fee"
                    [attr.aria-describedby]="'admin-split-default-fee-hint'"
                    (input)="updateDraftField('default_split_fee', $event)"
                  />
                  <span class="font-mono text-xs">%</span>
                </div>
                <span id="admin-split-default-fee-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.split.defaultFeeHint') }}
                </span>
              </label>
            </fieldset>
          </section>
        }

        @if (canManageAutoRole()) {
          <section class="card p-5">
            <fieldset>
              <legend class="eyebrow mb-1">{{ t('admin.autorole.title') }}</legend>
              <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.autorole.hint') }}
              </p>
              <label>
                <span class="label">{{ t('admin.autorole.role') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="roleOptions(autoRoleDraft())"
                  [value]="autoRoleDraft()"
                  [emptyLabel]="t('admin.autorole.disabled')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.autorole.role')"
                  (valueChange)="autoRoleDraft.set($event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.autorole.roleHint') }}
                </span>
              </label>
            </fieldset>
          </section>
        }

        @if (canManageDiscordSettings() || canManageAutoRole()) {
          <div>
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ t('admin.discord.save') }}
            </button>
          </div>
        }
      </form>
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
  protected readonly canManageAutoRole = computed(() => this.auth.hasPermission('autorole.manage'));
  protected readonly guildSettingsLoading = signal(true);
  protected readonly autoRoleLoading = signal(true);
  protected readonly catalogLoading = signal(false);
  protected readonly saving = signal(false);
  protected readonly guildSettingsDraft = signal<DiscordSettingsDraft>({
    ...EMPTY_GUILD_SETTINGS_DRAFT,
  });
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);
  protected readonly autoRoleDraft = signal('');
  protected readonly pageLoading = computed(
    () =>
      (this.canManageDiscordSettings() && this.guildSettingsLoading()) ||
      (this.canManageAutoRole() && this.autoRoleLoading()),
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    if (this.canManageDiscordSettings()) {
      void this.loadGuildSettings();
    } else {
      this.guildSettingsLoading.set(false);
    }
    if (this.canManageDiscordSettings() || this.canManageAutoRole()) {
      void this.loadCatalog();
    }
    if (this.canManageAutoRole()) {
      void this.loadAutoRole();
    } else {
      this.autoRoleLoading.set(false);
    }
  }

  protected channelOptions(kinds: DiscordChannelKind[], selectedId: string) {
    return channelSelectOptions(this.discordChannels(), kinds, selectedId);
  }

  protected roleOptions(selectedId: string) {
    return roleSelectOptions(this.discordRoles(), selectedId);
  }

  protected tagOptions(selectedId: string) {
    return tagSelectOptions(
      this.discordChannels(),
      this.guildSettingsDraft().discord_splits_forum_channel_id,
      selectedId,
    );
  }

  protected setDraftValue(field: keyof DiscordSettingsDraft, value: string): void {
    this.guildSettingsDraft.update((draft) => ({ ...draft, [field]: value }));
    if (field === 'discord_splits_forum_channel_id') {
      this.clearInvalidSplitTags(value);
    }
  }

  private clearInvalidSplitTags(forumId: string): void {
    const valid = new Set(
      this.discordChannels()
        .find((channel) => channel.id === forumId)
        ?.available_tags.map((tag) => tag.id) ?? [],
    );
    this.guildSettingsDraft.update((draft) => {
      const next = { ...draft };
      for (const field of SPLIT_TAG_FIELDS) {
        if (next[field] && !valid.has(next[field])) {
          next[field] = '';
        }
      }
      return next;
    });
  }

  private async loadCatalog(): Promise<void> {
    this.catalogLoading.set(true);
    try {
      const [roles, channels] = await Promise.all([
        firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/discord/roles')).catch(() =>
          firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/autorole/roles')),
        ),
        this.canManageDiscordSettings()
          ? firstValueFrom(this.api.get<DiscordChannelView[]>('api/admin/discord/channels'))
          : Promise.resolve([] as DiscordChannelView[]),
      ]);
      this.discordRoles.set(roles);
      this.discordChannels.set(channels);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.catalogLoading.set(false);
    }
  }

  private async loadGuildSettings(): Promise<void> {
    this.guildSettingsLoading.set(true);
    try {
      const settings = await firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings'));
      this.guildSettingsDraft.set(toDraft(settings));
      if (this.autoRoleLoading() && settings.discord_auto_role_id) {
        this.autoRoleDraft.set(settings.discord_auto_role_id);
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildSettingsLoading.set(false);
    }
  }

  protected updateDraftField(field: keyof DiscordSettingsDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.guildSettingsDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected async save(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.saving.set(true);
    try {
      const tasks: Promise<void>[] = [];
      if (this.canManageDiscordSettings()) {
        tasks.push(this.persistGuildSettings());
      }
      if (this.canManageAutoRole()) {
        tasks.push(this.persistAutoRole());
      }
      await Promise.all(tasks);
      this.toasts.success(
        this.canManageDiscordSettings() ? this.t('admin.discord.saved') : this.t('admin.autorole.saved'),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      if (this.canManageAutoRole()) {
        await this.loadAutoRole();
      }
    } finally {
      this.saving.set(false);
    }
  }

  private async persistGuildSettings(): Promise<void> {
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
      default_split_fee: Number(draft.default_split_fee),
      ...(this.canManageAutoRole()
        ? { discord_auto_role_id: this.autoRoleDraft() }
        : {}),
    };
    const updated = await firstValueFrom(
      this.api.put<GuildSettingsView>('api/admin/settings', body),
    );
    this.guildSettingsDraft.set(toDraft(updated));
  }

  private async loadAutoRole(): Promise<void> {
    this.autoRoleLoading.set(true);
    try {
      const settings = await firstValueFrom(
        this.api.get<AutoRoleSettingsView>('api/admin/autorole'),
      );
      this.autoRoleDraft.set(settings.discord_auto_role_id ?? '');
      if (this.discordRoles().length === 0) {
        try {
          const roles = await firstValueFrom(
            this.api.get<DiscordRoleView[]>('api/admin/autorole/roles'),
          );
          this.discordRoles.set(roles);
        } catch {
          // Catalog load already reports Discord role failures.
        }
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.autoRoleLoading.set(false);
    }
  }

  private async persistAutoRole(): Promise<void> {
    const body: UpdateAutoRoleRequest = {
      discord_auto_role_id: this.autoRoleDraft(),
    };
    const updated = await firstValueFrom(
      this.api.put<AutoRoleSettingsView>('api/admin/autorole', body),
    );
    this.autoRoleDraft.set(updated.discord_auto_role_id ?? '');
  }
}

function toDraft(settings: GuildSettingsView): DiscordSettingsDraft {
  return {
    discord_events_channel_id: settings.discord_events_channel_id ?? '',
    discord_battles_channel_id: settings.discord_battles_channel_id ?? '',
    discord_battles_cta_channel_id: settings.discord_battles_cta_channel_id ?? '',
    discord_audit_log_channel_id: settings.discord_audit_log_channel_id ?? '',
    discord_transaction_spam_channel_id: settings.discord_transaction_spam_channel_id ?? '',
    discord_event_role_id: settings.discord_event_role_id ?? '',
    discord_splits_forum_channel_id: settings.discord_splits_forum_channel_id ?? '',
    discord_split_pending_tag_id: settings.discord_split_pending_tag_id ?? '',
    discord_split_completed_tag_id: settings.discord_split_completed_tag_id ?? '',
    discord_split_not_completed_tag_id: settings.discord_split_not_completed_tag_id ?? '',
    discord_split_lost_tag_id: settings.discord_split_lost_tag_id ?? '',
    discord_event_voice_category_id: settings.discord_event_voice_category_id ?? '',
    default_split_fee: String(settings.default_split_fee ?? 20),
  };
}
