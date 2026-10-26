# Events module

## Overview

This directory contains the events module's router, service, data models, sync, roster-hub, and fight-grouping code.

## Interface

OpenAPI documents routes under `/api/events`. The surface includes:

- Event list/create/detail/update/delete, calendar, revisions, archive/unarchive, and Discord-role listing.
- Signup options, roster reads/suggestions/live stream, seat assignment/clearing, swaps, autofill, and roster-role management.
- Participation and participant management.
- Remind/start/cancel/uncancel/stop lifecycle operations, and voice-channel configuration.
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
