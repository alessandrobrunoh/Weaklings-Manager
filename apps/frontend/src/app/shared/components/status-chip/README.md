# Status chip

## Overview

`app-status-chip` renders a status label with a tone and optional icon or dot.

## Interface

- Required `value: string`; optional `toneOverride`, `label`, and `icon`.
- `showDot` defaults to `true`.

## Invariants

- Tone priority is override, mapped status, then `neutral`.
- An explicit label is used even if it is empty; otherwise underscores become spaces and word initials are capitalized.
- 12px text, never colour alone: success, warning, error and info tones show a default glyph (check, alert, alert, info); neutral shows a dot unless `showDot` is false. An explicit `icon` always wins.
- Neutral is the default; semantic colours are for real states only.

## Side Effects

The `OnPush` component computes display values from inputs and applies inline styles. It declares no outputs or external state operations.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
