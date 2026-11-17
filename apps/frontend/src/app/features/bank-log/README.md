# Bank log

## Overview

`app-bank-log` compares the in-game Albion guild bank log with the Manager's own records. The Manager is the source of truth; the game log is a second check. Each imported row ends up linked to a Manager record, explained in a note, or still open.

## Interface

- Route: `/admin/bank-log`, an admin panel (listed in the admin sidebar and hub). Guilds only; needs `banklog.view`, and its own `banklog` area in the permission matrix.
- Header: "Import log" appears only with `banklog.manage`; "Fill all suggested (n)" sits before it while rows have suggestions. "Refresh suggestions" and "Refresh" sit in the overflow menu.
- Fill all (`bank-log-fill-dialog.ts`): lists the best suggestion of every row (game row → Manager record, with its score). Matches scoring 50 or more start ticked; Confirm sends the ticked link ids in one request and toasts how many were confirmed or skipped.
- Before the first import: an onboarding card with the export steps and a link to the reminder settings.
- After it: a one-line import status (state chip, last import, days ago) with a meter of the 28-day game window; reminder problems link to `/admin/discord`.
- Overview: the covered range of game rows, compact from/to dates (empty means the last 28 UTC days), and a summary band (to review, reconciled, game in, game out, payout difference). The payout difference only appears when the period has imported rows.
- By category: a `.table` of the categories that have rows.
- Log rows: server-paged `app-data-table` with status and category filters, a search box and CSV export. Clicking a row opens the detail dialog.
- Row dialog (`bank-log-entry-dialog.ts`): the game row with its status and category, then confirmed links, or three tabs:
  - Match: ranked suggestion cards (score, amount fit, time gap) with Confirm/Reject, "Search again" for this row, and a finder with search, a ±1/7/30-day window, Bags/Loot sale for deposits and "Show already linked". Ticked records show their total against the row.
  - Explain: preset reasons and a note.
  - New transaction: a preview sentence, the member and the amount (needs `bank.transactions.create`; hidden once the row created one).
- Scores (`bank-log-score.ts`): 75+ Likely, 50+ Possible, below that Long shot.
- Imports: a table of pasted batches; officers with `banklog.manage` delete one from its row menu.

## Invariants

- Money values arrive as decimal strings and are converted with `Number` only for display and totals.
- A manual link's kind follows the row: withdrawals and payouts link as `payout`, bag deposits as `bags`, loot sales as `loot_sale`, anything else as `manual`. Candidate totals are compared with the matching split figure.
- Suggestions are confirmed or rejected through the link endpoints; confirmed links are removed with the same DELETE.
- The table does not sync to the URL. A period change remounts it so its page returns to 1.

## Side Effects

Every write (import, category, explanation, link, transaction, batch delete) posts through the API, toasts the result, then reloads the summary, the table and the open row.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. This feature has no spec file yet.
