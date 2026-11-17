# Albion bank log module

## Overview

Officers import the in-game guild bank silver log (the game keeps 28 days of it) and reconcile each row against the Manager's own records. The Manager stays the source of truth: the game log is a second check that surfaces missing payouts, unrecorded bag deposits, loot sales by the shared seller accounts and guild expenses.

## Interface

Mounted inside the bank router at `/api/bank/log/*`, so the `bank` feature gate applies. Alliance tenants are refused. Read routes need `bank.log.view`; mutations need `bank.log.manage`; `POST /entries/{id}/transaction` also needs `bank.transactions.create`.

- `POST /import` takes `{ rows: [{ Date, Player, Reason, Amount }] }` exactly as copied from the game (UTC dates, at most 5,000 rows).
- `POST /suggestions/refresh` recomputes automatic suggestions for open rows.
- `GET /entries` (filters: `from`, `to`, `status`, `category`, `search`; paginated), `GET/PATCH /entries/{id}` (category, note, explained).
- `GET /entries/{id}/candidates` lists payouts (for withdrawals) or splits (for deposits) to link by hand.
- `POST /entries/{id}/transaction` creates the missing Manager row: a withdrawal becomes a paid-out `withdrawn` row for the chosen member; a deposit becomes a donation to the Guild Bank.
- `POST /links`, `POST /links/{id}/confirm`, `DELETE /links/{id}`.
- `GET /summary` (default window: last 28 UTC days), `GET /batches`, `DELETE /batches/{batch_id}`.

## Invariants

- Row identity is `(occurred_at, player_key, reason, amount, occurrence)`. Identical lines in the same minute get occurrence 1, 2, …; an import only inserts occurrences beyond those already stored, so overlapping imports are idempotent while real duplicates survive.
- Categories: `payout`, `bags`, `loot_sale` (deposits by a configured seller account, `guild_settings.bank_log_seller_accounts`), `guild_expense` (auto-explained), `donation`, `other`.
- Status is derived: `matched` when a confirmed link covers the row, `explained` when it has a note marked explained, `suggested` when an unconfirmed suggestion exists, otherwise `unmatched`.
- Suggestions (`matcher.rs`): payouts match the same silver amount from 2 days before to 7 days after acceptance; bag deposits match the exact split bags total within 30 days, grouping nearby deposits; loot sales match within 5% of the split's expected sale (loot after market tax) within 45 days. Confirming or creating a link drops competing suggestions.
- A row creates at most one Manager transaction, ever. A batch with such a row cannot be deleted.
- Mutations are serialized per tenant with a PostgreSQL advisory transaction lock.

## Side Effects

Imports, links, explanations, created transactions and batch deletions are audited. `reminder.rs` runs from a per-tenant worker every 30 minutes: from day 5 after the last import it pings the staff role (`roles.is_staff` with a Discord role) once per UTC day in `guild_settings.discord_bank_log_channel_id`, saying how many days are left before rows leave the game log. When it cannot send, it stores `missing_channel`, `missing_staff_role`, `missing_bot_token` or `discord_refused` in `bank_log_reminder_error` for the admin page.

## Verification

From `apps/backend`, run `cargo test -p backend-bank`.
