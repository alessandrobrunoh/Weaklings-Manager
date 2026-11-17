# Albion Bank Log Reconciliation

* **Author:** alessandrobrunoh
* **Date:** 2026-11-17

## Overview

Officers of each guild paste the in-game guild bank silver log (JSON export, last 4 weeks, minute
precision) into the Manager once a week. The Manager stores those rows, links each one to what it
already knows (a paid withdrawal, a split's bags, a loot sale by the shared seller account, a guild
expense) and shows what does not line up. The Manager stays the source of truth: the game log is a
second opinion, never an override, and it never creates income on its own.

From day 5 without an import, the backend pings the guild's staff role once a day in a channel set
in the admin panel, until someone imports.

Two related changes are delivered separately:

1. **Market tax split from the guild fee.** Per-guild market tax (default 6%) applied only to the
   loot value sold on the market; guild fee default 15% instead of 20%.
   New formula: `(loot value × (1 − tax) − repairs + bags) × (1 − fee)`.
2. **CSV export of every table** built on the shared `app-data-table` component.

## Analysis

Six independent reviewers read the concept and the code. Their findings, deduplicated and checked
against the code, follow. Severity: 🔴 must be decided before design, 🟡 must be in the design,
🟢 detail.

### 🔴 Row identity: the siphoned import pattern would drop real rows

The siphoned import treats `(time, player lowercased, reason, amount, source)` as a unique key and
skips repeats with a set check (`apps/backend/crates/rewards/src/siphoned/service.rs`, `SiphonedEntryKey`
~line 990). The bank log has legitimate identical rows: LelouchVI withdrew -1,036,150 twice at
2026-11-14 18:42. Copying the pattern loses the second withdrawal and the balance is off by
exactly that amount, with nothing to show why.

Weekly imports of a 4-week window also resend about 3 weeks of rows each time, so "already
imported" and "a second identical real row" must be told apart.

**Proposed rule.** Identity = `(minute, player lowercased, reason, amount, occurrence n)`, where `n`
counts identical rows inside one export (1, 2, …). On import, for each base key with `k` rows in
the export and `m` rows stored, insert only occurrences `m+1 … k`. A re-import of the same window
changes nothing; a real duplicate is kept. Enforce it with a database unique constraint, not only
an application check (the siphoned indexes are non-unique, so two concurrent imports can double
insert). Rows that scroll out of later exports are kept. The import reply reports new, already
stored, and kept-duplicate counts.

### 🔴 Guild expenses are not bank transactions

`transactions.to_user_id` is a required `i64` (`apps/backend/crates/entities/src/bank.rs`).
Vault purchases and territory claims have no member. Forcing them into the bank ledger means a
fake recipient or a nullable column that every balance query must then handle.

**Proposed rule.** Expenses live only on the imported row, with category `guild expense`. They
count in the period's outflows and are never written to the bank ledger. Rows whose reason is not
`Deposit` or `Withdrawal` get that category automatically; the officer can change it. This also
respects the rule that the Manager never infers money movements from external data.

### 🔴 Market tax change can silently change existing splits

`calculate_net_value` (`apps/backend/crates/splits/src/service.rs` ~line 493) has four callers:
recalculation of completed splits (~254), the KPI fallback when `net_value` is empty (~1842),
`complete_split` (~2528) and the alliance projection
(`apps/backend/crates/splits/src/alliance_distribution.rs` ~175). Splits that are not finalized have
no stored `net_value` and are recomputed. A new tax column that defaults to 6% for existing rows
would change the payout of open splits, of amended completed splits, and of alliance copies.

**Proposed rule.** Add `market_tax_percent` to each split, filled at creation from the guild
setting. Existing rows get 0, so their result is identical. Pass the stored tax to all four callers.
The alliance projection carries the source split's tax, with a test that the projected net equals
the source net. The guild default fee is also stored in guild settings
(`entities/src/admin.rs` `default_split_fee`, migration `m20260902_000011`), not only in the code
constant (`DEFAULT_SPLIT_FEE_PERCENT = 20`); the migration must not rewrite guilds' stored values.
Each split shows which tax and fee it used.

### 🟡 Matching needs states, rules and limits

"Match" was described without saying whether it is a fact or a proposal, how close an amount must
be, or how far apart in time. Many-to-one and one-to-many matching is a subset-sum search: it can
blow up and it can be ambiguous (three bag deposits in the same minute by two players; one
WeaklingsGM deposit covering several splits).

Row states: `unmatched`, `suggested`, `matched` (confirmed by an officer or exact by rule),
`explained` (note required). The system only proposes; ambiguous cases always go to an officer.

| Kind | Albion side | Manager side | Rule |
| --- | --- | --- | --- |
| Payout | one `Withdrawal` (player = paying officer) | one or more paid withdrawal rows of **one** member | exact silver amount, within N days after the request was accepted |
| Bags | one or more `Deposit` rows, any player except seller accounts | one split's `bags_value` | exact sum, after split creation, bounded group size |
| Loot sale | one or more `Deposit` rows by a seller account | one or more splits' loot value × (1 − stored tax) | tolerance in silver, bounded group size |
| Expense | reason not Deposit/Withdrawal | none | automatic category |

Withdrawal consolidation into one row happens only for "withdraw all"
(`apps/backend/crates/bank/src/service.rs` ~926); a request by explicit ids can produce several rows,
hence "one or more rows of one member". The matched row shows both the paying officer and the
receiving member. Seller accounts (WeaklingsGM) are a per-guild setting; none exists today.

A matcher with no database access (rows in, proposals out) keeps the four kinds testable on their own.

### 🟡 What the period balance can and cannot compare

