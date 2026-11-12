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
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { Select } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import {
  channelSelectOptions,
  roleSelectOptions,
  tagSelectOptions,
} from '../../shared/discord/discord-options';

interface DiscordSettingsDraft {
  discord_events_channel_id: string;
  discord_battles_channel_id: string;
  discord_battles_cta_channel_id: string;
  discord_flash_mass_channel_id: string;
  discord_events_forum_channel_id: string;
  discord_event_delivery: 'calendar' | 'message' | 'forum';
  discord_event_scheduled_tag_id: string;
  discord_event_live_tag_id: string;
  discord_event_cta_tag_id: string;
  discord_event_flash_tag_id: string;
  discord_audit_log_channel_id: string;
  discord_transaction_spam_channel_id: string;
  discord_splits_forum_channel_id: string;
  discord_split_pending_tag_id: string;
  discord_split_completed_tag_id: string;
  discord_split_not_completed_tag_id: string;
  discord_split_lost_tag_id: string;
  discord_event_voice_category_id: string;
  discord_event_timezone: string;
  default_split_fee: string;
}

/** Whether the bot could read the server's channels and roles on the last attempt. */
type ConnectionState = 'checking' | 'connected' | 'disconnected';

const EMPTY_GUILD_SETTINGS_DRAFT: DiscordSettingsDraft = {
  discord_events_channel_id: '',
  discord_battles_channel_id: '',
  discord_battles_cta_channel_id: '',
  discord_flash_mass_channel_id: '',
  discord_events_forum_channel_id: '',
  discord_event_delivery: 'calendar',
  discord_event_scheduled_tag_id: '',
  discord_event_live_tag_id: '',
  discord_event_cta_tag_id: '',
  discord_event_flash_tag_id: '',
  discord_audit_log_channel_id: '',
  discord_transaction_spam_channel_id: '',
  discord_splits_forum_channel_id: '',
  discord_split_pending_tag_id: '',
  discord_split_completed_tag_id: '',
  discord_split_not_completed_tag_id: '',
  discord_split_lost_tag_id: '',
  discord_event_voice_category_id: '',
  discord_event_timezone: 'Europe/Rome',
  default_split_fee: '20',
};

const EVENT_TAG_FIELDS = [
  { key: 'discord_event_scheduled_tag_id', label: 'events.status.scheduled' },
  { key: 'discord_event_live_tag_id', label: 'events.status.live' },
  { key: 'discord_event_cta_tag_id', label: 'events.call_to_arms' },
  { key: 'discord_event_flash_tag_id', label: 'events.flashMass' },
] as const;

const SPLIT_TAG_FIELDS = [
  'discord_split_pending_tag_id',
  'discord_split_completed_tag_id',
  'discord_split_not_completed_tag_id',
  'discord_split_lost_tag_id',
] as const;

/**
 * Discord integration settings: connection state, the channels the bot posts to,
 * the split forum, notification copies and the roles it assigns. One form, one save.
 */
