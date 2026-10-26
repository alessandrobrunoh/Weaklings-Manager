# Shared frontend utilities

## Overview

This directory groups reusable components, chart builders, data helpers, directives, Discord option mapping, Albion catalog services, and validation.

## Interface

- [Charts](charts/README.md) builds GuildReport chart options and table twins.
- [Components](components/README.md) contains reusable Angular UI.
- [Data](data/README.md) provides Albion and ownership helpers; [directives](directives/README.md) provides the tooltip directive.
- [Discord](discord/README.md) maps Discord records into select options; [services](services/README.md) loads Albion catalogs.
- [Validation](validation/README.md) provides build-draft checks.

## Invariants

The directory itself contains no direct source files. Contracts are separated by child responsibility; no shared interface is defined at this aggregation level.

## Side Effects

No direct effects occur at this directory level. Child modules may perform the UI, network, or browser effects described in their own README files.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
