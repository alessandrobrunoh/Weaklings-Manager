# Backend modules

## Overview

This directory is the feature-module namespace and Axum route aggregator. Individual child modules own their request contracts, rules, and persistence boundaries; see the linked module READMEs below.

## Interface

`router()` declares the module namespaces and nests feature routers at their API path segments, including users, auth, bank, events, battles, combat, intel, progression, and notifications. The application mounts this router under `/api`.

The sibling `applications.rs` exposes the application service and router from this namespace; its implementation files live in the `applications/` child directory. `fights.rs` supplies canonical Fight API types, including `FightSegmentSummary`, `FightOutcomeView`, `FightListItem`, and `PaginatedFightList`. `platform` is declared here but mounted separately by the application; `trials` is a service module, not a router nested here.

### Child module contracts

- [Admin](admin/README.md)
- [Albion](albion/README.md)
- [AlbionBB](albionbb/README.md)
- [Albion Data](albiondata/README.md)
- [Alliance sharing](alliance_share/README.md)
- [Applications](applications/README.md)
- [Attention](attention/README.md)
- [Audit](audit/README.md)
- [Auth](auth/README.md)
- [Bank](bank/README.md)
- [Battles](battles/README.md)
- [Combat](combat/README.md)
- [Comps](comps/README.md)
- [Economy](economy/README.md)
- [Enemies](enemies/README.md)
- [Events](events/README.md)
- [Fight analytics](fight_analytics/README.md)
- [Fingerprints](fingerprints/README.md)
- [Giveaways](giveaways/README.md)
- [Health](health/README.md)
- [Intel](intel/README.md)
- [Notifications](notifications/README.md)
- [OpenAlbion](openalbion/README.md)
- [Platform](platform/README.md)
- [Progression](progression/README.md)
- [Regear](regear/README.md)
- [Siphoned energy](siphoned/README.md)
- [Splits](splits/README.md)
- [Tickets](tickets/README.md)
- [Trials](trials/README.md)
- [Users](users/README.md)
- [Utilities](utils/README.md)
- [VODs](vods/README.md)
- [Warns](warns/README.md)

## Invariants

- The top-level `router()` composes routes; module-specific authorization, validation, and state rules belong to the child contracts.
- `platform` and `trials` being declared in the namespace does not mean either is nested by this router. Platform routing is composed separately; trials are created through service calls.
- Fight API field semantics distinguish raw persisted battle snapshots from planned event roster data; the direct Fight module documentation describes the API as read-only.
- `combat/data` is JSON-only and is intentionally not treated as a code module or linked as a child contract.

## Side Effects

The router aggregator constructs and nests Axum routers without performing I/O in its visible route-composition code. Child modules may read or mutate databases, call external services, or start workers as documented in their own READMEs.

## Verification

From the repository root, run `cargo test -p backend`.
