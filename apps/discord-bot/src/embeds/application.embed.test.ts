import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuildSettingsView } from '../api/types.js';
import { buildApplicationPanelComponents, buildApplicationPanelEmbed } from './application.embed.js';

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
  default_split_fee: '20.00',
};

test('application panel shows configured copy and open state', () => {
  const embed = buildApplicationPanelEmbed(settings);
  assert.equal(embed.title, 'Candidature Weaklings');
  assert.match(embed.description ?? '', /Clicca per creare/);
  assert.match(embed.description ?? '', /APERTE/);
  assert.equal(buildApplicationPanelComponents(settings)[0].components[0].data.disabled, false);
});

test('closed application panel disables creation', () => {
  const embed = buildApplicationPanelEmbed({ ...settings, discord_applications_open: false });
  assert.match(embed.description ?? '', /CHIUSE/);
  assert.equal(
    buildApplicationPanelComponents({ ...settings, discord_applications_open: false })[0].components[0].data.disabled,
    true,
  );
});
