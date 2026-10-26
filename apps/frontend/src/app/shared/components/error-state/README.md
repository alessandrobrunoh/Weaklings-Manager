# Error state

## Overview

`app-error-state` presents a recoverable error instead of making a failed load look like an empty result.

## Interface

- Required string inputs: `message` and `retryLabel`; optional string input: `hint`.
- `retry` emits `void` when the retry button is activated.

## Invariants

The message and retry button always render; the hint renders only when truthy. The container uses `role="alert"` and the alert icon is hidden from assistive technology.

## Side Effects

The retry button emits `retry`. The parent supplies the actual retry behavior; this component performs no load or network operation.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
