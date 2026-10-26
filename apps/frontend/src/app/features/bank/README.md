# Guild bank

## Overview

`app-bank` is the member-facing Guild Bank ledger for split earnings and personal withdrawal requests; the officer review workspace is separate.

## Interface

- `WithdrawalSelectableGroup` represents selectable transaction IDs and their status, amount, time, split, and optional guild details.
- The page shows balance summaries, an alliance guild breakdown when applicable, and a server-paginated transaction table with page size 10.
- Header controls expose refresh and a withdrawal request; an officer-workspace link is permission-gated.

## Invariants

- The withdrawal-request action is disabled when pending total is nonpositive.
- Alliance breakdown requires alliance mode and at least one guild entry.
- Negative transactions receive a clawback indicator.

## Side Effects

Visible controls invoke refresh, withdrawal, and table-loading handlers. Their API and state effects were outside the 300-line scan range.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan was limited to the first 300 lines of the 1,100-line implementation.
