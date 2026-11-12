# Regear requests

## Overview

`regears.ts` is the queue and history list. `regear-detail.ts` is one death's page: an entity header with the status chip, the primary action (Request for the member, Accept for an officer on a pending request) and a Reject menu entry for officers, the key figures band, the requested items table (unit price, line value, included state), the death and battle context, and the history (killed, requested, decided with the officer note, bank credited). Officer accept and reject run in dialogs. `regear-new-request.ts` is the self-service request page.

## Interface

The bounded opening sections establish those three page responsibilities only. Exact component inputs/outputs, API contracts, and request parameters are not enumerated here.

## Invariants

No business invariant is asserted because the directory could not be scanned within its 50 KB aggregate source limit.

## Side Effects

No runtime effects are asserted; the relevant implementations were not documented from a compliant bounded scan.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan failure:** the scout read 68,948 bytes across three files (576, 556, and 735 lines), exceeding both the per-file line and directory byte limits. This README retains only the high-level page roles documented in the opening portions; no further source was inspected for this follow-up.
