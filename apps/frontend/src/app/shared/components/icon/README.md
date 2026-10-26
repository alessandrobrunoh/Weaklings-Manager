# Icon

## Overview

`app-icon` renders inline SVG icon geometry without a third-party icon package.

## Interface

- `IconName` is a string-literal union of supported icon names, including `activity`, `alert`, `calendar`, `search`, `dashboard`, `loader`, and `zap`.
- The component uses `name`, `size`, `color`, and `decorative` values; the full input types and defaults were outside the inspected range.

## Invariants

- SVG uses a `0 0 24 24` viewBox, no fill by default, `currentColor` stroke, and a 2px stroke width.
- Decorative icons set `aria-hidden="true"` and omit a role; non-decorative icons use `role="img"`.

## Side Effects

The component sets host display, dimensions, color, and accessibility attributes. No event, network, storage, or service interactions were observed in the scanned range.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan was limited to the first 300 lines of the 332-line source.
