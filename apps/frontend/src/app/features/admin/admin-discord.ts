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
  discord_applications_channel_id: '',
  discord_applications_category_id: '',
  discord_applications_archive_category_id: '',
  discord_applications_manage_role_id: '',
  discord_applications_status_channel_id: '',
  discord_applications_open: 'false',
  discord_applications_panel_title: 'Applications',
  discord_applications_panel_message: 'Clicca il pulsante per creare una application.',
  discord_applications_welcome_title: 'Benvenuto',
  discord_applications_welcome_message: 'Di cosa hai bisogno?',
  discord_applications_status_open_message: 'Le application sono aperte.',
  discord_applications_status_closed_message: 'Le application sono chiuse.',
  discord_applications_manage_title: 'Gestisci application',
  discord_applications_manage_message: 'Usa i pulsanti qui sotto per gestire questa application.',
  discord_applications_accept_title: 'Application accettata',
  discord_applications_accept_message: 'La tua application è stata accettata.',
  discord_applications_decline_title: 'Application rifiutata',
  discord_applications_decline_message: 'La tua application è stata rifiutata.',
  discord_applications_close_title: 'Application chiusa',
  discord_applications_close_message: 'Questa application è stata chiusa.',
  discord_applications_no_permission_title: 'Permessi insufficienti',
  discord_applications_no_permission_message: 'Non hai il permesso di gestire le application.',
  discord_applications_already_open_title: 'Application già aperta',
  discord_applications_already_open_message: 'Hai già un’application aperta.',
  discord_applications_closed_title: 'Application chiuse',
  discord_applications_closed_message: 'Le application sono attualmente chiuse.',
  discord_applications_error_message: 'Si è verificato un errore. Riprova più tardi.',
  discord_applications_final_title: 'Application conclusa',
  discord_applications_result_message: 'Grazie per aver inviato la tua application.',
  discord_applications_panel_message_id: '',
  default_split_fee: '20',
};

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
            <label>
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
              <span id="discord-event-voice-category-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.discord.eventVoiceCategoryHint') }}
              </span>
            </label>
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

            <label>
              <span class="label">{{ t('admin.discord.applicationPanelChannel') }}</span>
              <app-searchable-select
                class="mt-1 block"
                [options]="channelOptions(['text'], guildSettingsDraft().discord_applications_channel_id)"
                [value]="guildSettingsDraft().discord_applications_channel_id"
                [emptyLabel]="t('admin.discord.placeholder')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading()"
                [ariaLabel]="t('admin.discord.applicationPanelChannel')"
                (valueChange)="setDraftValue('discord_applications_channel_id', $event)"
              />
              <span id="application-panel-channel-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationPanelChannelHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationCategory') }}</span>
              <app-searchable-select
                class="mt-1 block"
                [options]="channelOptions(['category'], guildSettingsDraft().discord_applications_category_id)"
                [value]="guildSettingsDraft().discord_applications_category_id"
                [emptyLabel]="t('admin.discord.placeholder')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading()"
                [ariaLabel]="t('admin.discord.applicationCategory')"
                (valueChange)="setDraftValue('discord_applications_category_id', $event)"
              />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationCategoryHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationArchiveCategory') }}</span>
              <app-searchable-select
                class="mt-1 block"
                [options]="channelOptions(['category'], guildSettingsDraft().discord_applications_archive_category_id)"
                [value]="guildSettingsDraft().discord_applications_archive_category_id"
                [emptyLabel]="t('admin.discord.placeholder')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading()"
                [ariaLabel]="t('admin.discord.applicationArchiveCategory')"
                (valueChange)="setDraftValue('discord_applications_archive_category_id', $event)"
              />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationArchiveCategoryHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationManageRole') }}</span>
              <app-searchable-select
                class="mt-1 block"
                [options]="roleOptions(guildSettingsDraft().discord_applications_manage_role_id)"
                [value]="guildSettingsDraft().discord_applications_manage_role_id"
                [emptyLabel]="t('admin.discord.placeholder')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading()"
                [ariaLabel]="t('admin.discord.applicationManageRole')"
                (valueChange)="setDraftValue('discord_applications_manage_role_id', $event)"
              />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationManageRoleHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationStatusChannel') }}</span>
              <app-searchable-select
                class="mt-1 block"
                [options]="channelOptions(['text'], guildSettingsDraft().discord_applications_status_channel_id)"
                [value]="guildSettingsDraft().discord_applications_status_channel_id"
                [emptyLabel]="t('admin.discord.placeholder')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading()"
                [ariaLabel]="t('admin.discord.applicationStatusChannel')"
                (valueChange)="setDraftValue('discord_applications_status_channel_id', $event)"
              />
              <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationStatusChannelHint') }}</span>
            </label>
            <label class="flex items-center gap-3 sm:col-span-2">
              <input type="checkbox" [checked]="guildSettingsDraft().discord_applications_open === 'true'"
                (change)="updateApplicationsOpen($event)" />
              <span>
                <span class="label">{{ t('admin.discord.applicationsOpen') }}</span>
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationsOpenHint') }}</span>
              </span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationPanelTitle') }}</span>
              <input id="discord-application-panel-title" name="discord-application-panel-title" class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_panel_title"
                aria-describedby="discord-application-panel-title-hint"
                (input)="updateDraftField('discord_applications_panel_title', $event)" />
              <span id="discord-application-panel-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationPanelTitleHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationPanelMessage') }}</span>
              <textarea id="discord-application-panel-message" name="discord-application-panel-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_panel_message"
                aria-describedby="discord-application-panel-message-hint"
                (input)="updateDraftField('discord_applications_panel_message', $event)"></textarea>
              <span id="discord-application-panel-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
            </label>

            <label>
              <span class="label">{{ t('admin.discord.applicationWelcomeTitle') }}</span>
              <input id="discord-application-welcome-title" name="discord-application-welcome-title" class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_welcome_title"
                aria-describedby="discord-application-welcome-title-hint"
                (input)="updateDraftField('discord_applications_welcome_title', $event)" />
              <span id="discord-application-welcome-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationWelcomeMessage') }}</span>
              <textarea id="discord-application-welcome-message" name="discord-application-welcome-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_welcome_message"
                aria-describedby="discord-application-welcome-message-hint"
                (input)="updateDraftField('discord_applications_welcome_message', $event)"></textarea>
              <span id="discord-application-welcome-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
            </label>

            <label>
              <span class="label">{{ t('admin.discord.applicationStatusOpenMessage') }}</span>
              <textarea id="discord-application-status-open-message" name="discord-application-status-open-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_status_open_message"
                aria-describedby="discord-application-status-open-message-hint"
                (input)="updateDraftField('discord_applications_status_open_message', $event)"></textarea>
              <span id="discord-application-status-open-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
            </label>
            <label>
              <span class="label">{{ t('admin.discord.applicationStatusClosedMessage') }}</span>
              <textarea id="discord-application-status-closed-message" name="discord-application-status-closed-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_status_closed_message"
                aria-describedby="discord-application-status-closed-message-hint"
                (input)="updateDraftField('discord_applications_status_closed_message', $event)"></textarea>
              <span id="discord-application-status-closed-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
            </label>

            <fieldset class="grid gap-4 sm:col-span-2 sm:grid-cols-2">
              <legend class="label mb-1">{{ t('admin.discord.applicationLifecycleTitle') }}</legend>
              <label>
                <span class="label">{{ t('admin.discord.applicationManageTitle') }}</span>
                <input id="discord-application-manage-title" name="discord-application-manage-title" class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_manage_title"
                  aria-describedby="discord-application-manage-title-hint" (input)="updateDraftField('discord_applications_manage_title', $event)" />
                <span id="discord-application-manage-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationManageMessage') }}</span>
                <textarea id="discord-application-manage-message" name="discord-application-manage-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_manage_message"
                  aria-describedby="discord-application-manage-message-hint" (input)="updateDraftField('discord_applications_manage_message', $event)"></textarea>
                <span id="discord-application-manage-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationAcceptTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_accept_title" aria-describedby="application-accept-title-hint" (input)="updateDraftField('discord_applications_accept_title', $event)" />
                <span id="application-accept-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationAcceptMessage') }}</span>
                <textarea id="discord-application-accept-message" name="discord-application-accept-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_accept_message"
                  aria-describedby="discord-application-accept-message-hint" (input)="updateDraftField('discord_applications_accept_message', $event)"></textarea>
                <span id="discord-application-accept-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationDeclineTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_decline_title" aria-describedby="application-decline-title-hint" (input)="updateDraftField('discord_applications_decline_title', $event)" />
                <span id="application-decline-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationDeclineMessage') }}</span>
                <textarea id="discord-application-decline-message" name="discord-application-decline-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_decline_message"
                  aria-describedby="discord-application-decline-message-hint" (input)="updateDraftField('discord_applications_decline_message', $event)"></textarea>
                <span id="discord-application-decline-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationCloseTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_close_title" aria-describedby="application-close-title-hint" (input)="updateDraftField('discord_applications_close_title', $event)" />
                <span id="application-close-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationCloseMessage') }}</span>
                <textarea id="discord-application-close-message" name="discord-application-close-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_close_message"
                  aria-describedby="discord-application-close-message-hint" (input)="updateDraftField('discord_applications_close_message', $event)"></textarea>
                <span id="discord-application-close-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationNoPermissionTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_no_permission_title" aria-describedby="application-no-permission-title-hint" (input)="updateDraftField('discord_applications_no_permission_title', $event)" />
                <span id="application-no-permission-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationNoPermissionMessage') }}</span>
                <textarea id="discord-application-no-permission-message" name="discord-application-no-permission-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_no_permission_message"
                  aria-describedby="discord-application-no-permission-message-hint" (input)="updateDraftField('discord_applications_no_permission_message', $event)"></textarea>
                <span id="discord-application-no-permission-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationAlreadyOpenTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_already_open_title" aria-describedby="application-already-open-title-hint" (input)="updateDraftField('discord_applications_already_open_title', $event)" />
                <span id="application-already-open-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationAlreadyOpenMessage') }}</span>
                <textarea id="discord-application-already-open-message" name="discord-application-already-open-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_already_open_message"
                  aria-describedby="discord-application-already-open-message-hint" (input)="updateDraftField('discord_applications_already_open_message', $event)"></textarea>
                <span id="discord-application-already-open-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationClosedTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_closed_title" aria-describedby="application-closed-title-hint" (input)="updateDraftField('discord_applications_closed_title', $event)" />
                <span id="application-closed-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationClosedMessage') }}</span>
                <textarea id="discord-application-closed-message" name="discord-application-closed-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_closed_message"
                  aria-describedby="discord-application-closed-message-hint" (input)="updateDraftField('discord_applications_closed_message', $event)"></textarea>
                <span id="discord-application-closed-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationErrorMessage') }}</span>
                <textarea id="discord-application-error-message" name="discord-application-error-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_error_message"
                  aria-describedby="discord-application-error-message-hint" (input)="updateDraftField('discord_applications_error_message', $event)"></textarea>
                <span id="discord-application-error-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
              <label>
                <span class="label">{{ t('admin.discord.applicationFinalTitle') }}</span>
                <input class="input" type="text" maxlength="256" [value]="guildSettingsDraft().discord_applications_final_title" aria-describedby="application-final-title-hint" (input)="updateDraftField('discord_applications_final_title', $event)" />
                <span id="application-final-title-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTitleHint') }}</span>
                <span class="label">{{ t('admin.discord.applicationFinalMessage') }}</span>
                <textarea id="discord-application-final-message" name="discord-application-final-message" class="input min-h-24" maxlength="4000" [value]="guildSettingsDraft().discord_applications_result_message"
                  aria-describedby="discord-application-final-message-hint" (input)="updateDraftField('discord_applications_result_message', $event)"></textarea>
                <span id="discord-application-final-message-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">{{ t('admin.discord.applicationTextHint') }}</span>
              </label>
            </fieldset>

            <label>
              <span class="label">{{ t('admin.split.defaultFee') }}</span>
              <div class="flex items-center gap-2">
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
              <app-searchable-select
                class="mt-1 block"
                [options]="roleOptions(autoRoleDraft())"
                [value]="autoRoleDraft()"
                [emptyLabel]="t('admin.autorole.disabled')"
                [searchPlaceholder]="t('common.search')"
                [noMatchesLabel]="t('picker.noMatches')"
                [emptyOptionsLabel]="t('picker.empty')"
                [loading]="catalogLoading() || autoRoleLoading()"
                [ariaLabel]="t('admin.autorole.role')"
                (valueChange)="autoRoleDraft.set($event)"
              />
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
  protected readonly catalogLoading = signal(false);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);
  protected readonly autoRoleDraft = signal('');

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

  protected setDraftValue(field: keyof GuildSettingsView, value: string): void {
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
    const tagFields = [
      'discord_split_pending_tag_id',
      'discord_split_completed_tag_id',
      'discord_split_not_completed_tag_id',
      'discord_split_lost_tag_id',
    ] as const;
    this.guildSettingsDraft.update((draft) => {
      const next = { ...draft };
      for (const field of tagFields) {
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildSettingsLoading.set(false);
    }
  }

  protected updateDraftField(field: keyof GuildSettingsView, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.guildSettingsDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected updateApplicationsOpen(event: Event): void {
    this.guildSettingsDraft.update((draft) => ({
      ...draft,
      discord_applications_open: (event.target as HTMLInputElement).checked ? 'true' : 'false',
    }));
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
        discord_applications_channel_id: draft.discord_applications_channel_id.trim(),
        discord_applications_category_id: draft.discord_applications_category_id.trim(),
        discord_applications_archive_category_id: draft.discord_applications_archive_category_id.trim(),
        discord_applications_manage_role_id: draft.discord_applications_manage_role_id.trim(),
        discord_applications_status_channel_id: draft.discord_applications_status_channel_id.trim(),
        discord_applications_open: draft.discord_applications_open === 'true',
        discord_applications_panel_title: draft.discord_applications_panel_title.trim(),
        discord_applications_panel_message: draft.discord_applications_panel_message.trim(),
        discord_applications_welcome_title: draft.discord_applications_welcome_title.trim(),
        discord_applications_welcome_message: draft.discord_applications_welcome_message.trim(),
        discord_applications_status_open_message: draft.discord_applications_status_open_message.trim(),
        discord_applications_status_closed_message: draft.discord_applications_status_closed_message.trim(),
        discord_applications_manage_title: draft.discord_applications_manage_title.trim(),
        discord_applications_manage_message: draft.discord_applications_manage_message.trim(),
        discord_applications_accept_title: draft.discord_applications_accept_title.trim(),
        discord_applications_accept_message: draft.discord_applications_accept_message.trim(),
        discord_applications_decline_title: draft.discord_applications_decline_title.trim(),
        discord_applications_decline_message: draft.discord_applications_decline_message.trim(),
        discord_applications_close_title: draft.discord_applications_close_title.trim(),
        discord_applications_close_message: draft.discord_applications_close_message.trim(),
        discord_applications_no_permission_title: draft.discord_applications_no_permission_title.trim(),
        discord_applications_no_permission_message: draft.discord_applications_no_permission_message.trim(),
        discord_applications_already_open_title: draft.discord_applications_already_open_title.trim(),
        discord_applications_already_open_message: draft.discord_applications_already_open_message.trim(),
        discord_applications_closed_title: draft.discord_applications_closed_title.trim(),
        discord_applications_closed_message: draft.discord_applications_closed_message.trim(),
        discord_applications_error_message: draft.discord_applications_error_message.trim(),
        discord_applications_final_title: draft.discord_applications_final_title.trim(),
        discord_applications_result_message: draft.discord_applications_result_message.trim(),
        discord_applications_panel_message_id: draft.discord_applications_panel_message_id.trim(),
        default_split_fee: Number(draft.default_split_fee),
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
      if (roles.length && this.discordRoles().length === 0) {
        this.discordRoles.set(roles);
      }
      this.autoRoleDraft.set(settings.discord_auto_role_id ?? '');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.autoRoleLoading.set(false);
    }
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
    discord_applications_channel_id: settings.discord_applications_channel_id ?? '',
    discord_applications_category_id: settings.discord_applications_category_id ?? '',
    discord_applications_archive_category_id: settings.discord_applications_archive_category_id ?? '',
    discord_applications_manage_role_id: settings.discord_applications_manage_role_id ?? '',
    discord_applications_status_channel_id: settings.discord_applications_status_channel_id ?? '',
    discord_applications_open: String(settings.discord_applications_open),
    discord_applications_panel_title: settings.discord_applications_panel_title ?? 'Applications',
    discord_applications_panel_message: settings.discord_applications_panel_message ?? 'Clicca il pulsante per creare una application.',
    discord_applications_welcome_title: settings.discord_applications_welcome_title ?? 'Benvenuto',
    discord_applications_welcome_message: settings.discord_applications_welcome_message ?? 'Di cosa hai bisogno?',
    discord_applications_status_open_message: settings.discord_applications_status_open_message ?? 'Le application sono aperte.',
    discord_applications_status_closed_message: settings.discord_applications_status_closed_message ?? 'Le application sono chiuse.',
    discord_applications_manage_title: settings.discord_applications_manage_title ?? 'Gestisci application',
    discord_applications_manage_message: settings.discord_applications_manage_message ?? 'Usa i pulsanti qui sotto per gestire questa application.',
    discord_applications_accept_title: settings.discord_applications_accept_title ?? 'Application accettata',
    discord_applications_accept_message: settings.discord_applications_accept_message ?? 'La tua application è stata accettata.',
    discord_applications_decline_title: settings.discord_applications_decline_title ?? 'Application rifiutata',
    discord_applications_decline_message: settings.discord_applications_decline_message ?? 'La tua application è stata rifiutata.',
    discord_applications_close_title: settings.discord_applications_close_title ?? 'Application chiusa',
    discord_applications_close_message: settings.discord_applications_close_message ?? 'Questa application è stata chiusa.',
    discord_applications_no_permission_title: settings.discord_applications_no_permission_title ?? 'Permessi insufficienti',
    discord_applications_no_permission_message: settings.discord_applications_no_permission_message ?? 'Non hai il permesso di gestire le application.',
    discord_applications_already_open_title: settings.discord_applications_already_open_title ?? 'Application già aperta',
    discord_applications_already_open_message: settings.discord_applications_already_open_message ?? 'Hai già un’application aperta.',
    discord_applications_closed_title: settings.discord_applications_closed_title ?? 'Application chiuse',
    discord_applications_closed_message: settings.discord_applications_closed_message ?? 'Le application sono attualmente chiuse.',
    discord_applications_error_message: settings.discord_applications_error_message ?? 'Si è verificato un errore. Riprova più tardi.',
    discord_applications_final_title: settings.discord_applications_final_title ?? 'Application conclusa',
    discord_applications_result_message: settings.discord_applications_result_message ?? 'Grazie per aver inviato la tua application.',
    discord_applications_panel_message_id: settings.discord_applications_panel_message_id ?? '',
    default_split_fee: String(settings.default_split_fee ?? 20),
  };
}