@Component({
  selector: 'app-admin-discord',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorState, Loading, PageHeader, PageStack, SearchableSelect, Select, StatusChip],
  styles: `
    .discord-save-bar {
      position: sticky;
      bottom: 0;
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--color-surface);
      border-top: 1px solid var(--color-border);
    }
    .discord-field-grid {
      display: grid;
      gap: 1rem;
    }
    @media (min-width: 40rem) {
      .discord-field-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .discord-field-wide {
        grid-column: 1 / -1;
      }
    }
  `,
  template: `
    <app-page-header [title]="t('admin.discord.title')" [subtitle]="t('admin.discord.hint')" />

    <app-page-stack>
    @if (pageLoading()) {
      <app-loading variant="detail" />
    } @else if (loadError()) {
      <app-error-state [message]="t('admin.discord.loadFailed')" [retryLabel]="t('common.retry')" (retry)="reload()" />
    } @else {
      <form class="flex flex-col gap-[var(--page-gap,1.5rem)]" (submit)="save($event)">
        @if (canManageDiscordSettings() || canManageAutoRole()) {
          <section class="card p-5" aria-labelledby="discord-connection-title">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="grid max-w-2xl gap-1">
                <h2 id="discord-connection-title" class="section-title">{{ t('admin.discord.sectionConnection') }}</h2>
                <p class="hint">{{ t('admin.discord.connectionHint') }}</p>
              </div>
              <app-status-chip
                [value]="connection()"
                [toneOverride]="connectionTone()"
                [label]="connectionLabel()"
              />
            </div>
            @if (connection() === 'disconnected') {
              <div class="mt-4 flex flex-wrap items-center gap-3">
                <p class="hint max-w-2xl" role="status">{{ t('admin.discord.connectionFailed') }}</p>
                <button type="button" class="btn btn--outline btn--sm" [disabled]="catalogLoading()" (click)="retryConnection()">
                  {{ t('common.retry') }}
                </button>
              </div>
            }
          </section>
        }

        @if (canManageDiscordSettings()) {
          <section class="card p-5" aria-labelledby="discord-events-title">
            <h2 id="discord-events-title" class="section-title">{{ t('admin.discord.sectionEvents') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">{{ t('admin.discord.sectionEventsHint') }}</p>
            <div class="discord-field-grid">
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
                <span class="hint mt-1 block">{{ t('admin.discord.eventsChannelHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.battlesChannelHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.flashMassChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], guildSettingsDraft().discord_flash_mass_channel_id)"
                  [value]="guildSettingsDraft().discord_flash_mass_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.discord.flashMassChannel')"
                  (valueChange)="setDraftValue('discord_flash_mass_channel_id', $event)"
                />
                <span class="hint mt-1 block">{{ t('admin.discord.flashMassChannelHint') }}</span>
              </label>
              <label class="discord-field-wide">
                <span class="label">{{ t('events.discordDelivery.label') }}</span>
                <app-select class="mt-1" [options]="eventDeliveryOptions()"
                  [value]="guildSettingsDraft().discord_event_delivery"
                  [ariaLabel]="t('events.discordDelivery.label')"
                  (valueChange)="setEventDelivery($event)" />
              </label>
              <label class="discord-field-wide">
                <span class="label">{{ t('events.discordDelivery.forum') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['forum'], guildSettingsDraft().discord_events_forum_channel_id)"
                  [value]="guildSettingsDraft().discord_events_forum_channel_id"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('events.discordDelivery.forum')"
                  (valueChange)="setDraftValue('discord_events_forum_channel_id', $event)"
                />
              </label>
              @for (tagField of eventTagFields; track tagField.key) {
                <label>
                  <span class="label">{{ t(tagField.label) }}</span>
                  <app-searchable-select
                    class="mt-1 block"
                    [options]="tagOptions(guildSettingsDraft()[tagField.key])"
                    [value]="guildSettingsDraft()[tagField.key]"
                    [emptyLabel]="t('admin.discord.placeholder')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [loading]="catalogLoading()"
                    [ariaLabel]="t(tagField.label)"
                    (valueChange)="setDraftValue(tagField.key, $event)"
                  />
                </label>
              }
              <label class="discord-field-wide">
                <span class="label">{{ t('admin.discord.eventTimezone') }}</span>
                <input
                  class="input mt-1"
                  type="text"
                  maxlength="64"
                  autocomplete="off"
                  [value]="guildSettingsDraft().discord_event_timezone"
                  (input)="updateDraftField('discord_event_timezone', $event)"
                  [attr.aria-label]="t('admin.discord.eventTimezone')"
                />
                <span class="hint mt-1 block">{{ t('admin.discord.eventTimezoneHint') }}</span>
              </label>
            </div>
          </section>

          <section class="card p-5" aria-labelledby="discord-voice-title">
            <h2 id="discord-voice-title" class="section-title">{{ t('admin.discord.sectionVoice') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">{{ t('admin.discord.sectionVoiceHint') }}</p>
            <label class="block max-w-xl">
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
              <span class="hint mt-1 block">{{ t('admin.discord.eventVoiceCategoryHint') }}</span>
            </label>
          </section>

          <section class="card p-5" aria-labelledby="discord-splits-title">
            <h2 id="discord-splits-title" class="section-title">{{ t('admin.discord.sectionSplits') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">{{ t('admin.discord.sectionSplitsHint') }}</p>
            <div class="discord-field-grid">
              <label class="discord-field-wide">
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
                <span class="hint mt-1 block">{{ t('admin.discord.splitsForumChannelHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.splitTagHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.splitTagHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.splitTagHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.splitTagHint') }}</span>
              </label>
              <label class="discord-field-wide">
                <span class="label">{{ t('admin.split.defaultFee') }}</span>
                <div class="mt-1 flex max-w-xs items-center gap-2">
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
                <span id="admin-split-default-fee-hint" class="hint mt-1 block">
                  {{ t('admin.split.defaultFeeHint') }}
                </span>
              </label>
            </div>
          </section>

          <section class="card p-5" aria-labelledby="discord-notifications-title">
            <h2 id="discord-notifications-title" class="section-title">{{ t('admin.discord.sectionNotifications') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">{{ t('admin.discord.sectionNotificationsHint') }}</p>
            <div class="discord-field-grid">
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
                <span class="hint mt-1 block">{{ t('admin.discord.auditLogChannelHint') }}</span>
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
                <span class="hint mt-1 block">{{ t('admin.discord.transactionSpamChannelHint') }}</span>
              </label>
            </div>
          </section>
        }

        @if (canManageDiscordSettings() || canManageAutoRole()) {
          <section class="card p-5" aria-labelledby="discord-roles-title">
            <h2 id="discord-roles-title" class="section-title">{{ t('admin.discord.sectionRoles') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">{{ t('admin.discord.sectionRolesHint') }}</p>
            <div class="discord-field-grid">
              @if (canManageAutoRole()) {
                <label>
                  <span class="label">{{ t('admin.autorole.title') }}</span>
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
                  <span class="hint mt-1 block">{{ t('admin.autorole.hint') }}</span>
                </label>
              }
              @if (canManageDiscordSettings()) {
                <label>
                  <span class="label">{{ t('admin.allianceRole.role') }}</span>
                  <app-searchable-select
                    class="mt-1 block"
                    [options]="roleOptions(allianceRoleDraft())"
                    [value]="allianceRoleDraft()"
                    [emptyLabel]="t('admin.allianceRole.disabled')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [loading]="catalogLoading()"
                    [ariaLabel]="t('admin.allianceRole.role')"
                    (valueChange)="allianceRoleDraft.set($event)"
                  />
                  <span class="hint mt-1 block">{{ t(isAlliance() ? 'admin.allianceRole.hintAlliance' : 'admin.allianceRole.hintGuild') }}</span>
                </label>
              }
            </div>
          </section>

          <div class="discord-save-bar">
            <p class="hint">{{ t('admin.discord.saveHint') }}</p>
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
  protected readonly connection = signal<ConnectionState>('checking');
  /** Set when settings the form is built from could not be read; the form is hidden so a save cannot overwrite them with blanks. */
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly guildSettingsDraft = signal<DiscordSettingsDraft>({
    ...EMPTY_GUILD_SETTINGS_DRAFT,
  });
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);
  protected readonly autoRoleDraft = signal('');
  protected readonly allianceRoleDraft = signal('');
  protected readonly isAlliance = computed(
    () => this.auth.profile()?.tenant_kind === 'alliance',
  );
  protected readonly pageLoading = computed(
    () =>
      (this.canManageDiscordSettings() && this.guildSettingsLoading()) ||
      (this.canManageAutoRole() && this.autoRoleLoading()),
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly connectionTone = computed(() => {
    switch (this.connection()) {
      case 'connected':
        return 'success' as const;
      case 'disconnected':
        return 'warning' as const;
      default:
        return 'neutral' as const;
    }
  });

  protected readonly connectionLabel = computed(() => {
    switch (this.connection()) {
      case 'connected':
        return this.t('admin.discord.connected');
      case 'disconnected':
        return this.t('admin.discord.notConnected');
      default:
        return this.t('admin.discord.checking');
    }
  });

  constructor() {
    void this.loadAll();
  }

  protected reload(): void {
    void this.loadAll();
  }

  protected retryConnection(): void {
    void this.loadCatalog();
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

  protected readonly eventTagFields = EVENT_TAG_FIELDS;
  protected readonly eventDeliveryOptions = computed(() => [
    { value: 'calendar', label: this.t('events.discordDelivery.calendar') },
    { value: 'message', label: this.t('events.discordDelivery.message') },
    { value: 'forum', label: this.t('events.discordDelivery.forum') },
  ]);

  protected setEventDelivery(value: string): void {
    if (value !== 'calendar' && value !== 'message' && value !== 'forum') return;
    this.guildSettingsDraft.update((draft) => ({ ...draft, discord_event_delivery: value }));
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

  private async loadAll(): Promise<void> {
    this.loadError.set(false);
    this.guildSettingsLoading.set(this.canManageDiscordSettings());
    this.autoRoleLoading.set(this.canManageAutoRole());
    const tasks: Promise<void>[] = [];
    if (this.canManageDiscordSettings() || this.canManageAutoRole()) {
      tasks.push(this.loadCatalog());
    }
    if (this.canManageDiscordSettings()) {
      tasks.push(this.loadGuildSettings());
    }
    if (this.canManageAutoRole()) {
      tasks.push(this.loadAutoRole());
    }
    await Promise.all(tasks);
  }

  private async loadCatalog(): Promise<void> {
    this.catalogLoading.set(true);
    this.connection.set('checking');
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
      this.connection.set('connected');
    } catch {
      // The status row explains the failure and offers a retry; the raw error stays out of the UI.
      this.connection.set('disconnected');
    } finally {
      this.catalogLoading.set(false);
    }
  }

  private async loadGuildSettings(): Promise<void> {
    this.guildSettingsLoading.set(true);
    try {
      const settings = await firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings'));
      this.guildSettingsDraft.set(toDraft(settings));
      this.allianceRoleDraft.set(settings.discord_alliance_role_id ?? '');
      if (this.autoRoleLoading() && settings.discord_auto_role_id) {
        this.autoRoleDraft.set(settings.discord_auto_role_id);
      }
    } catch {
      this.loadError.set(true);
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
    } catch {
      this.toasts.error(this.t('admin.discord.saveFailed'));
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
      discord_flash_mass_channel_id: draft.discord_flash_mass_channel_id.trim(),
      discord_events_forum_channel_id: draft.discord_events_forum_channel_id.trim(),
      discord_event_delivery: draft.discord_event_delivery,
      discord_event_scheduled_tag_id: draft.discord_event_scheduled_tag_id.trim(),
      discord_event_live_tag_id: draft.discord_event_live_tag_id.trim(),
      discord_event_cta_tag_id: draft.discord_event_cta_tag_id.trim(),
      discord_event_flash_tag_id: draft.discord_event_flash_tag_id.trim(),
      discord_event_timezone: draft.discord_event_timezone.trim(),
      discord_audit_log_channel_id: draft.discord_audit_log_channel_id.trim(),
      discord_transaction_spam_channel_id: draft.discord_transaction_spam_channel_id.trim(),
      discord_splits_forum_channel_id: draft.discord_splits_forum_channel_id.trim(),
      discord_split_pending_tag_id: draft.discord_split_pending_tag_id.trim(),
      discord_split_completed_tag_id: draft.discord_split_completed_tag_id.trim(),
      discord_split_not_completed_tag_id: draft.discord_split_not_completed_tag_id.trim(),
      discord_split_lost_tag_id: draft.discord_split_lost_tag_id.trim(),
      discord_event_voice_category_id: draft.discord_event_voice_category_id.trim(),
      default_split_fee: Number(draft.default_split_fee),
      discord_alliance_role_id: this.allianceRoleDraft(),
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
    } catch {
      this.loadError.set(true);
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
    discord_flash_mass_channel_id: settings.discord_flash_mass_channel_id ?? '',
    discord_events_forum_channel_id: settings.discord_events_forum_channel_id ?? '',
    discord_event_delivery: settings.discord_event_delivery ?? 'calendar',
    discord_event_scheduled_tag_id: settings.discord_event_scheduled_tag_id ?? '',
    discord_event_live_tag_id: settings.discord_event_live_tag_id ?? '',
    discord_event_cta_tag_id: settings.discord_event_cta_tag_id ?? '',
    discord_event_flash_tag_id: settings.discord_event_flash_tag_id ?? '',
    discord_audit_log_channel_id: settings.discord_audit_log_channel_id ?? '',
    discord_transaction_spam_channel_id: settings.discord_transaction_spam_channel_id ?? '',
    discord_splits_forum_channel_id: settings.discord_splits_forum_channel_id ?? '',
    discord_split_pending_tag_id: settings.discord_split_pending_tag_id ?? '',
    discord_split_completed_tag_id: settings.discord_split_completed_tag_id ?? '',
    discord_split_not_completed_tag_id: settings.discord_split_not_completed_tag_id ?? '',
    discord_split_lost_tag_id: settings.discord_split_lost_tag_id ?? '',
    discord_event_voice_category_id: settings.discord_event_voice_category_id ?? '',
    discord_event_timezone: settings.discord_event_timezone ?? 'Europe/Rome',
    default_split_fee: String(settings.default_split_fee ?? 20),
  };
}
