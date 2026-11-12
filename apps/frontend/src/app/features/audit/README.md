# Audit log

## Overview

`app-audit` shows the platform audit trail as a server-paginated `app-data-table` (time, actor, action, target), with an `app-filter-bar` above it for search, action type, target type, actor and date. Each row's details open in a dialog.

## Interface

- `AuditLog` requires `id`, `action`, and `created_at`, and permits `entity_type`, `entity_id`, `split_id`, `user_id`, and `details`.
- The component exposes no declared inputs or outputs. Filter and table state is mirrored to the URL (`q`, `action`, `entity`, `actor`, `from`, `to`, plus the table's `page`, `size`, `sort`).

## Invariants

- The server-mode table uses page size 20. Search (`q`, sent as `search`), action type (`action`), target type (`entity` sent as `entity_type`) and actor (`actor` sent as `user_id`) are server filters; any change restarts at page 1.
- Search input is debounced (300 ms). Stale responses from superseded requests are ignored.
- The actor picker is fed by `api/users` (first 100 members). If that list fails, the picker offers only "Anyone" and rows show `User #id`.
- Date filters (`from`, `to`) are client-side and narrow only the rows already loaded for the current page, because `GET /api/audit` has no date parameters. The filter bar says so.
- Rows are tracked by `id`. Failed loads show the shared error state and a generic toast; raw API text is never shown.

## Side Effects

Construction loads members and the first page. Filter changes update the URL with `replaceUrl` and reload. Refresh reloads the current query.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. No spec file covers this page yet.
