# Server onboarding

## Overview

`AddServer` guides users through inviting the bot, registering a Discord server, and enabling modules, with eligible servers shown inline.

## Interface

The page presents a five-step walkthrough, requirements, FAQ, invite links, and eligible guild choices. Text is resolved through translation keys.

## Invariants

- The walkthrough has five numbered steps and the FAQ has three entries.
- Guild rows are tracked by ID; a guild icon falls back to the guild name's initial when unavailable.
- The invite link falls back to `#` and is marked disabled when no URL is available.

## Side Effects

The template exposes registration and invite actions and links to admin pages. Registration implementation was outside the scanned range; invite links open in a new tab.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan was limited to the first 300 lines of the 355-line source.
