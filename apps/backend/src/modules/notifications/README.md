# Notifications module

## Overview

The notifications module implements an in-app inbox and broadcast fan-out. It also exposes helpers for creating notifications for selected recipients.

## Interface

| Method and path | Behavior |
|---|---|
| `GET /api/notifications` | Lists the caller's inbox with optional page, limit, and unread filters. |
| `GET /api/notifications/unread-count` | Returns the caller's unread count. |
| `POST /api/notifications/{id}/read` | Marks one caller-owned notification read. |
| `POST /api/notifications/read-all` | Marks the caller's unread notifications read. |
| `POST /api/notifications/broadcast` | Broadcasts an announcement; requires `NotificationsBroadcast`. |

`NotificationService` provides list, count, read, broadcast, and notify operations. `NotifySpec` describes kind, recipients, content, optional link/source, and optional actor.

## Invariants

- Notification kinds map to stable snake-case database keys. `EventCreated` and `EventReminder1h` do not queue Discord DMs; other kinds do.
- Listing is scoped to the caller and newest first. Mark-read requires both notification ID and caller ID, returns not-found for an unowned row, and leaves already-read rows unchanged.
- Insert fan-out ignores conflicts on `(user_id, kind, source_type, source_id)`.
- Broadcast title/body are documented as trimmed and non-empty, with maxima of 120 and 2000 characters respectively.

## Side Effects

Broadcast opens a transaction, inserts the broadcast, loads recipients, inserts notification rows, and commits. `notify` inserts per-recipient rows and sets the initial DM status to `pending` for kinds that queue DMs, otherwise `skipped`; this module's inspected service code does not send Discord messages. `notify_best_effort` skips empty recipient lists and logs write errors. Read operations update `read_at`.

## Verification

From the repository root, run `cargo test -p backend`.
