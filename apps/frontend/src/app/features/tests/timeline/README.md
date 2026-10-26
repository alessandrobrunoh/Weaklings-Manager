# Combat test timelines

## Overview

This submodule contains pure timeline calculation helpers and the editor, cast table, spell library, and selected-cast inspector for combat-test scenarios.

## Interface

- `TimelineEditor` accepts scenario/timing metadata and emits cast create/move/remove/select and run-requested events.
- `CastTable`, `TimelineSpellLibrary`, and `TimelineInspector` accept scenario or selection data and emit edits, selections, drag events, close, and build/weapon requests.
- `scenario-timeline.ts` exports unit expansion, snapping, coordinate conversion, lane construction, result lookup, HP replay, and cast/land-time helpers.

## Invariants

- Cast times are clamped to zero and snapped to tenths; normalized casts sort target IDs and default attacker style to melee.
- Timeline duration is at least 10 seconds and extends beyond relevant cast/landing/death/drag times.
- HP replay floors displayed HP at zero and flags a mismatch when replayed final HP differs from reported remaining HP by more than one.

## Side Effects

Components communicate edits through outputs. The editor maintains local UI/drag state and handles document pointer events; spell drag-and-drop transfers a JSON payload as `text/plain`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan stayed within 50 KB; several larger files were read in selected excerpts under the 300-line cap.
