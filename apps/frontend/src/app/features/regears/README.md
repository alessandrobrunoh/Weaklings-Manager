# Regear requests

## Overview

The direct source filenames and their opening comments identify a regear list, detail page, and self-service request page.

## Interface

The bounded opening sections establish those three page responsibilities only. Exact component inputs/outputs, API contracts, and request parameters are not enumerated here.

## Invariants

No business invariant is asserted because the directory could not be scanned within its 50 KB aggregate source limit.

## Self-service request page (`regear-new-request.ts`)

Four numbered steps on one page, single column at every width: 1 event (radio group, first event preselected), 2 build (radio group when the comp has several builds, sign-up build preselected), 3 item overrides (`app-equipment-grid`), 4 review (`app-summary-band` with the requests used and the budget left after, then the submit button). Submit opens a confirmation dialog because the request cannot be undone. Steps 3 and 4 appear only once the build has loaded; a failed load shows an inline error with retry. Bonus requests are spent before weekly ones in the review figures.

## Side Effects

The page reads `api/regear/self-service/events`, `api/regear/me/summary` and `api/comps/builds/{id}`, and posts `api/regear/self-service` on confirm. Errors show translated text only; raw API messages are never displayed.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan failure:** the scout read 68,948 bytes across three files (576, 556, and 735 lines), exceeding both the per-file line and directory byte limits. This README retains only the high-level page roles documented in the opening portions; no further source was inspected for this follow-up.
