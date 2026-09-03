import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuildSettingsView } from '../api/types.js';
import {
  buildApplicationAlreadyOpenEmbed,
  buildApplicationClosedEmbed,
  buildApplicationFinalEmbed,
  buildApplicationManageEmbed,
  buildApplicationNoPermissionEmbed,
  buildApplicationPanelComponents,
  buildApplicationPanelEmbed,
  buildApplicationStatusAnnouncement,
  buildApplicationWelcomeComponents,
} from './application.embed.js';

const settings: GuildSettingsView = {
  discord_events_channel_id: null,
  discord_battles_channel_id: null,
  discord_battles_cta_channel_id: null,
  discord_audit_log_channel_id: null,
  discord_transaction_spam_channel_id: null,
  discord_event_role_id: null,
  discord_auto_role_id: null,
  discord_splits_forum_channel_id: null,
  discord_split_pending_tag_id: null,
  discord_split_completed_tag_id: null,
  discord_split_not_completed_tag_id: null,
  discord_split_lost_tag_id: null,
  discord_event_voice_category_id: null,
  discord_applications_channel_id: '123456789012345678',
  discord_applications_category_id: '123456789012345679',
  discord_applications_archive_category_id: null,
  discord_applications_manage_role_id: '123456789012345680',
  discord_applications_status_channel_id: null,
  discord_applications_open: true,
  discord_applications_panel_title: 'Candidature Weaklings',
  discord_applications_panel_message: 'Clicca per creare una application',
  discord_applications_welcome_title: 'Benvenuto',
  discord_applications_welcome_message: 'Di cosa hai bisogno?',
  discord_applications_status_open_message: 'Le application sono aperte.',
  discord_applications_status_closed_message: 'Le application sono chiuse.',
  discord_applications_manage_title: 'Gestione candidatura',
  discord_applications_manage_message: 'Scegli un esito.',
  discord_applications_accept_message: 'Candidatura accettata.',
  discord_applications_decline_message: 'Candidatura rifiutata.',
  discord_applications_no_permission_message: 'Azione non autorizzata.',
  discord_applications_already_open_message: 'Application già aperta in {channel}.',
  discord_applications_closed_message: 'Le candidature sono chiuse.',
  discord_applications_error_message: 'Errore candidatura.',
  discord_applications_result_message: 'Workflow concluso: {status}.',
  discord_applications_panel_message_id: null,
  default_split_fee: '20.00',
};

test('application panel shows configured copy and open state', () => {
  const embed = buildApplicationPanelEmbed(settings);
  assert.equal(embed.title, 'Candidature Weaklings');
  assert.match(embed.description ?? '', /Clicca per creare/);
  assert.match(embed.description ?? '', /APERTE/);
  assert.equal(buildApplicationPanelComponents(settings)[0].components[0].data.disabled, false);
});

test('status announcement mentions everyone and uses the matching configured copy', () => {
  const announcement = buildApplicationStatusAnnouncement(settings);
  assert.equal(announcement.content, '@everyone');
  assert.deepEqual(announcement.allowedMentions, { parse: ['everyone'] });
  assert.equal(announcement.embeds[0].description, 'Le application sono aperte.');

  const closed = buildApplicationStatusAnnouncement({ ...settings, discord_applications_open: false });
  assert.equal(closed.embeds[0].description, 'Le application sono chiuse.');
});

test('workflow responses use configured copy and preserve stable terminal custom IDs', () => {
  assert.equal(buildApplicationManageEmbed(settings).description, 'Scegli un esito.');
  assert.equal(buildApplicationNoPermissionEmbed(settings).title, '⚠️ Permessi insufficienti');
  assert.equal(buildApplicationNoPermissionEmbed(settings).description, 'Azione non autorizzata.');
  assert.equal(buildApplicationClosedEmbed(settings).title, '⚠️ Applications closed');
  assert.equal(buildApplicationClosedEmbed(settings).description, 'Le candidature sono chiuse.');
  assert.match(buildApplicationAlreadyOpenEmbed(settings, '123').description ?? '', /<#123>/);
  assert.equal(buildApplicationAlreadyOpenEmbed(settings, '123').title, 'ℹ️ Application already open');
  assert.equal(buildApplicationFinalEmbed(settings, 'accept').title, 'Application accettata');
  assert.match(buildApplicationFinalEmbed(settings, 'accept').description ?? '', /Candidatura accettata/);

  const components = buildApplicationWelcomeComponents(42, true)[0].components;
  assert.deepEqual(components.map((component) => ('custom_id' in component.data ? component.data.custom_id : undefined)), [
    'application:manage:42',
    'application:close:42',
  ]);
  assert.ok(components.every((component) => component.data.disabled === true));
});

test('closed application panel disables creation', () => {
  const embed = buildApplicationPanelEmbed({ ...settings, discord_applications_open: false });
  assert.match(embed.description ?? '', /CHIUSE/);
  assert.equal(
    buildApplicationPanelComponents({ ...settings, discord_applications_open: false })[0].components[0].data.disabled,
    true,
  );
});
