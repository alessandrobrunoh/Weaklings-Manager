# Application features

## Overview

This directory groups the frontend's feature pages and shared compact-feature styling for control-plane and entry-point views.

## Interface

`COMPACT_FEATURE_STYLES` exports a CSS string scoped under `:host`. Feature boundaries:

- [Admin](admin/README.md), [Albion settings](albion-settings/README.md), [audit](audit/README.md), [auth](auth/README.md), [bank](bank/README.md), [battles](battles/README.md), [comps](comps/README.md), [dashboard](dashboard/README.md), [events](events/README.md), [fights](fights/README.md), [guild](guild/README.md), [Intel](intel/README.md), [leaderboards](leaderboards/README.md), [onboarding](onboarding/README.md), [platform](platform/README.md), [regears](regears/README.md), [settings](settings/README.md), [siphoned](siphoned/README.md), [splits](splits/README.md), [combat tests](tests/README.md), [users](users/README.md), and [warns](warns/README.md).

## Invariants

The compact style string scopes selectors under `:host` and defines shared local layout tokens. The individual feature directories own their page, data, and permission boundaries.

## Side Effects

The direct source exports a style string; it performs no DOM or I/O operations. Feature page effects are described in their child README files.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
