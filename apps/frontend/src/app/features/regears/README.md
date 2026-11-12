# Regear requests

## Overview

`regears.ts` is the queue and history list. `regear-detail.ts` is one death's page: an entity header with the status chip, the primary action (Request for the member, Accept for an officer on a pending request) and a Reject menu entry for officers, the key figures band, the requested items table (unit price, line value, included state), the death and battle context, and the history (killed, requested, decided with the officer note, bank credited). Officer accept and reject run in dialogs. `regear-new-request.ts` is the self-service request page.

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

## Regears list (`regears.ts`)

- Section tabs (`app-tabs`, underline in the page header): Mine, and Queue and History for officers. The section is kept in `?tab=`.
- Summary band (`app-summary-band`) with totals per section: budget and pending count (Mine), awaiting count and pending estimate value (Queue), approved and rejected counts (History), plus the total credited to the Guild Bank. Figures come from one unpaginated fetch (up to 1000 rows of the section scope).
- Filter bar (`app-filter-bar`): search (sent to the server, debounced) and a segmented status switch with counts. The queue has no status switch because it is always pending.
- `app-data-table`, server mode, rows open the detail page. Columns: member (name links to the detail page, build and self-reported tag), event, status (`app-status-chip`), items value (estimate, plus the final amount once approved), killed date, actions.
- Officer actions on a pending row: Approve (primary button) opens a confirmation with the included-slot estimate total, then posts the accept request with the auto-estimate breakdown; Reject sits in the row `app-menu` and requires a reason in a dialog. Price or slot edits still happen on the detail page.
- Member action on an available row: Request (primary button).
- Header: "New regear request" is the only primary action; refresh and settings live in the page menu.
- Errors toast a translated message only; the API text is never shown.
