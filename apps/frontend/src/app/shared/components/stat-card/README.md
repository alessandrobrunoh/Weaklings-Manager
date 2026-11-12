# Stat card

## Overview

`app-stat-card` renders a KPI tile with a label and value, plus optional delta, subtext, and icon. It is kept for pages not yet migrated; new work uses [`app-summary-band`](../summary-band/README.md), a compact strip, instead of a grid of tiles.

## Interface

- Required inputs: `label: string` and `value: string | number | null`.
- Optional inputs: `sub`, `icon`, `tone`, `delta`, and `deltaDirection`.
- No outputs are declared.

## Invariants

Nullish values display as an em dash. Delta and subtext render only when truthy; icon renders when supplied. Delta direction selects success, error, or neutral styling and shows an arrow glyph so colour is never the only cue. Only the icon and value take the tone colour.

## Side Effects

The component derives presentation from inputs and delegates icon rendering; it has no direct I/O or state mutation.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
