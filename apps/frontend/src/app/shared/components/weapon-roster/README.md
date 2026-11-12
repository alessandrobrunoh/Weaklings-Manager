# Weapon roster

## Overview

`app-weapon-roster` is the "My weapons" card: the whole weapon catalog at once, grouped by family, where a member marks each weapon None / Basic / Good / Main with one click. It loads and saves through the API itself so the profile (Weapons tab, `/profile?tab=weapons`) and the admin member page share one implementation. It is the only member-skill system. There is no "add weapon" step: a weapon is declared by giving it a level and removed by choosing None.

## Interface

- Inputs: `mode` (`self` | `manage`, default `self`), `userId` (member to load in `manage` mode), `editable` (default `true`). There are no outputs.
- `self` talks to `api/users/me/weapons`; `manage` talks to `api/users/{id}/weapons` and adds a per-weapon Lock toggle (also for a weapon the member never declared).
- The catalog comes from `AlbionCatalogService` (`api/openalbion/catalog`). Pure helpers (request bodies, catalog/declaration merge, filtering, family grouping, level summary, unsaved-change count, seat fit, bench ordering, build grouping) live in `shared/data/user-weapons.ts`; the family classifier is `shared/data/albion-weapon-families.ts`.

## Layout

- Header with the Main / Good / Basic counts (always shown, zeros included) and a locked count, as chips using the same tones as the event bench.
- Filter bar: name search, family select, level select (all, declared, main, good, basic, not declared, plus locked for officers or when something is locked) and a "Declared only" toggle (`aria-pressed`). A result count ("Showing 12 of 140 weapons", polite live region), "Clear filters", and "Collapse all" / "Expand all" sit under it.
- Weapons grouped by family (collapsible, each header shows declared/total), alphabetical inside a group so changing a level never moves a row. One row per weapon: icon tile (generic icon if the render is missing), name, a radio group None / Basic / Good / Main, and in manage mode a lock icon button. Rows are one column on a phone and auto-fill into columns on wide screens; below 30rem of group width the radio group takes its own full-width line.
- Empty states: catalog unavailable, a read-only view with nothing declared, and "no weapons match" with a Clear filters button.
- A sticky bar at the bottom of the card appears while there are unsaved changes: "Unsaved changes: N", Discard and Save.

## Invariants

- Save model: the API only replaces the whole list (`PUT`), so there is no per-weapon save. Clicks edit a draft; the sticky bar saves or discards all changes. Only declared or locked weapons are kept in the draft and sent; a weapon set to None without a lock is dropped.
- A read-only view (`editable` false) starts filtered to declared weapons, because the rest are all "none".
- Changing a filter expands every group, so a collapsed group never hides results.
- A weapon locked by an officer shows a lock icon and "Locked by an officer" on a tinted row with a dashed border; a member cannot change it and never sends it.
- Levels are native radio inputs in a fieldset with a legend, so keyboard and screen-reader behaviour is the browser's (arrow keys move and select); a declared weapon is marked by a check mark, a bold name and a tinted row as well as the level tone, never colour alone. Targets are at least 32px (36px on a phone). Focus is shown with a 2px primary outline.
- The lock toggle is a button with `aria-pressed` and an `aria-label` naming the weapon.
- Saving and discarding are announced through a polite live region.
- Only design tokens (`--color-*`, `--radius-*`, `--motion-fast`) are used, so light and dark themes follow the app.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
