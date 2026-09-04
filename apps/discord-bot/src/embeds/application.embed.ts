import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIEmbed,
} from 'discord.js';
import type { GuildSettingsView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from './theme.js';

const DEFAULT_COPY = {
  manageTitle: 'Gestione application',
  manageMessage: 'Scegli Accept o Decline.',
  acceptMessage: 'Application accettata.',
  declineMessage: 'Application rifiutata.',
  closeTitle: 'Application chiusa',
  closeMessage: 'Application chiusa.',
  acceptTitle: 'Application accettata',
  declineTitle: 'Application rifiutata',
  closedTitle: 'Applications closed',
  noPermissionTitle: 'Permessi insufficienti',
  noPermissionMessage: 'Non hai i permessi per questa azione.',
  alreadyOpenTitle: 'Application already open',
  finalTitle: 'Application conclusa',
  alreadyOpenMessage: "Hai già un'applicatione aperta: {channel}.",
  closedMessage: 'Le application sono momentaneamente chiuse.',
  errorMessage: 'Non è stato possibile completare l’application.',
  resultMessage: 'Application {status}.',
} as const;

export type ApplicationResolutionAction = 'accept' | 'decline' | 'close';

/** Resolves optional copy fields so old guild settings remain usable. */
export function applicationCopy(settings: GuildSettingsView) {
  return {
    manageTitle: settings.discord_applications_manage_title ?? DEFAULT_COPY.manageTitle,
    manageMessage: settings.discord_applications_manage_message ?? DEFAULT_COPY.manageMessage,
    acceptMessage: settings.discord_applications_accept_message ?? DEFAULT_COPY.acceptMessage,
    declineMessage: settings.discord_applications_decline_message ?? DEFAULT_COPY.declineMessage,
    closeTitle: settings.discord_applications_close_title ?? DEFAULT_COPY.closeTitle,
    closeMessage: settings.discord_applications_close_message ?? DEFAULT_COPY.closeMessage,
    acceptTitle: settings.discord_applications_accept_title ?? DEFAULT_COPY.acceptTitle,
    declineTitle: settings.discord_applications_decline_title ?? DEFAULT_COPY.declineTitle,
    closedTitle: settings.discord_applications_closed_title ?? DEFAULT_COPY.closedTitle,
    noPermissionTitle: settings.discord_applications_no_permission_title ?? DEFAULT_COPY.noPermissionTitle,
    noPermissionMessage: settings.discord_applications_no_permission_message ?? DEFAULT_COPY.noPermissionMessage,
    alreadyOpenTitle: settings.discord_applications_already_open_title ?? DEFAULT_COPY.alreadyOpenTitle,
    finalTitle: settings.discord_applications_final_title ?? DEFAULT_COPY.finalTitle,
    alreadyOpenMessage: settings.discord_applications_already_open_message ?? DEFAULT_COPY.alreadyOpenMessage,
    closedMessage: settings.discord_applications_closed_message ?? DEFAULT_COPY.closedMessage,
    errorMessage: settings.discord_applications_error_message ?? DEFAULT_COPY.errorMessage,
    resultMessage: settings.discord_applications_result_message ?? DEFAULT_COPY.resultMessage,
  };
}

function formatCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(channel|status)\}/g, (_, key: 'channel' | 'status') => values[key] ?? '');
}

export function buildApplicationPanelEmbed(settings: GuildSettingsView): APIEmbed {
  return createBaseEmbed({
    category: 'APPLICATIONS',
    title: settings.discord_applications_panel_title,
    description: `${settings.discord_applications_panel_message}\n\n**Stato:** ${settings.discord_applications_open ? '🟢 APERTE' : '🔴 CHIUSE'}`,
    color: settings.discord_applications_open ? BOT_COLORS.SUCCESS : BOT_COLORS.DANGER,
  }).toJSON();
}

export function buildApplicationWelcomeEmbed(settings: GuildSettingsView): APIEmbed {
  return createBaseEmbed({
    category: 'APPLICATIONS',
    title: settings.discord_applications_welcome_title,
    description: settings.discord_applications_welcome_message,
    color: BOT_COLORS.BRAND,
  }).toJSON();
}

