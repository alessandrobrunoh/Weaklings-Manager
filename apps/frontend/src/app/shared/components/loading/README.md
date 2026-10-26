# Loading indicator

## Overview

`app-loading` is an inline spinner component for loading states.

## Interface

- `size` is an input in pixels and defaults to `20`.
- `label` defaults to an empty string.

## Invariants

The wrapper uses `role="status"` with `aria-label` from `label`; the spinner is hidden from assistive technology. Spinner dimensions follow `size`, and its border width is at least 2px. Visible label text renders only when truthy.

## Side Effects

The component renders an animated spinner; its CSS rotates continuously. No external state or I/O is used.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
