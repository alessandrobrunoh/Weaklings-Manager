# Loading

## Overview

`app-loading` is the loading placeholder: an inline spinner, or a skeleton that reserves the layout of what is about to appear (table rows, a summary band, a detail page, text lines).

## Interface

- `variant`: `'spinner'` (default), `'table'`, `'summary'`, `'detail'` or `'lines'`.
- `label` (translated "Loading…", empty by default), `size` (spinner diameter in px, default `20`), `rows` (table and lines skeletons, default `5`), `cells` (summary skeleton, default `4`).

## Invariants

Every variant is a `role="status"` region; the spinner is named by `aria-label` with the label shown beside it, skeletons carry `aria-busy="true"`, the label as screen-reader-only text, and hide the placeholder shapes from assistive technology. Use a skeleton for any region of the page, a spinner only for small inline waits. Shimmer and spin stop under `prefers-reduced-motion`.

## Side Effects

CSS animation only. No external state or I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
