# Guild bank

## Overview

`app-bank` is the member-facing Guild Bank ledger for split earnings and personal withdrawal requests; the officer review workspace is separate.

## Interface

- `WithdrawalSelectableGroup` represents selectable transaction IDs and their status, amount, time, split, and optional guild details.
- Layout: a page header with one primary action (request withdrawal) and an overflow menu (refresh, and the officer review queue when permitted); a balance summary band (available, requested); then the ledger.
- Personal tenants see the movements table only. Alliance tenants get tabs: Movements, and Balance by guild (one row per member guild, with a totals row).
- Movements is a server-paginated `app-data-table` (page size 10). Its filters (search and status) sit in `app-filter-bar`; the table's own search box is hidden.
- The withdrawal dialog picks the guild with `app-select` (alliances with several guilds with credit) and lists requestable credits as checkboxes.

## Invariants

- The withdrawal-request action is disabled when pending total is nonpositive.
- The balance tab exists only for alliance tenants, and it lists only guilds returned by the balance endpoint.
- Negative transactions carry a clawback tag. Amounts use tabular `.num` figures; the unit is the localized "silver".
- Any filter change resets the movements table to page 1.
- Loading shows skeletons, a failed balance load shows an error with retry, and a failed movements load is shown by the table's error state. Empty results use the table's empty state.

## Side Effects

- Refresh (menu) reloads the balance and the movements.
- Request withdrawal opens the dialog and loads requestable credits, then posts `api/bank/transactions/withdraw`.
- The review queue menu item navigates to `/admin/withdrawals`.
- Filter changes sync the table's `page` query parameter (replace, not push).

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The spec covers the single header primary action, the summary band in place of KPI cards, credit selection that fits the net balance, and consolidation of split rows with Select all.
