# Destiny Board

## Overview

`app-destiny-board` renders a radial Albion Destiny Board with interactive weapon and armor nodes, search, category filtering, loading, and error states.

## Interface

The component exposes a board view with node interactions and a retry action. Its full Angular input/output type inventory was outside the scanned source range; callers own persistence according to the component's source description.

## Invariants

- Rendering prioritizes loading, then failure, then the board; the empty state appears when the layout has at most one node.
- Rendered nodes are keyboard-focusable buttons with accessible labels and selected state.
- The source describes node levels from 0 through 120 and branch/center controls for setting or resetting children.

## Side Effects

The visible interactions delegate to component handlers and emit retry. The source description assigns persistence to the parent; no persistence operation is documented here.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The source scan was bounded to the first 300 lines of the 821-line implementation.
