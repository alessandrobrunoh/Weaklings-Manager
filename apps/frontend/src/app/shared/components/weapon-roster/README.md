# Weapon roster

## Overview

`app-weapon-roster` is the "My weapons" card: the weapons a member can play, each with a Main / Good / Basic level. It loads and saves through the API itself so the profile (Destiny tab) and the admin member page share one implementation.

## Interface

- Inputs: `mode` (`self` | `manage`, default `self`), `userId` (member to load in `manage` mode), `editable` (default `true`), `specNodes` (Destiny Board nodes used by "Import from Destiny Board").
- `self` talks to `api/users/me/weapons`; `manage` talks to `api/users/{id}/weapons` and adds a per-weapon Lock toggle (also for a weapon the member never declared).
- Pure helpers (request bodies, spec-level import, seat fit, bench ordering, build grouping) live in `shared/data/user-weapons.ts`.

## Invariants

- A weapon locked by an officer is shown with a lock badge; a member cannot change or remove it and never sends it.
- Import only adds weapons not yet declared (100+ main, 50+ good, 1+ basic) and never saves by itself.
- Levels are native radio inputs in a fieldset, so keyboard and screen-reader behaviour is the browser's; the selected level also shows a check mark.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
