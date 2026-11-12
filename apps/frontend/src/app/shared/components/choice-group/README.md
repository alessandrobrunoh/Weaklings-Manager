# Choice group

## Overview

`ChoiceGroup` is a small single-choice control: a row of labelled chips that behaves as an ARIA radio group. It replaces selects and icon-only quick picks where the options should be visible at once (tier, enchantment, quality, ability).

## Interface

- Selector: `app-choice-group`.
- Inputs: `options` (`ChoiceOption[]`: `id`, `label`, optional `iconUrl`, optional `ariaLabel`), `value` (id of the checked option, or `null`), `ariaLabel` (required, names the group), `disabled`.
- Output: `valueChange` (the id of the option the user chose; not emitted for the already-checked one).

## Invariants

- `role="radiogroup"` with `role="radio"` buttons and `aria-checked`.
- Roving tabindex: one Tab stop per group, on the checked option (the first when none is checked).
- Arrow keys move and choose, wrapping at the ends. Home and End jump to the first and last option.
- The text label is always rendered. An icon is decoration (empty alt).
- Disabled groups ignore clicks and keys.

## Side Effects

None. The parent owns the value.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
