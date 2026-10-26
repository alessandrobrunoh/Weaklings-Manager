# Weaklings logo

## Overview

`app-weaklings-logo` renders an inline SVG brand mark and, outside compact mode, the WEAKLINGS wordmark and GO HARD! tagline.

## Interface

- `compact` and `dense` are boolean inputs, both defaulting to `false`.
- The SVG is hidden from assistive technology; the outer brand element has an accessible label.

## Invariants

`compact` controls whether the wordmark/tagline render. `dense` changes mark sizing and hides the tagline without suppressing the wordmark. Mark strokes use `currentColor`; the gem gradient uses fixed red shades.

## Side Effects

Each instance increments a class-level counter to generate a unique gradient ID. No I/O, subscriptions, or injected services are present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
