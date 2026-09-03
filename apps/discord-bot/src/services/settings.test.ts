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
  default_split_fee: "20.00",
};

test("SettingsService exposes the configured event voice category", async () => {
  const api = {
    get: async () => settings,
  } as unknown as ApiClient;
  const service = new SettingsService(api);

  assert.equal(await service.eventVoiceCategoryId(), "123456789012345678");
});
