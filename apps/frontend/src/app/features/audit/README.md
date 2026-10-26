# Audit log

## Overview

`app-audit` displays an audit-log summary and a server-paginated table of actions, entities, users, details, and dates.

## Interface

- `AuditLog` requires `id`, `action`, and `created_at`, and permits entity, user, and details fields.
- The component exposes no declared inputs or outputs. Table query changes reload server data; the template provides retry and refresh actions.

## Invariants

- The server-mode table uses page size 20 and recognizes `action` and `entity` filters.
- Summary counts are derived from the currently held log rows; today's count compares the `created_at` prefix with the current UTC date.
- Rows are tracked by `id`.

## Side Effects

Construction and table changes start a load; refresh awaits it. The scanned beginning of `load()` sets loading/error state and begins building request parameters; later request behavior was outside the scan cap.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan covered only the first 300 lines of the implementation.