export function buildApplicationWelcomeComponents(
  applicationId?: number,
  disabled = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const suffix = applicationId ? `:${applicationId}` : '';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`application:manage${suffix}`).setLabel('Manage').setEmoji('⚙️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`application:close${suffix}`).setLabel('Close').setEmoji('🚪').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

export function buildApplicationManageEmbed(settings: GuildSettingsView): APIEmbed {
  const copy = applicationCopy(settings);
  return createResponseEmbed('info', copy.manageTitle, copy.manageMessage, 'APPLICATIONS').toJSON();
}

export function buildApplicationNoPermissionEmbed(settings: GuildSettingsView): APIEmbed {
  const copy = applicationCopy(settings);
  return createResponseEmbed('warning', copy.noPermissionTitle, copy.noPermissionMessage, 'APPLICATIONS').toJSON();
}

export function buildApplicationErrorEmbed(settings: GuildSettingsView) {
  const copy = applicationCopy(settings);
  return createResponseEmbed('error', 'Application error', copy.errorMessage, 'APPLICATIONS');
}

export function buildApplicationClosedEmbed(settings: GuildSettingsView): APIEmbed {
  const copy = applicationCopy(settings);
  return createResponseEmbed('warning', copy.closedTitle, copy.closedMessage, 'APPLICATIONS').toJSON();
}

export function buildApplicationAlreadyOpenEmbed(settings: GuildSettingsView, channelId: string): APIEmbed {
  const copy = applicationCopy(settings);
  return createResponseEmbed('info', copy.alreadyOpenTitle, formatCopy(copy.alreadyOpenMessage, { channel: `<#${channelId}>` }), 'APPLICATIONS').toJSON();
}

export function buildApplicationFinalEmbed(
  settings: GuildSettingsView,
  action: ApplicationResolutionAction,
): APIEmbed {
  const copy = applicationCopy(settings);
  const messages: Record<ApplicationResolutionAction, string> = {
    accept: copy.acceptMessage,
    decline: copy.declineMessage,
    close: copy.closeMessage,
  };
  const status = action === 'accept' ? 'accettata' : action === 'decline' ? 'rifiutata' : 'chiusa';
  return createBaseEmbed({
    category: 'APPLICATIONS',
    title: action === 'accept' ? copy.acceptTitle : action === 'decline' ? copy.declineTitle : copy.closeTitle,
    description: `${formatCopy(messages[action], { status })}\n\n${formatCopy(copy.resultMessage, { status })}`,
    color: action === 'accept' ? BOT_COLORS.SUCCESS : action === 'decline' ? BOT_COLORS.DANGER : BOT_COLORS.WARNING,
  }).toJSON();
}

export function buildApplicationStatusAnnouncement(settings: GuildSettingsView): {
  content: '@everyone';
  embeds: APIEmbed[];
  allowedMentions: { parse: ['everyone'] };
} {
  const open = settings.discord_applications_open;
  return {
    content: '@everyone',
    embeds: [createBaseEmbed({
      category: 'APPLICATIONS',
      title: open ? 'Application aperte' : 'Application chiuse',
      description: open ? settings.discord_applications_status_open_message : settings.discord_applications_status_closed_message,
      color: open ? BOT_COLORS.SUCCESS : BOT_COLORS.DANGER,
    }).toJSON()],
    allowedMentions: { parse: ['everyone'] },
  };
}

export function buildApplicationPanelComponents(
  settings: GuildSettingsView,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('application:create')
        .setLabel('Create Application')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!settings.discord_applications_open),
    ),
  ];
}

/** Payload for the final channel post; never lets configured text create mentions. */
export function buildApplicationResolutionComponents(
  applicationId: number,
  action: ApplicationResolutionAction,
): ActionRowBuilder<ButtonBuilder>[] {
  if (action === 'close') return buildApplicationWelcomeComponents(applicationId, true);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`application:accept:${applicationId}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`application:decline:${applicationId}`).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(true),
  )];
}

export function buildApplicationFinalMessage(settings: GuildSettingsView, action: ApplicationResolutionAction) {
  return {
    embeds: [buildApplicationFinalEmbed(settings, action)],
    allowedMentions: { parse: [] as const },
  };
}

