import assert from "node:assert/strict";
import test from "node:test";
import type { SplitDetail } from "../api/types.js";
import { buildSplitSummary, pendingSplitPool } from "./split-summary.js";

function pendingSplit(overrides: Partial<SplitDetail> = {}): SplitDetail {
  return {
    id: 7,
    created_by_username: "leader",
    status: "pending",
    estimated_market_value: 1_000,
    fee: 20,
    repair_value: 100,
    bags_value: 50,
    net_value: null,
    note: null,
    event_id: null,
    event_title: null,
    island_id: null,
    island_name: null,
    island_city: null,
    island_tab_id: null,
    island_tab_name: null,
    participant_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    finalized_at: null,
    archived_at: null,
    participants: [],
    ...overrides,
  };
}

test("pending split pool matches the backend fee base", () => {
  const pool = pendingSplitPool(pendingSplit());
  assert.equal(pool.valueBeforeFee, 950);
  assert.equal(pool.feeAmount, 190);
  assert.equal(pool.net, 760);
});

test("pending summary uses the shared pool when net_value is not stored yet", () => {
  const summary = buildSplitSummary(pendingSplit());
  const fields = summary.embeds?.[0]?.fields ?? [];
  const breakdown = fields.find((field) => field.name === "🪙 Financial Breakdown")?.value ?? "";
  assert.match(breakdown, /Guild Fee \(20%\):\*\* -190/);
  assert.match(breakdown, /Bags:\*\* \+50/);
  assert.match(breakdown, /Net Split Pool:\*\* \*\*760/);
  assert.doesNotMatch(breakdown, /650/);
});
