# Warn register

## Overview

`app-warns` is the guild warn register and escalation queue. Officers issue and revoke member warns, and acknowledge threshold escalations after a manual kick. The register is a server-paginated `app-data-table` behind an `app-filter-bar`; the summary sits in an `app-summary-band`.

## Interface

- `WarnsTab` is `register | escalations`, switched with `app-tabs` and stored in the `tab` query param.
- The URL is the single source of truth: `tab`, `search`, `severity`, `status`, and the table's `page`, `size` and `sort`. Every query change reloads the page, so a filtered view can be shared.
- `WarnStatusFilter` is `all | active | revoked` (segmented control in the filter bar's primary slot).
- `IssueDraft` carries user, reason, severity, multiplier and expiry fields; the issue dialog is the primary action.
- Row menus (`app-menu`) hold revoke (register, danger, confirmed in a dialog) and acknowledge (escalations).

## Invariants

- The issue action and the revoke menu are shown only for users with `warns.issue`; otherwise a permission note is displayed.
- Search matches warn reasons on the server. The search box is debounced before it writes the URL.
- The summary counts come from the server total (`warnTotal`, `escalationTotal`); the "active on this page" and "open on this page" figures count only the loaded page, because the API returns no per-state totals.
- A stale response never overwrites a newer one (request id guard).
- Warns have no expiry of their own; "Revoked" is the end state. Only the XP multiplier has an expiry date.

## Side Effects

Issue, revoke and acknowledge call `api/warns`, `api/warns/:id/revoke` and `api/warns/escalations/:id/ack`, then reload. Member options for the issue dialog come from `api/users`. Toasts use i18n keys only.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The page has no spec file yet.
