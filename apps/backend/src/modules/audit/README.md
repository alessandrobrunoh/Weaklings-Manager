# Audit module

## Overview

The audit module exposes an audit-log listing endpoint and service operations for listing and writing audit rows.

## Interface

- `GET /` (documented as `GET /api/audit`) requires `Permission::AuditView` and returns filtered, paginated audit items.
- `AuditService::list` accepts pagination, action/entity/user filters, action search, and sort/order parameters.
- `AuditService::log` accepts an action, optional entity type/ID, optional user ID, and optional JSON details.
- The `audit_logs` entity stores the action and timestamp with optional entity, split, user, and details fields.

## Invariants

- Blank action and entity-type filters are ignored; nonblank values are trimmed and matched exactly. Search is a case-insensitive substring of `action`; entity and user IDs match exactly.
- Sort keys are restricted to `created_at`, `action`, `entity_type`, and `user_id`; `id` is a secondary sort key in the selected direction.
- `split_id` uses integer `details.split_id` when present, otherwise `entity_id` only when `entity_type` is exactly `SPLIT`.
- The User relation uses `ON DELETE SET NULL`.
- The directory also contains a middleware source file, but the module entrypoint does not declare it; its visible implementation does not persist audit rows.

## Side Effects

Listing reads counts and the selected database page. `AuditService::log` inserts a row and may send a Discord embed when its channel and bot token are configured. Its notification call result is not propagated at the call site. Transaction audit entries can enter a transaction-spam notification branch.

## Verification

From the repository root, run `cargo test -p backend`.
