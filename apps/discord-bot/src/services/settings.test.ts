import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "../api/client.js";
import type { GuildSettingsView } from "../api/types.js";
import { SettingsService } from "./settings.js";

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