Only withdrawals have an independent Manager total (paid withdrawals in the period). Deposits are
not bank transactions in the Manager: bags and loot sales exist only as values on splits, and a
sale can land days after the split. So "Manager in" is not a ledger total; it is the expected value
of the rows that were linked. The balance shows, per category: game total, linked Manager total,
and the unlinked remainder. Explained rows stay in the game total and are shown apart from the
difference.

The game shows 4 weeks only, so the first import sets the start of tracking; nothing before it can
be reconciled.

### 🟡 Links must survive changes to the ledger

Open credits are merged and deleted on "withdraw all" (`consolidate_user_open_credits`, bank
service ~357), and completed splits can be amended. Links point at split ids and paid withdrawal
ids, which are stable. If a linked record is deleted, the row goes back to `unmatched` (foreign key
set to null) and keeps its history in the audit log.

"Create a transaction from this row, at most once" needs a link column with a unique constraint,
written in the same database transaction as the insert. A rejected or deleted transaction leaves
the row linked as "transaction removed", so it cannot be paid twice by recreating it.

### 🟡 Reminder: where it runs and how it fails

The backend scheduler slice is not built (`apps/backend/crates/runtime/src/lib.rs` marks the Discord
outbox as inert). The bot poller keeps state in local JSON files with no lock, so a restart or a
second bot instance can ping twice or skip a day. Per-tenant background workers already exist
(`apps/backend/crates/identity/src/tenant.rs`).

**Proposed rule.** The backend owns the clock: last import time comes from the import batches;
`last_reminded_on` is stored per guild; at most one ping per guild per day in the guild's
timezone. The message says how many days remain before rows are lost (28 − days since the last
import), not only "please import". If the channel or staff role is not set, skip and show that in
the admin panel. Record each delivery result so a deleted channel or missing permission is visible.
Deleting an import batch moves the clock back and is audited.

### 🟡 Permissions, audit, rollout

* Permission for import, match, explain and create-transaction is not named. Siphoned uses
  `SiphonedIngest` plus `BankTransactionsCreate` for settlement. A new permission needs role grants.
* Every import, match, explanation, category change and created transaction writes an audit row.
* Additive migrations only (new tables, nullable columns) in every tenant schema; a per-guild
  feature flag, off by default. Rollback = flag off, data kept.
* The siphoned import has no tracing calls today; the new import logs one span per batch with
  guild, batch id, counts and duration.

### 🟡 CSV export

37 feature pages use `app-data-table`, most paginated on the server, so exporting the visible page
gives an incomplete file. Reviewers disagree on the fix:
* loop over the existing list endpoints at the maximum page size from the shared component, reusing
  the Blob download helper in `apps/frontend/src/app/features/admin/admin-finance.ts` (~1655–1821);
* or one streaming server endpoint per table with a row cap.

The first is much less code; tables over the cap would need the second. Either way: same filters
and permissions as the page, and cells starting with `=`, `+`, `-` or `@` are escaped (player names
and notes are user text; a spreadsheet would run them as formulas).

### 🟢 Smaller points

* Recognising expenses by reason text breaks if the game changes wording or language; the officer
  can always recategorise.
* One term per concept in UI, API and bot: row, link, unmatched, explained.
* Uncommitted work on the siphoned settlement debt touches `bank/src/service.rs` and the siphoned
  service. Start this work after it lands.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Weekly manual import of the Albion silver log per guild, idempotent across overlapping exports,
    keeping real duplicate rows.
  * Row categories (proposed, editable) and per-category period totals with the unlinked remainder.
  * Links to paid withdrawals, split bags and loot sales; manual linking; explain with note; create
    one transaction from a row.
  * Daily Discord reminder to the staff role from day 5, per guild, with days left before data loss.
  * Separately: market tax per split, guild fee default 15%; CSV export of tables.
* **Out-of-Scope Non-Goals:**
  * Any automatic fetch from the game (there is no API).
  * The game log changing Manager balances or creating income by itself.
  * Writing guild expenses into the member bank ledger.
  * Reconciling anything older than the first import.
  * XLSX export (Excel opens CSV).

## Key Decisions & Staging for Next Steps

Decided during ideation:
* The Manager is the source of truth; the game log is a check.
* In game, an officer withdraws and trades the silver to the member. One withdrawal may cover
  several splits, always for one member.
* Bags are deposited by anyone, never by the seller account; they are not taxed.
* Market tax applies only to the loot sold on the market by the seller account; per-guild setting,
  default 6%, editable. Existing guilds keep their fee; new guilds start at 15%.
* Reminder: from day 5, once a day until someone imports; per guild channel and staff role.
* Export: transactions and reconciliation first, then every table.

Proposed delivery order (each one a separate pull request):
1. Market tax per split (needed before loot sales can be matched).
2. Import + rows + categories + period totals + explain + reminder.
3. Suggested and manual links (payouts, bags, loot sales).
4. Create a transaction from a row.
5. CSV export in the shared table component.

Resolved after the review:
* **Existing guilds keep their stored fee.** A new per-guild market tax setting is added with
  default 6% for every guild, editable (a guild may pay 3%). The 15% fee default applies only to
  new guilds (code constant and settings default). Existing splits keep tax 0. Consequence: from
  the release on, new splits of a guild that does not touch its settings pay members less (fee +
  6% on loot). A guild whose fee already included the tax (Weaklings: 20% including 6%) must lower
  its fee to 15% itself. Admins should see a one-time notice in the finance settings explaining the
  new setting before their next split.
* **v1 includes automatic suggestions**, with the limits in the matching section (proposals only,
  ambiguous cases to an officer, bounded group size). Delivery steps 2 and 3 can ship together.
* **The Albion export uses UTC.** Rows are stored as UTC; day counts for the reminder use the
  guild's timezone.
