import assert from "node:assert/strict";
import test from "node:test";
import type { EventDetailView, EventView } from "../api/types.js";
import {
  buildEventAnnouncementMessage,
  buildEventEmbed,
  buildEventMassMessage,
  buildEventReminderMessage,
  buildEventStartMessage,
  buildEventThreadActionRows,
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
    discord_voice_channel_id: null,
    ...overrides,
  };
}

test("event embed renders every active comp build and marks empty seats", () => {
  const embed = buildEventEmbed({
    ...event(),
    active_comp_id: 7,
    active_comp_name: "Main ZvZ",
    active_comp_capacity: 3,
    comp_builds: [
      { build_id: 10, name: "Main Tank", quantity: 2 },
      { build_id: 11, name: "Holy Healer", quantity: 1 },
    ],
    participants: [
      {
        user_id: 1,
        username: "Tank player",
        discord_id: "333333333333333333",
        primary_build_id: 10,
        primary_build_name: "Main Tank",
        secondary_build_id: null,
        secondary_build_name: null,
      },
    ],
  } as EventDetailView).toJSON();

  assert.deepEqual(embed.fields, [
    {
      name: "Main Tank (1/2)",
      value: "• <@333333333333333333>\n• *?*",
      inline: true,
    },
    {
      name: "Holy Healer (0/1)",
      value: "• *?*",
      inline: true,
    },
  ]);
});

test("thread action rows expose six state-aware event controls within Discord limits", () => {
  const scheduledRows = buildEventThreadActionRows(event()).map((row) => row.toJSON().components);
  const scheduled = scheduledRows.flat();

  assert.deepEqual(scheduledRows.map((row) => row.length), [5, 1]);
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
      "event:cancel:42",
    ],
  );
  assert.deepEqual(
    scheduled.map((component) => component.disabled ?? false),
    [false, false, false, false, true, false],
  );

  const live = buildEventThreadActionRows(event({ status: "live" })).flatMap((row) => row.toJSON().components);
  assert.deepEqual(
    live.map((component) => component.disabled ?? false),
    [true, true, true, true, false, false],
  );

  const stopped = buildEventThreadActionRows(event({ status: "stopped" })).flatMap((row) => row.toJSON().components);
  assert.ok(stopped.every((component) => component.disabled));

  const cancelled = buildEventThreadActionRows(event({ status: "cancelled" })).flatMap((row) => row.toJSON().components);
  assert.ok(cancelled.every((component) => component.disabled));
});

test("event embed renders distinct Mass and Start timestamps", () => {
  const embed = buildEventEmbed(event({
    mass_time_utc: "2026-09-01T19:30:00Z",
    start_time_utc: "2026-09-01T20:00:00Z",
  })).toJSON();
  assert.match(embed.description ?? "", /Mass.*<t:1788291000:F>/);
  assert.match(embed.description ?? "", /Start.*<t:1788292800:F>/);
});

test("Mass notice pings linked participants and points at the pre-created voice channel", () => {
  const message = buildEventMassMessage(
    event({ start_time_utc: "2026-09-01T20:00:00Z" }),
    [{ discord_id: "333333333333333333", username: "Linked" }],
    "444444444444444444",
  );
  assert.match(message.content, /<@333333333333333333>/);
  assert.match(message.content, /<#444444444444444444>/);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["333333333333333333"],
  });
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

test("start notice mentions linked participants and its voice channel without generic parsing", () => {
  const message = buildEventStartMessage(
    event(),
    [
      { discord_id: "333333333333333333", username: "Linked" },
      { discord_id: null, username: "Unlinked" },
      { discord_id: "333333333333333333", username: "Duplicate" },
    ],
    "444444444444444444",
  );

  assert.match(message.content, /<@333333333333333333>/);
  assert.match(message.content, /Unlinked/);
  assert.match(message.content, /<#444444444444444444>/);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["333333333333333333"],
  });
});

test("reminder without roles disables generic mentions", () => {
  const message = buildEventReminderMessage(event({ discord_role_ids: [] }));

  assert.doesNotMatch(message.content, /<@&/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
});

test("parent announcement payload is text-only and never includes roster controls", () => {
  const message = buildEventAnnouncementMessage(
    event({
      discord_role_ids: [
        "111111111111111111",
        "111111111111111111",
        "222222222222222222",
      ],
    }),
  );

  assert.match(message.content, /Castle Fight/);
  assert.match(message.content, /<@&111111111111111111> <@&222222222222222222>/);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    roles: ["111111111111111111", "222222222222222222"],
  });
  assert.equal("embeds" in message, false);
  assert.equal("components" in message, false);
});

test("parent announcement without roles disables generic mentions", () => {
  const message = buildEventAnnouncementMessage(event({ discord_role_ids: [] }));

  assert.doesNotMatch(message.content, /<@&/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.equal("embeds" in message, false);
  assert.equal("components" in message, false);
});
