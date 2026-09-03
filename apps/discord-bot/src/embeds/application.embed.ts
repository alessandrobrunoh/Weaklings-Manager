import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIEmbed,
} from 'discord.js';
import type { GuildSettingsView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from './theme.js';

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

export function buildApplicationWelcomeComponents(applicationId?: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`application:manage${applicationId ? `:${applicationId}` : ''}`).setLabel('Manage').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`application:close${applicationId ? `:${applicationId}` : ''}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    ),
  ];
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
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!settings.discord_applications_open),
    ),
  ];
}
