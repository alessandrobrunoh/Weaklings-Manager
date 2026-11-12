# Events

## Overview

This directory contains the events list and an event detail page with Overview, Parties, Battles, and Splits tabs.

- **Overview** is the member view: "your spot" (`detail/event-my-spot.ts`: join, waiting for a seat, or party/seat/role with the build's equipment and abilities) and the role board (`detail/event-role-board.ts`: every role and build, who holds each seat, how many are open, and who is waiting).
- **Parties** is the live board: the waiting list beside every party side by side. Officers drag players between seats, parties and the waiting list, or use Assign / Swap / Move to bench; the socket keeps every viewer in sync.
- **Parties** has a manager-only "Assign players" / "Structure" switch. Structure (`detail/event-party-structure.ts`) is one card per party (label, comp, role counts, its extra roles, move up/down, Remove with a confirm, never the last party) plus an "Add party" card; each write sends the roster version, then the page reloads, and a comp change or removal toasts how many members went back to the waiting list.
- Every event party has its own comp, and a comp over 20 seats spans several board parties: headings read "Brawl 1/2". Seat keys are `party:{party_id}:build:{build_id}:{n}`; the UI treats them as opaque. The signup dialog offers the union of the parties' builds, grouped per party using `GET /api/events/{id}/signup-options`.
- **Battles** shows the performance and intel cards above the linked battles.
- `detail/roster-lobby.ts` holds the pure seat grouping (by role, then build), role colours/labels, and the party heading / reorder helpers shared by the views.

## New event dialog

The "New event" dialog (`events.ts`) is one form split into labelled sections, each with an `h3`:

- **Details**: name (required) and description.
- **Schedule**: date, mass time and start time (all required). A note under the fields states the local timezone and offset and the UTC equivalent of mass and start, since Discord renders the announcement in each member's own timezone.
- **Roster**: composition (Mine / Everyone list, required) and the optional player cap.
- **Discord**: collapsed by default behind a disclosure button whose summary line shows what is set (pinged roles, alliance sync, VOD post). Holds the roles to ping, the alliance sync (only for a guild in an active alliance) and the VOD forum post, which is off by default (the API default is off too).
- **Extras**: call to arms, regear and the correlated split; its island and tab selects appear only when the split is checked.

Validation is inline and tied to fields (`aria-invalid`, `aria-describedby` to the hint and the error). A field shows its error after it was left, and every error shows after the first submit; the submit then puts focus on a summary whose entries move focus to their field. The form is `novalidate`, so no browser bubbles compete with it. Focus starts on the name field and returns to the opener on close. The dialog body scrolls while the footer (Cancel / Create) stays in view, and every grid collapses to one column on phones.

## Interface

- The list component manages paginated events, search/status filters, sorting, load state, and summary counts.
- The detail page uses the selected event, roster operations, compositions, linked battles, and realtime roster service.
- `CompPartyGroup` describes party number/name, slots, and filled/total counts.

## Invariants

- Event creation requires a nonblank title, positive composition ID, valid optional player cap, a date that is not in the past, valid combined date/time values, and mass time no later than start time. A correlated split also requires an island and tab.
- The VOD forum post is opt-in: the dialog and the API both default it to off.
- Detail loads discard stale responses by generation and event ID. Roster mutations include the current `roster_version`.
- Event actions use permission or ownership checks in the UI.

## Side Effects

The list loads events and stats, creates and archives/restores events, shows toasts, and navigates to a created event. The detail page loads event/roster/composition data, connects realtime roster updates, and posts or deletes mutations.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Source inspection used bounded excerpts within the per-file and directory byte caps.
