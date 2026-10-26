# Meter

## Overview

`app-meter` displays a labeled horizontal progress bar and a right-aligned figure.

## Interface

- Required inputs: `label: string` and `value: number`.
- Optional inputs: `max` (default `100`), `display`, and `tone` (`primary`, `success`, `danger`, or `neutral`; default `primary`).

## Invariants

- For non-positive `max`, the clamped value and percentage are zero. Otherwise the value is clamped to `[0, max]` and the percentage is rounded.
- A truthy `display` overrides the percentage in the figure and accessible label.
- The bar exposes progressbar roles and min/max/current values.

## Side Effects

Angular renders input-derived values; the fill width transitions in CSS. No I/O or event emissions are declared.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
