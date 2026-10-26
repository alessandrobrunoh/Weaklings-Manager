# Empty state

## Overview

`app-empty-state` renders a placeholder for a list or section with no data.

## Interface

- Required `message` input; optional `hint`; `icon` defaults to `sparkles`.
- Caller content can be projected after the message and hint.

## Invariants

The message always renders; hint and icon render when provided. The container has `role="status"` and `aria-live="polite"`, and the icon is hidden from assistive technology.

## Side Effects

The component renders its inputs and projected content. No service calls, I/O, event handlers, or state updates are present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
