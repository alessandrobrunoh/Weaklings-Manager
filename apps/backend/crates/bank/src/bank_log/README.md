# Albion bank log module

## Overview

Officers import the in-game guild bank silver log (the game keeps 28 days of it) and reconcile each row against the Manager's own records. The Manager stays the source of truth: the game log is a second check that surfaces missing payouts, unrecorded bag deposits, loot sales by the shared seller accounts and guild expenses.

## Interface

Mounted inside the bank router at `/api/bank/log/*`, so the `bank` feature gate applies. Alliance tenants are refused. Read routes need `banklog.view`; mutations need `banklog.manage`; `POST /entries/{id}/transaction` also needs `bank.transactions.create`.

- `POST /import` takes `{ rows: [{ Date, Player, Reason, Amount }] }` exactly as copied from the game (UTC dates, at most 5,000 rows).
- `POST /suggestions/refresh` recomputes automatic suggestions for open rows; `POST /entries/{id}/suggestions/refresh` does it for one row, so a row left unmatched can be searched again after the missing record is added.
- `GET /suggestions/best` returns the best unconfirmed suggestion per row, with no two sharing a row or a payout, plus `rows_left_out` (rows whose best suggestion lost to a better one). `POST /suggestions/confirm` takes `{ link_ids }` (at most 2,000) and confirms them in order in one transaction, skipping links already confirmed or that collide with an earlier one.
- `GET /entries` (filters: `from`, `to`, `status`, `category`, `search`; paginated), `GET/PATCH /entries/{id}` (category, note, explained).
- `GET /entries/{id}/candidates` (`search`, `days` 1–60, `value` = `bags`|`loot_sale`, `include_linked`) lists scored records to link by hand: payout batches and their single rows for a withdrawal, splits within ±`days` for a deposit. Sorted by score, then time gap; at most 60.
- `POST /entries/{id}/transaction` creates the missing Manager row: a withdrawal becomes a paid-out `withdrawn` row for the chosen member; a deposit becomes a donation to the Guild Bank.
- `POST /links`, `POST /links/{id}/confirm`, `DELETE /links/{id}`.
- `GET /summary` (default window: last 28 UTC days), `GET /batches`, `DELETE /batches/{batch_id}`.

## Invariants

- Row identity is `(occurred_at, player_key, reason, amount, occurrence)`. Identical lines in the same minute get occurrence 1, 2, …; an import only inserts occurrences beyond those already stored, so overlapping imports are idempotent while real duplicates survive.
- Categories: `payout`, `bags`, `loot_sale` (deposits by a configured seller account, `guild_settings.bank_log_seller_accounts`), `guild_expense` (auto-explained), `donation`, `other`.
- Status is derived: `matched` when a confirmed link covers the row, `explained` when it has a note marked explained, `suggested` when an unconfirmed suggestion exists, otherwise `unmatched`.
- Suggestions (`matcher.rs`) carry a 0–100 `score` from how close the amount and the time are (time score halves after 12 hours, 7 days for loot sales; each extra record costs 3 points). Below 20 is dropped, and each row keeps its best 3.
  - Payouts: a withdrawal row's player is the paying officer, not the recipient, so it matches one member's accepted withdrawals from 7 days before to 2 days after the row, within 1%. Rows accepted within 2 minutes of each other (or sharing a request second) form a batch; any 1–4 of the member's 10 nearest rows are also tried.
  - Bags: deposits within ±3 days of the split's creation or finalization. Deposits in the same hour that add up to the bags total match exactly; a deposit that only covers part of it gets a partial suggestion (score capped at 55). A split stays open until its links add up to its value.
  - Loot sales: deposits by seller accounts from 1 day before to 45 days after the split, within 5% of the expected sale (loot after market tax).
- Confirming a link drops the other suggestions for its rows and payouts, and for its splits once they are fully covered.
- A row creates at most one Manager transaction, ever. A batch with such a row cannot be deleted.
- Mutations are serialized per tenant with a PostgreSQL advisory transaction lock.

## Side Effects

Imports, links, explanations, created transactions and batch deletions are audited. `reminder.rs` runs from a per-tenant worker every 30 minutes: from day 5 after the last import it pings the staff role (`roles.is_staff` with a Discord role) once per UTC day in `guild_settings.discord_bank_log_channel_id`, saying how many days are left before rows leave the game log. When it cannot send, it stores `missing_channel`, `missing_staff_role`, `missing_bot_token` or `discord_refused` in `bank_log_reminder_error` for the admin page.

## Verification

From `apps/backend`, run `cargo test -p backend-bank`.
