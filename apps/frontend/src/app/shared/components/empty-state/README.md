# Empty state

## Overview

`app-empty-state` renders a placeholder for a list or section with no data.

## Interface

- Required `message` input; optional `hint`; `icon` defaults to `sparkles`; `compact` (tighter padding and smaller icon, for use inside a card or table).
- Caller content can be projected after the message and hint: put the single next-step action there. A failed load is not empty; use `app-error-state`.

## Invariants

The message always renders; hint and icon render when provided. The container has `role="status"` and `aria-live="polite"`, and the icon is hidden from assistive technology.

## Side Effects

The component renders its inputs and projected content. No service calls, I/O, event handlers, or state updates are present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
