# Albion link gate

## Overview

`AlbionLinkGate` loads the current Albion character-link state and presents a search-and-link dialog when the account is unlinked, or a "waiting for an officer" card while its link request is pending approval.

## Interface

- Selector: `app-albion-link-gate`; no inputs are declared.
- `linked` emits the resulting `AlbionLinkStatus` after a successful link.
- The component uses `ApiService`, `ToastService`, and `TranslateService`.

## Invariants

- The dialog is shown only after loading completes and the status says the user is unlinked or has a pending request.
- A member's link is only a request until an officer approves it: `linked` is emitted only when the backend reports `linked: true`, and the waiting card re-checks every 30 s, on demand, and lets the member withdraw (`DELETE api/albion/link`) to pick another character.
- Blank trimmed searches and searches already in progress are ignored.
- A failed initial status request leaves the status `null`, so the linked-false dialog condition does not match.

## Side Effects

Construction requests `api/albion/link/me`; search requests `api/albion/search`; linking posts to `api/albion/link`. Errors and success are reported with toasts, and successful linking emits `linked`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
