# Role tag

## Overview

`app-role-tag` is the single way to show a build role (tank, healer, support, brawler, DPS, battle mount) anywhere in the app. It is deliberately neutral: no per-role hue, because colour is reserved for state and direction.

## Interface

- Selector: `app-role-tag`; required input `role: BuildRole`. No outputs, no content projection.
- Exports from `role-tag.ts`: `BUILD_ROLES` (canonical order, front line first), `roleLabelKey(role)` (the `role.*` translation key, for plain-text uses such as menus or summaries) and `roleGlyph(role)`.
- Renders a short glyph (`T`, `H`, `S`, `B`, `D`, `BM`, hidden from assistive technology) followed by the localized label. One size: 12px text, 22px tall.

## Invariants

- The label always comes from the `role.*` dictionary keys, so it follows the active language.
- Colours come only from neutral surface and text tokens, readable in light and dark.
- The accessible name is the label text alone; the glyph is decorative.

## Side Effects

None. The component reads the translation signal and renders.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
