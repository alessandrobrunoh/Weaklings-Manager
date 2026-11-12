# Error state

## Overview

`app-error-state` presents a recoverable error instead of making a failed load look like an empty result.

## Interface

- Optional `message` (defaults to `common.error`, or `ui.errorState.notFound` for the 404 variant), `hint`, `retryLabel` (the retry button renders only when set), and `variant: 'error' | 'not-found'` (default `error`).
- `retry` emits `void` when the retry button is activated. Default content is projected after the text: use it for the actions of the 404 variant (a "Back to list" link).

## Invariants

The message always renders; the hint renders when set (the 404 variant falls back to `ui.errorState.notFoundHint`). The error variant uses `role="alert"` with a red-tinted alert icon and a retry button; the `not-found` variant uses `role="status"`, neutral colours, a search icon and no retry button, because there is nothing to retry. Icons are hidden from assistive technology.

## Side Effects

The retry button emits `retry`. The parent supplies the actual retry behavior; this component performs no load or network operation.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
