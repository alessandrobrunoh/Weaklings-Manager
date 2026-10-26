# Searchable select

## Overview

`SearchableSelect` provides searchable single- and multi-selection for option lists, including Discord role, channel, and tag pickers.

## Interface

- `SearchableSelectOption` has required `id` and `label`, with optional `hint` and `group`.
- Inputs configure options, single/multiple values, empty selection, labels, disabled/loading state, and accessibility text.
- Outputs: `valueChange` and `valuesChange`.

## Invariants

- Selection is parent-controlled; absent selected IDs display their ID as a fallback label.
- Filtering trims and lowercases the query and matches label, hint, and group.
- An empty option is added only when `allowEmpty` is enabled and multiple mode is off.

## Side Effects

The component maintains local open/query/active-index signals and registers document pointer/keyboard handlers. It generates per-instance trigger and listbox IDs.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan was limited to 300 source lines; remaining methods were not reviewed.
