# Regear requests

## Overview

The direct source filenames and their opening comments identify a regear list, detail page, and self-service request page.

## Interface

The bounded opening sections establish those three page responsibilities only. Exact component inputs/outputs, API contracts, and request parameters are not enumerated here.

## Invariants

No business invariant is asserted because the directory could not be scanned within its 50 KB aggregate source limit.

## Side Effects

No runtime effects are asserted; the relevant implementations were not documented from a compliant bounded scan.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan failure:** the scout read 68,948 bytes across three files (576, 556, and 735 lines), exceeding both the per-file line and directory byte limits. This README retains only the high-level page roles documented in the opening portions; no further source was inspected for this follow-up.
