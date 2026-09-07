import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "../api/client.js";
import type { GuildSettingsView } from "../api/types.js";
import {
  SettingsService,
  forgetSettingsService,
  getSettingsService,
  initSettingsService,
} from "./settings.js";

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
  discord_event_voice_category_id: "123456789012345678",
  discord_applications_channel_id: null,
  discord_applications_category_id: null,
  discord_applications_archive_category_id: null,
  discord_applications_manage_role_id: null,
  discord_applications_status_channel_id: null,
  discord_applications_open: false,
  discord_applications_panel_title: "Applications",
  discord_applications_panel_message: "Clicca il pulsante per creare una application.",
  discord_applications_welcome_title: "Benvenuto",
  discord_applications_welcome_message: "Di cosa hai bisogno?",
  discord_applications_status_open_message: "Le application sono aperte.",
  discord_applications_status_closed_message: "Le application sono chiuse.",
  discord_applications_manage_title: "Gestione application",
  discord_applications_manage_message: "Scegli Accept o Decline.",
  discord_applications_accept_message: "Application accettata.",
  discord_applications_decline_message: "Application rifiutata.",
  discord_applications_closed_message: "Le application sono momentaneamente chiuse.",
  discord_applications_no_permission_message: "Non hai i permessi per questa azione.",
  discord_applications_already_open_message: "Hai già un'applicatione aperta: {channel}.",
  discord_applications_error_message: "Errore application.",
  discord_applications_result_message: "Questa application è stata {status}.",
  discord_applications_panel_message_id: null,
  default_split_fee: "20.00",
};

test("SettingsService exposes the configured event voice category", async () => {
  const api = {
    get: async () => settings,
  } as unknown as ApiClient;
  const service = new SettingsService(api);

  assert.equal(await service.eventVoiceCategoryId(), "123456789012345678");
});

test("the settings registry keeps one cache per guild", async () => {
  const seenGuilds: Array<string | undefined> = [];
  const api = {
    guildId: undefined,
    withGuild(guildId: string) {
      seenGuilds.push(guildId);
      return { guildId, get: async () => settings } as unknown as ApiClient;
    },
  } as unknown as ApiClient;

  initSettingsService(api);

  const first = getSettingsService('111');
  assert.equal(getSettingsService('111'), first, 'the same guild reuses its service');
  assert.notEqual(getSettingsService('222'), first, 'a different guild gets its own');
  assert.deepEqual(seenGuilds, ['111', '222']);

  forgetSettingsService('111');
  assert.notEqual(getSettingsService('111'), first, 'forgetting drops the cache');
});

test("the settings registry refuses to answer without a tenant", () => {
  initSettingsService({ withGuild: () => ({}) } as unknown as ApiClient);

  // An unscoped client would read another tenant's settings, or 400 at the
  // backend. Fail here instead, with a message split-forum can recognize.
  assert.throws(() => getSettingsService(undefined), /^Error: SettingsService requires a guild id/);
  assert.throws(() => getSettingsService(null), /^Error: SettingsService requires a guild id/);
});
