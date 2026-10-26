# Splits

## Overview

This directory contains the split list/KPI page and split detail/editor for participant payouts, events, islands, and related transactions.

## Interface

- The list initializes paging, search, status, island, and sort state from route query parameters.
- The detail page manages split state, edits, event/participant search, and transaction editing.
- The exported participant-weight validator requires a nonempty list of positive weights.

## Invariants

- Create/edit/delete/island-management capabilities require corresponding permissions and a non-alliance tenant.
- Batch selection includes only pending, non-archived splits.
- Fees must be in the range 0–100. Detail edits are constrained by tenant/split state and separate transaction permissions.

## Side Effects

The pages load split lists/KPIs, create and update splits, complete batches, archive/unarchive, share/unshare, and update bank transactions. API failures and successful actions are surfaced with toasts and refreshes.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan used 300 selected lines per direct source within the directory byte cap.
