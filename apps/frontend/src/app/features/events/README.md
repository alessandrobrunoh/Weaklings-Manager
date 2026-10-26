# Events

## Overview

This directory contains the events list and an event detail page with overview, roster, battles, and splits tabs.

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
