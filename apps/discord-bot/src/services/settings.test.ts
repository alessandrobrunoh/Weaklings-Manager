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
  discord_event_voice_category_id: "123456789012345678",
};

test("SettingsService exposes the configured event voice category", async () => {
  const api = {
    get: async () => settings,
  } as unknown as ApiClient;
  const service = new SettingsService(api);

  assert.equal(await service.eventVoiceCategoryId(), "123456789012345678");
});
