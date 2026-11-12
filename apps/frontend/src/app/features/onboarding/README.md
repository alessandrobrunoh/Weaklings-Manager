# Server onboarding

## Overview

`AddServer` is the "Add a server" wizard, opened from the `+` orb in the server rail. It walks a guild leader through inviting the bot, registering a Discord server, linking the Albion guild, turning modules on and bringing members in. The Discord servers the session can still register are listed on step 2, so the walkthrough ends in one click.

## Interface

- Page header with the title and an intro line; no header actions (the invite lives on step 1).
- Requirements card: three short checks before starting.
- Wizard card: a numbered progress indicator (five dots, each a 44px button labelled "Go to step n: title", plus a progress bar and "Step n of 5" text) and one step panel at a time with a title, an explanation and the step's action. Back and Next move through the steps; the last step ends in "Open the dashboard".
- Step actions: 1 invite link (or an error with retry), 2 registerable guild list (loading skeleton, error with retry, empty state, or rows), 4 links to the admin feature, role and Discord pages. Steps 3 and 5 are explanation only.
- FAQ as native disclosures.
- Text comes from translation keys in all five locales. Load failures show `addServer.guildsError` or `addServer.inviteUnavailable`, never raw API text.

## Invariants

- The wizard has five steps. The current step is an index in `[0, 4]`; `goTo` ignores out-of-range indexes.
- Only the current step's panel is rendered. Loading, error, empty and data states of the guild list never show together.
- A failed guild load is an error state with retry, not an empty list. A failed invite load is an error state with retry, and the invite link is a real anchor only once a URL exists.
- Guild rows are tracked by ID. A guild icon falls back to the guild name's initial when unavailable.
- The FAQ has three entries.

## Side Effects

- `registerableGuilds` and `botInvite` are requested once on init. Retry buttons repeat only the failed request.
- Clicking a guild navigates to `/register-tenant` with the guild ID and name as query params. Invite links open in a new tab with `noopener noreferrer`.
- The finish action and the admin links navigate within the app.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The spec covers the five dots and the current-step state, the invite anchor, moving between steps, the guild navigation, and the guild-load error with retry.
