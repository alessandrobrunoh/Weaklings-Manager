# Version diff list

## Overview

`VersionDiffList` renders version differences as a before/after table or an empty-state message.

## Interface

- Required input: readonly `entries: VersionDiffEntry[]`.
- Inputs configure the empty-state and column/status labels; defaults are provided.
- No outputs are declared.

## Invariants

An empty array renders the empty state; otherwise rows are tracked by `entry.subject`. Nullish before/after values display as an em dash. Added, removed, and changed statuses map to corresponding chip styles and labels.

## Side Effects

The component derives text and classes from input entries and renders them; no service, I/O, or external state behavior is present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
