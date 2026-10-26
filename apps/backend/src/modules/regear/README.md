# Regear module

## Overview

Regear implements the Call-To-Arms gear-reimbursement workflow: extraction of event-linked deaths, loadout pricing, member requests, and officer decisions.

## Interface

The module router provides death list/detail, regear request, self-service event/request creation, pending-request list and accept/reject, event death list, admin extraction, settings read/update, and member summary operations. The OpenAPI docs place the API under `/api/regear`.

Decision requests carry a final amount and breakdown (plus optional note) for acceptance, or an optional note for rejection. `RegearService` is the service boundary; credits are handled by a crate-private helper.

## Invariants

- Status values are `available`, `pending`, `approved`, and `rejected`; approved/rejected are terminal. Sources are `extracted` and `self_reported`.
- Only the linked owner can request an available death. Requesting consumes one credit and moves the death to `pending`.
- Acceptance requires a pending row and a final amount equal to the submitted breakdown total. A conditional status update prevents concurrent accept/reject success.
- Rejection requires pending status and a trimmed, non-empty note of at most 500 characters.
- Pricing de-duplicates item IDs and uses the configured location plus all-city fallback. Disabled slots remain in breakdowns but do not contribute to the total.
- Credit top-ups accrue by whole elapsed weeks and clamp to the weekly cap; consumption uses bonus credit before weekly credit.

## Side Effects

Requesting consumes credit and updates the death row transactionally, then attempts an audit log. Acceptance updates the death and inserts a pending `regear_credit` bank transaction in one transaction; after commit it attempts audit logs and may best-effort notify the recipient. Rejection updates the terminal state, then attempts audit/notification; it does not refund credit. Pricing calls the Albion data service; unavailable price responses are treated as empty results by the inspected pricing path.

## Verification

From the repository root, run `cargo test -p backend`.
