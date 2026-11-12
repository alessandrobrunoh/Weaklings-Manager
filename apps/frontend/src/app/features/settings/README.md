# Profile and settings

## Overview

The `app-profile` page (route `/profile`) is the member's own workspace. Its tabs cover season progression and activity (Overview), the editable self weapons roster, personal bank and siphoned energy ledgers, recent battles, and Settings.

## Interface

- Tabs are `overview`, `weapons`, `ledgers`, `battles`, and `settings`, switched with the page-level `app-tabs`. `/profile?tab=weapons` opens My weapons.
- Settings is grouped into four sections, each with a heading and helper text:
  - Profile: username, email, role and user ID, read only.
  - Albion character: link status and the link or unlink action. Linking uses a remote `app-searchable-select` in a dialog.
  - Appearance: theme as a segmented `app-tabs` (light, dark, system).
  - Language: `app-select` over the supported languages.
- Theme and language are saved in the browser only, and the helper text says so. Notifications are not part of this page; no setting exists for them.
- Loading uses the detail skeleton. A failed load shows the error state with retry.

## Invariants

- Rendered content is gated by loading, then error, then data.
- The Albion lookup starts at two characters and debounces 300 ms. Only the latest request's results are shown, and a failed lookup shows an i18n toast, never the API message.
- Picking a lookup result links that character. Unlink always goes through a confirmation dialog.
- Albion controls depend on the link status returned by `api/albion/link/me`.

## Side Effects

- Refresh and retry re-run `load()`, which reads bank balance and transactions, Albion link status, battles, metrics, regear budget and progression, then siphoned balances when the user has `siphoned.view`.
- Linking and unlinking call `api/albion/link` (POST and DELETE) and reload the page data.
- Theme and language writes go to `localStorage` through `ThemeService` and `TranslateService`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The spec covers the My weapons tab (tab present, `api/users/me/weapons` loaded on open) and the Settings sections.
