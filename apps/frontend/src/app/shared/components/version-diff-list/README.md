# Version diff list

## Overview

`VersionDiffList` renders the differences between two versions as a grouped list. Each entry is one line (a slot, or a build in a composition) with only the parts that changed shown as `before -> after`.

## Interface

- Required input: readonly `entries: VersionDiffEntry[]` (from `features/comps/version-diff.ts`).
- Optional inputs: `emptyLabel`, `beforeLabel`, `afterLabel`, `changeLabel`, `addedLabel`, `removedLabel`, `changedLabel`, `noneLabel` and the column labels. Defaults exist, callers pass translated text.
- No outputs.

## Invariants

- An empty array renders the empty-state message instead of a list.
- Entries carrying `group` (Main, Swap) are listed under a heading per group in the order given. A flat list has no heading.
- Entries carrying `tokens` show one `before -> after` pair per changed token (item, ability by key, quality, version, quantity). Entries without tokens fall back to a single before/after pair.
- The kind of change is written in words with a `+`, `-` or `~` symbol. Colour only reinforces it.
- A missing side shows `noneLabel`, never a blank.
- Layout follows the container width (container queries), so the list works in a dialog and on a phone.

## Side Effects

None. The component derives text and classes from its inputs.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
