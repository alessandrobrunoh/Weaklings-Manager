# Loadout editor

## Overview

Two components edit a build's gear with a draft the user can review before anything is saved.

- `LoadoutEditor` (`app-loadout-editor`) lists the ten slots of the Main or Swap loadout, one button per slot, and holds the draft.
- `SlotInspector` (`app-slot-inspector`) is the sheet that opens for one slot: current item, tier, item search, enchantment, quality and abilities. It is a native `<dialog>` (side sheet on wide screens, full screen on a phone) and is only used by the editor.

## Interface

`LoadoutEditor` inputs:

- `items`: the saved `BuildItemSlot[]`. The draft is kept as differences from this list.
- `allowSwap` (default `true`): shows the Main and Swap tabs.
- `showActions` (default `true`): shows the sticky bar with the unsaved count, Discard and Save. Set `false` when the host owns saving.
- `saving`: disables Save and shows "Saving...".
- `tiers`: tiers offered (default `BUILD_ITEM_TIERS`, T4 to T8).

`LoadoutEditor` outputs:

- `save`: `LoadoutChange[]` (`{ loadout, slot, item | null }`); `item: null` means clear the slot. Only slots that differ from `items` are included.
- `discard`: Discard was pressed (the host decides whether to confirm).
- `dirtyChange`: the number of slots that differ from `items`.
- `itemsChange`: the full draft as `BuildItemSlot[]`, for hosts that save everything at once (for example a "new build" dialog with `[showActions]="false"`).

## Invariants

- A slot whose draft equals the saved item is not counted and not sent.
- The swap lists only differences from main. An empty swap slot reads "Same as main: X". "Same as main" in the inspector removes the swap item; "Start from main item" copies it.
- Changing the tier keeps the same item family. Picking an item keeps quality and enchantment, and keeps abilities only when the family is the same.
- Every slot row is one button (one Tab stop); the inspector search starts empty; all labels are translated.

## Side Effects

Loads the Albion item catalog (lazily, on first open) and the ability catalog. Makes no API calls to the backend: saving is the host's job.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
