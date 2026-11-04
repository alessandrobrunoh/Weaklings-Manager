# Events module

## Overview

- This directory contains the events module's router, service, data models, sync, roster-hub, and fight-grouping code.
- Events carry an `event_kind` discriminant: `organized` (default; full comp/roster/split machinery, `comp_id` required) or `flash` (binary participation, no comp, `comp_id` NULL). Flash is never inferred from a NULL comp — `event::Model::is_flash()` / `organized_comp_id()` are the only guards; comp-shaped routes (roster, signup-options, splits, regear) return `409 Conflict` for flash rather than degrading.

## Interface

OpenAPI documents routes under `/api/events`. The surface includes:

- Event list/create/detail/update/delete, calendar, revisions, archive/unarchive, and Discord-role listing.
- New events default to requesting a VOD forum post. The migration leaves existing events `not_requested`; bot delivery uses an atomic pending → attempted claim before Discord creation, and `attempted` is not automatically retried because a lost Discord response can mean the post already exists.
- To reconcile an `attempted` VOD delivery, stop **all** bot workers for the tenant and inspect the configured Discord forum, including archived posts. If the post exists, call the bot-authenticated `POST /api/events/{id}/vod-forum-post/created` with `{"thread_id":"<existing Discord thread ID>"}`. If it does not exist, call the bot-authenticated `POST /api/events/{id}/vod-forum-post/retry-after-verification` with `{"confirm_no_post":true}` and then restart the workers. Never requeue while a worker may still be creating the post: this can produce a duplicate. Provide `X-Bot-Secret` through the operator's secure environment, not a committed file. A cancelled or archived event cannot be requeued.
- Signup options, roster reads/suggestions/live stream, seat assignment/clearing, swaps, autofill, and roster-role management.
- Participation and participant management.
- Remind/start/cancel/uncancel/stop lifecycle operations, and voice-channel configuration.
- Event XP is recorded only at successful completion: creator XP goes to the original creator and participation XP uses the participant list snapshotted at stop. Cancelled events and users removed before the snapshot do not receive these awards; alliance mirror events are not award authorities.
- Completion awards pin the active season satisfying `starts_at <= completion_time < ends_at` and capture configured rates at stop. Pending awards are retried from the durable tenant-local outbox; existing ledger history is preserved and historical events are not backfilled.
- Event battle list and replacement.

The bounded router excerpt registers event CRUD/lifecycle, roster, participation, voice-channel, and battle-related route families. Roster write requests carry `expected_roster_version`.

(Details pending/documentation failed) Full route authorization, request/response shapes, and mount behavior require a compliant bounded review.

## Invariants

- Event timestamps are RFC3339; mass time cannot be later than start. The comp expansion threshold is floor-based at 75% of capacity.
- `Fill` is a virtual roster role; roster writes carry `expected_roster_version`.
- (Details pending/documentation failed) Remaining validation and fight-grouping invariants require a compliant bounded review.

## Side Effects

Bounded handler excerpts show that create/update may mirror events to an alliance and participation/cancellation may synchronize alliance state after local operations.

(Details pending/documentation failed) Other database, notification, live-roster, and synchronization effects require a compliant bounded review.

## Verification

From the repository root, run `cargo test -p backend`.
