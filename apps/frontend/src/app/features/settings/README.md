# Profile settings

## Overview

The `app-profile` page covers account identity, progression, activity, ledgers, battles, Albion linking, theme/language preferences, and Destiny Board data.

## Interface

- Tabs are `overview`, `destiny`, `ledgers`, `battles`, and `preferences`.
- The page renders loading, error/retry, and loaded states; the Destiny tab presents an editable `DestinyBoard`.
- The empty paginated battle helper starts at page 1 with limit 50.

## Invariants

Rendered content is gated by loading and failure state. Albion controls depend on link status; the tab names for ledgers, battles, and preferences are declared, but their content was beyond the inspected range.

## Side Effects

The visible template binds refresh/retry, tab changes, and Destiny Board retry/save actions to component handlers. Their effects were not established in the scanned portion.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan was limited to the first 300 lines of the 1,105-line implementation.
