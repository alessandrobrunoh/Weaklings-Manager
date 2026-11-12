# Weapon icon

## Overview

`app-weapon-icon` is a small square tile showing a build's weapon. It works from the `weapon_key` a build summary already carries, so lists and rosters can show weapon icons without fetching each build's detail.

## Interface

- Selector: `app-weapon-icon`. No outputs, no content projection.
- Inputs: `weaponKey` (`weapon:{BASE}` or `null`), `size` (`md` 36px default, `sm` 28px), `fallback` (text shown when there is no weapon or the image fails, for example the role glyph) and `alt` (empty by default).

## Invariants

- The image is requested from Albion's render CDN at tier 8 (`albionCombatIconUrl`), which exists for every combat item.
- The image is decorative (`alt=""`) unless `alt` is set; the build name next to the tile names the build. A failing image falls back to the `fallback` text instead of a broken-image icon, and a changed weapon key gets a fresh attempt.
- Colours come from neutral surface tokens, so it reads in both themes.

## Side Effects

The browser requests the image lazily. No other I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
