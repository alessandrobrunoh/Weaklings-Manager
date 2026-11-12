# Siphoned balances

## Overview

`app-siphoned` shows siphoned energy: a summary of the whole guild, the per-member balances, the raw ledger entries and the import batches. Officers with `siphoned.ingest` can import Albion exports, add or edit manual entries and settle debts.

## Interface

- Header: refresh sits in the overflow menu; "Add manual entry" (outline) and "Import export" (primary) appear only with `siphoned.ingest`.
- Section tabs (`app-tabs`, underline): `balances` (default), `entries`, `batches`.
- Summary band (`app-summary-band`): total deposited, total withdrawn, net, and members in debt. Always guild-wide.
- Balances: `app-filter-bar` with a search box and a segmented Balance switch (All / In debt / In credit). The `app-data-table` is client-side, sortable on every numeric column, with a totals row that adds up the members in the current view.
- Entries: server-paged `app-data-table` with its own search and reason filter, URL-synced (`reason` filter key).
- Batches: `app-data-table` of immutable imports, with delete for officers.

## Invariants

- All members are fetched once (up to 1,000 balances) on every load. The summary band and the balances table both derive from that list; the table never pages on the server.
- Debt is a negative net. "Settle debt" is shown only for negative nets and only with `siphoned.ingest` and `bank.transactions.create`; it creates a bank transaction through a confirmed quote.
- Summary figures are computed over every member. The balances totals row is computed over the members currently shown.
- The entries query recognizes a `reason` filter. The batch load uses the first batch's `ingested_at` for "last updated", which assumes the API returns batches newest first.

## Side Effects

Refresh reloads the balances and the batch timestamp. Ingest, entry saves, entry deletes, batch deletes and settlement post or delete through the API, close their dialogs, show toasts and reload the page data.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. This feature has no spec file yet.
