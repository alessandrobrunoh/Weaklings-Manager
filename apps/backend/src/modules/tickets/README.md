# Tickets module

## Overview

This module provides HTTP operations for creating, retrieving, and closing persisted Discord support tickets.

## Interface

Routes are relative to the router returned by `router()`; the full mount prefix is owned by the parent router.

| Route | Behavior |
|---|---|
| `POST /` | Creates a ticket from a thread ID and optional username. |
| `GET /active` | Returns the caller's active ticket, or `null` when none is found. |
| `POST /{id}/close` | Closes a ticket if the caller owns it or has the `ApplicationsManage` permission. |

`TicketView` exposes the ticket ID, Discord user ID, username, thread ID, and status. The entity also stores fields not included in that view.

## Invariants

- Creation trims the username and thread ID, rejects empty values, and rejects a new ticket when an open ticket already exists for the Discord ID.
- Active-ticket lookup filters by Discord ID and `open` status and returns the newest matching ID.
- Only open tickets can be closed. The close route authorizes the owner or requires `ApplicationsManage`; authorization is enforced by the route, not `TicketService`.
- The existing-ticket check is an application-level query; this module does not establish a database uniqueness constraint.

## Side Effects

Creating a ticket inserts a `discord_tickets` row with the caller identity, username snapshot, thread ID, and `open` status. Closing updates its status, close time, and closing actor. When the submitted username is absent or blank, the route supplies the caller's Discord ID as the username.

## Verification

From the repository root, run `cargo test -p backend`.
