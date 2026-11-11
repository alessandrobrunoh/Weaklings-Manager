# Events

## Overview

This directory contains the events list and an event detail page with Overview, Parties, Battles, and Splits tabs.

- **Overview** is the member view: "your spot" (`detail/event-my-spot.ts`: join, waiting for a seat, or party/seat/role with the build's equipment and abilities) and the role board (`detail/event-role-board.ts`: every role and build, who holds each seat, how many are open, and who is waiting).
- **Parties** is the live board: the waiting list beside every party side by side. Officers drag players between seats, parties and the waiting list, or use Assign / Swap / Move to bench; the socket keeps every viewer in sync.
- **Parties** has a manager-only "Assign players" / "Structure" switch. Structure (`detail/event-party-structure.ts`) is one card per party (label, comp, role counts, its extra roles, move up/down, Remove with a confirm, never the last party) plus an "Add party" card; each write sends the roster version, then the page reloads, and a comp change or removal toasts how many members went back to the waiting list.
- Every event party has its own comp, and a comp over 20 seats spans several board parties: headings read "Brawl 1/2". Seat keys are `party:{party_id}:build:{build_id}:{n}`; the UI treats them as opaque. The signup dialog offers the union of the parties' builds, grouped per party using `GET /api/events/{id}/signup-options`.
- **Battles** shows the performance and intel cards above the linked battles.
- `detail/roster-lobby.ts` holds the pure seat grouping (by role, then build), role colours/labels, and the party heading / reorder helpers shared by the views.

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
