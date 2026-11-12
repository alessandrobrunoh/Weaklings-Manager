# Weapon roster

## Overview

`app-weapon-roster` is the "My weapons" card: the weapons a member can play, each with a Main / Good / Basic level. It loads and saves through the API itself so the profile (Weapons tab, `/profile?tab=weapons`) and the admin member page share one implementation. It is the only member-skill system.

## Interface

- Inputs: `mode` (`self` | `manage`, default `self`), `userId` (member to load in `manage` mode), `editable` (default `true`). There are no outputs.
- `self` talks to `api/users/me/weapons`; `manage` talks to `api/users/{id}/weapons` and adds a per-weapon Lock toggle (also for a weapon the member never declared).
- Pure helpers (request bodies, family grouping, level summary, seat fit, bench ordering, build grouping) live in `shared/data/user-weapons.ts`; the family classifier is `shared/data/albion-weapon-families.ts`.

## Layout

- Header with a level summary (Main / Good / Basic counts, locked count) as chips using the same tones as the event bench.
- An "add" panel: the searchable weapon picker (grouped by family) plus a one-line explanation of the three levels.
- Weapons grouped by family, alphabetical inside a group, so changing a level never moves a row. Each row: item icon tile (generic icon if the render is missing), name, state line, segmented Main / Good / Basic control, officer lock toggle (manage mode), remove button.
- Empty state with guidance; Discard and Save in the footer.

## Invariants

- A weapon locked by an officer shows a lock icon and "Locked by an officer" on a tinted row with a start border; a member cannot change or remove it and never sends it.
- Levels are native radio inputs in a fieldset with a legend, so keyboard and screen-reader behaviour is the browser's; the selected level also shows a check mark and a tone, never colour alone. Focus is shown with a 2px primary outline.
- The lock toggle is a button with `aria-pressed` and an `aria-label` naming the weapon.
- Adding, removing and discarding are announced through a polite live region.
- At phone width the segmented control takes its own full-width line below the name.
- Only design tokens (`--color-*`, `--radius-*`, `--motion-fast`) are used, so light and dark themes follow the app.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
