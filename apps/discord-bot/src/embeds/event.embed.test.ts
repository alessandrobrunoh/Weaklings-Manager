import assert from "node:assert/strict";
import test from "node:test";
import type { EventView } from "../api/types.js";
import {
  buildEventReminderMessage,
  buildEventThreadActionRow,
} from "./event.embed.js";

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    id: 42,
    title: "Castle Fight",
    description: null,
    call_to_arms: false,
    discord_role_ids: ["111111111111111111", "222222222222222222"],
    regear: false,
    comp_id: 7,
    comp_name: "Main ZvZ",
    created_by: 1,
    created_by_username: "Officer",
    event_date_utc: "2026-09-01T20:00:00Z",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    status: "scheduled",
    started_at: null,
    stopped_at: null,
    auto_stop_deadline: null,
    link_status: "pending",
    ...overrides,
  };
}

test("thread action row exposes five state-aware event controls", () => {
  const scheduled = buildEventThreadActionRow(event()).toJSON().components;

  assert.deepEqual(
    scheduled.map((component) =>
      "custom_id" in component ? component.custom_id : undefined,
    ),
    [
      "event:join:42",
      "event:leave:42",
      "event:ping:42",
      "event:start:42",
      "event:stop:42",
    ],
  );
  assert.deepEqual(
    scheduled.map((component) => component.disabled ?? false),
    [false, false, false, false, true],
  );

  const live = buildEventThreadActionRow(event({ status: "live" })).toJSON().components;
  assert.deepEqual(
    live.map((component) => component.disabled ?? false),
    [true, true, true, true, false],
  );

  const stopped = buildEventThreadActionRow(event({ status: "stopped" })).toJSON().components;
  assert.ok(stopped.every((component) => component.disabled));
});

test("reminder uses stable per-event role mentions and a relative event timestamp", () => {
  const message = buildEventReminderMessage(
    event({
      discord_role_ids: [
        "111111111111111111",
        "111111111111111111",
        "222222222222222222",
      ],
    }),
  );

  assert.match(message.content, /<@&111111111111111111> <@&222222222222222222>/);
  assert.match(message.content, /<t:1788292800:R>/);
  assert.match(message.content, /Join \/ Change Build/);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    roles: ["111111111111111111", "222222222222222222"],
  });
});

test("reminder without roles disables generic mentions", () => {
  const message = buildEventReminderMessage(event({ discord_role_ids: [] }));

  assert.doesNotMatch(message.content, /<@&/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
});
