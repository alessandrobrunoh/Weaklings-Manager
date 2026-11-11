# Events

## Overview

This directory contains the events list and an event detail page with Overview, Parties, Battles, and Splits tabs.

- **Overview** is the member view: "your spot" (`detail/event-my-spot.ts`: join, waiting for a seat, or party/seat/role with the build's equipment and abilities) and the role board (`detail/event-role-board.ts`: every role and build, who holds each seat, how many are open, and who is waiting).
- **Parties** is the live board: the waiting list beside every party side by side. Officers drag players between seats, parties and the waiting list, or use Assign / Swap / Move to bench; the socket keeps every viewer in sync.
- **Battles** shows the performance and intel cards above the linked battles.
- `detail/roster-lobby.ts` holds the pure seat grouping (by role, then build) and role colours/labels shared by both views.

## Interface

- The list component manages paginated events, search/status filters, sorting, load state, and summary counts.
- The detail page uses the selected event, roster operations, compositions, linked battles, and realtime roster service.
- `CompPartyGroup` describes party number/name, slots, and filled/total counts.

## Invariants

- Event creation requires a nonblank title, positive composition ID, valid optional player cap, valid combined date/time values, and mass time no later than start time.
- Detail loads discard stale responses by generation and event ID. Roster mutations include the current `roster_version`.
- Event actions use permission or ownership checks in the UI.

## Side Effects

The list loads events and stats, creates and archives/restores events, shows toasts, and navigates to a created event. The detail page loads event/roster/composition data, connects realtime roster updates, and posts or deletes mutations.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Source inspection used bounded excerpts within the per-file and directory byte caps.
