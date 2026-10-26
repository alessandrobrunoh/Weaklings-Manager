# Siphoned balances

## Overview

`app-siphoned` provides balances, entries, and batches views for siphoned funds, including ingestion and entry maintenance.

## Interface

- The view toggle selects `balances`, `entries`, or `batches`; initial view is balances.
- Balance and entry table state can be initialized from route query parameters, with default page size 10.
- The page loads balances, entries, and batches and exposes ingest, create, and update actions.

## Invariants

- Summary totals derive from a separate fetch capped at 1,000 balance records, not the currently displayed page.
- The entry query recognizes a `reason` filter.
- The scanned batch load uses the first batch's `ingested_at` for `lastUpdatedAt`; correctness as latest depends on API ordering.

## Side Effects

Refresh loads view data and stats concurrently. Ingest and entry saves post/put API requests, reset forms, show toasts, and reload current data.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan used selected source ranges totaling 300 lines within the directory byte cap.
