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

// The backend serialises Decimal money as strings; these used to concatenate.
function stringSplit(overrides: Partial<SplitDetail> = {}): SplitDetail {
  return pendingSplit({
    estimated_market_value: "1000.00",
    fee: "20.00",
    repair_value: "100.00",
    bags_value: "50.00",
    ...overrides,
  });
}

test("pending pool does not concatenate decimal strings", () => {
  const pool = pendingSplitPool(stringSplit());
  assert.equal(pool.valueBeforeFee, 950);
  assert.equal(pool.feeAmount, 190);
  assert.equal(pool.net, 760);
});

test("pending pool with decimal-string fixtures is exact and rounds half to even", () => {
  // 100.05 * 7.5% = 7.50375 -> fee 7.50, net 92.54625 -> 92.55
  const pool = pendingSplitPool({
    estimated_market_value: "100.05",
    fee: "7.5",
    repair_value: "0.00",
    bags_value: "0.00",
  });
  assert.equal(pool.feeAmount, 7.5);
  assert.equal(pool.net, 92.55);
  // net exactly 0.125 -> half-even gives 0.12 (Math.round would give 0.13)
  assert.equal(pendingSplitPool({ estimated_market_value: "0.25", fee: "50", repair_value: "0", bags_value: "0" }).net, 0.12);
  // net exactly 0.135 -> half-even gives 0.14
  assert.equal(pendingSplitPool({ estimated_market_value: "0.27", fee: "50", repair_value: "0", bags_value: "0" }).net, 0.14);
  // pool can never go negative
  assert.equal(pendingSplitPool({ estimated_market_value: "10", fee: "0", repair_value: "50", bags_value: "0" }).net, 0);
});

test("pending summary with string decimals shows the correct net, fee and chart", () => {
  const summary = buildSplitSummary(stringSplit());
  const fields = summary.embeds?.[0]?.fields ?? [];
  const breakdown = fields.find((field) => field.name === "🪙 Financial Breakdown")?.value ?? "";
  assert.match(breakdown, /Gross Loot Value:\*\* \*\*1,000\.00/);
  assert.match(breakdown, /Guild Fee \(20%\):\*\* -190\.00/);
  assert.match(breakdown, /Repairs:\*\* -100\.00/);
  assert.match(breakdown, /Bags:\*\* \+50\.00/);
  assert.match(breakdown, /Net Split Pool:\*\* \*\*760\.00/);
  const chart = fields.find((field) => field.name === "📊 POOL ALLOCATION")?.value ?? "";
  assert.match(chart, /Players Share\s.*760\.00 Silver/);
  assert.match(chart, /Guild Fee\s.*190\.00 Silver/);
  assert.match(chart, /Repairs\s.*100\.00 Silver/);
});

test("completed split with string decimals uses the stored net and a correct fee line", () => {
  const summary = buildSplitSummary(
    stringSplit({
      status: "completed",
      net_value: "760.00",
      participants: [
        { user_id: 1, username: "a", weight: 1, share_amount: "380.00", credit_status: "pending" },
        { user_id: 2, username: "b", weight: 1, share_amount: "380.00", credit_status: "pending" },
      ],
    }),
  );
  const fields = summary.embeds?.[0]?.fields ?? [];
  const breakdown = fields.find((field) => field.name === "🪙 Financial Breakdown")?.value ?? "";
  assert.match(breakdown, /Guild Fee \(20%\):\*\* -190\.00/);
  assert.match(breakdown, /Net Split Pool:\*\* \*\*760\.00/);
  const roster = fields.find((field) => field.name.startsWith("👥"))?.value ?? "";
  assert.match(roster, /380\.00 Silver/);
});
