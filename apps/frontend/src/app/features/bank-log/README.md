# Bank log

## Overview

`app-bank-log` compares the in-game Albion guild bank log with the Manager's own records. The Manager is the source of truth; the game log is a second check. Each imported row ends up linked to a Manager record, explained in a note, or still open.

## Interface

- Header: "Import log" and "Refresh suggestions" appear only with `bank.log.manage`. Refresh sits in the overflow menu.
- Import status card: last import, days since, days before rows leave the game log. Warning tone when the import is due, danger tone when rows are being lost. A hint links to `/admin/discord` when reminders are not configured.
- Period: from/to dates (empty means the last 28 UTC days), then the summary band and a per-category table.
- Log rows: server-paged `app-data-table` with status and category filters and a search box. Clicking a row opens the detail dialog.
- Detail dialog: row facts, category, suggested and confirmed links, manual linking against candidate Manager records, explanation notes, and transaction creation (needs `bank.log.manage` and `bank.transactions.create`).
- Imports: collapsible list of pasted batches; officers with `bank.log.manage` can delete one.

## Invariants

- Money values arrive as decimal strings and are converted with `Number` only for display and totals.
- A manual link's kind follows the row: withdrawals and payouts link as `payout`, bag deposits as `bags`, loot sales as `loot_sale`, anything else as `manual`. Candidate totals are compared with the matching split figure.
- Suggestions are confirmed or rejected through the link endpoints; confirmed links are removed with the same DELETE.
- The table does not sync to the URL. A period change remounts it so its page returns to 1.

## Side Effects

Every write (import, category, explanation, link, transaction, batch delete) posts through the API, toasts the result, then reloads the summary, the table and the open row.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. This feature has no spec file yet.
