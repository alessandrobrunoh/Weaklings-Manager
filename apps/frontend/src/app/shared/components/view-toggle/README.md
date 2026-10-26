# View toggle

## Overview

`ViewToggle` is a segmented tab control for switching between views of the same data.

## Interface

- `ViewToggleOption` requires `id` and `label`; `icon` is optional.
- Required inputs: readonly `options` and active option ID.
- `activeChange` emits the selected ID.

## Invariants

The tablist uses automatic activation. Left/Right arrows wrap, Home/End select the first/last option, and an empty option list is a no-op. The active ID must match an option for a tab to receive `tabindex="0"`.

## Side Effects

Click and handled keyboard input emit the selected ID; keyboard navigation prevents the default action and moves DOM focus. The component does not update the active input itself.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
