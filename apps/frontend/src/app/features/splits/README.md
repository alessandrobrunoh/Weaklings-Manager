# Splits

## Overview

This directory contains the split list/KPI page and split detail/editor for participant payouts, events, islands, and related transactions.

## Interface

- The list initializes paging, search, status, island, and sort state from route query parameters.
- The detail page (`split-detail.ts`, `.html`, `.css`) reads top to bottom as: header (back link, title, one primary action for the current state, edit and an overflow menu for the rest), overview (status chips, activity, location, author, dates), money flow (estimated value, bags, repairs, subtotal, fee, net, all in silver with explicit signs) beside the payout state and next step, a participants table (sortable, totals row, per-participant paid/pending state with icon and text, horizontal scroll inside the table on narrow screens), and the bank transactions table for users who may see it.
- The primary action is Complete & Credit while pending, Unarchive when archived, otherwise Edit. Not-completed, lost, archive and alliance share live in the overflow menu; not-completed, lost and archive ask for confirmation.
- Edit mode is one inline form (details, amounts with live net preview, roster). Validation errors are tied to their fields (`aria-invalid`, `aria-describedby`) and shown after a save attempt; on a non-completed split, adding or removing a participant is saved immediately.
- Load states: skeleton while loading, a distinct "split not found" state for HTTP 404, and a retryable error for other failures. Toasts never show raw API text; they use `splits.detail.error.*` keys.
- The exported participant-weight validator requires a nonempty list of positive weights.

## Invariants

- Create/edit/delete/island-management capabilities require corresponding permissions and a non-alliance tenant.
- Batch selection includes only pending, non-archived splits.
- Participant weights are relative shares (100 is one full share) and only need to be positive; the table shows each weight and its percentage of the total.
- Fees must be in the range 0–100. Detail edits are constrained by tenant/split state and separate transaction permissions.

## Side Effects

The pages load split lists/KPIs, create and update splits, complete batches, archive/unarchive, share/unshare, and update bank transactions. API failures and successful actions are surfaced with toasts and refreshes.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan used 300 selected lines per direct source within the directory byte cap.
