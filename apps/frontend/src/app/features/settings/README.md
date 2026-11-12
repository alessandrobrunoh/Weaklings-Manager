# Profile settings

## Overview

The `app-profile` page covers account identity, progression, activity, ledgers, battles, Albion linking, theme/language preferences, and the member's declared weapons.

## Interface

- Tabs are `overview`, `weapons`, `ledgers`, `battles`, and `preferences`.
- The page renders loading, error/retry, and loaded states; the Weapons tab (`/profile?tab=weapons`) presents the editable `app-weapon-roster` (My weapons).
- The empty paginated battle helper starts at page 1 with limit 50.

## Invariants

Rendered content is gated by loading and failure state. Albion controls depend on link status; the tab names for ledgers, battles, and preferences are declared, but their content was beyond the inspected range.

## Side Effects

The visible template binds refresh/retry, and tab changes to component handlers. Their effects were not established in the scanned portion.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan was limited to the first 300 lines of the 1,105-line implementation.
