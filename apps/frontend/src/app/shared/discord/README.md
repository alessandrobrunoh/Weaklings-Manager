# Discord option helpers

## Overview

This directory contains pure helpers that convert Discord roles, channels, and forum tags into `SearchableSelectOption` values.

## Interface

- `roleSelectOptions` and `roleSelectOptionsMany` build single- and multi-select role options.
- `filterDiscordChannels` filters by channel kind; `channelSelectOptions` also formats and groups channels.
- `tagSelectOptions` returns options for a selected forum channel.

## Invariants

- Mapping preserves source order; it does not sort.
- Text/forum channel labels receive a `#` prefix; parent category names are used when their parent appears in the input list.
- Unknown nonempty selected IDs are retained as options labeled by the ID.
- A missing forum channel produces no tag options.

## Side Effects

The helpers construct and return local arrays/maps/sets. No network, logging, or external state writes are present.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
