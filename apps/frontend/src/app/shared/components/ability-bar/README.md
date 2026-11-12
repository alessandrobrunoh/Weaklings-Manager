# Ability bar

## Overview

`AbilityBar` renders the ability slots for one equipped item. Read-only mode shows the key and the name of each chosen ability. With `canManage` it shows one named choice group per slot instead of a modal picker.

## Interface

- Selector: `app-ability-bar`.
- Inputs: `slots` (`AbilitySlotView[]`), `canManage` (default `false`), `emptyLabel`.
- Output: `choiceChange` (`{ kind, index, spellId | null }`); `null` means "None".

## Invariants

- No slots renders nothing.
- Managed mode is one `app-choice-group` per ability slot: a "None" chip, then one chip per spell with its icon and name. One Tab stop per slot; arrow keys move and select.
- The ability key (Q, W, E, Passive) and the ability name are always visible text. Colour and icons never carry the meaning alone.
- The group label comes from `loadoutEditor.ability.slot`, translated.

## Side Effects

None. The parent decides what to do with `choiceChange`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
