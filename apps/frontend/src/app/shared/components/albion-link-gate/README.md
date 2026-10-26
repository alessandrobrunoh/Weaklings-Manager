# Albion link gate

## Overview

`AlbionLinkGate` loads the current Albion character-link state and presents a search-and-link dialog when the account is unlinked.

## Interface

- Selector: `app-albion-link-gate`; no inputs are declared.
- `linked` emits the resulting `AlbionLinkStatus` after a successful link.
- The component uses `ApiService`, `ToastService`, and `TranslateService`.

## Invariants

- The dialog is shown only after loading completes and the status says the user is unlinked.
- Blank trimmed searches and searches already in progress are ignored.
- A failed initial status request leaves the status `null`, so the linked-false dialog condition does not match.

## Side Effects

Construction requests `api/albion/link/me`; search requests `api/albion/search`; linking posts to `api/albion/link`. Errors and success are reported with toasts, and successful linking emits `linked`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
