# Tooltip directive

## Overview

`TooltipDirective` creates and positions a tooltip in the document body for pointer- or focus-active hosts.

## Interface

- Selector: `[appTooltip]`.
- Inputs: `appTooltip`, `tooltipPosition` (`top`, `bottom`, `left`, or `right`; default `top`), and `tooltipDelay` (default `120`).

## Invariants

- Blank trimmed text does not schedule a tooltip; each directive tracks one element and gives it a generated ID and `role="tooltip"`.
- Placement is clamped to the viewport with 8px padding and a 6px offset.
- The host's `aria-describedby` matches the tooltip ID while it exists.

## Side Effects

The directive creates a `div` under `document.body`, sets text/attributes/position styles, and uses timers/animation frames for display/removal. It registers scroll/resize handlers and removes listeners/tooltip state on destruction.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
