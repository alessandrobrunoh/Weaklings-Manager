# Control-plane migrations

## Overview

This directory contains the SeaORM migration bundle for control-plane state, separate from tenant migrations and with its own `seaql_migrations` history. The explicit registration list covers tenant registry, platform roles/features, tenant settings/ranks, alliance records, and event mirror links.

## Interface

`Migrator` implements `MigratorTrait` and returns the registered migration objects in vector order. Each private migration module defines a `Migration` implementing `MigrationTrait` with `up` and `down`. Public constants in the module define the SuperAdmin role, feature catalog keys, and platform permission keys.

## Invariants

- The registered list is explicit and manually ordered.
- Tenant slugs/schema names are unique; tenant status is constrained to `provisioning`, `active`, or `suspended`.
- Feature flags default to disabled and reference a tenant and feature catalog entry.
- Partial unique indexes limit default ranks and default tenants independently to at most one.
- A guild can belong to at most one alliance; membership status is `pending` or `active`.
- Alliance-share source keys and source/mirror event-link keys are unique in their respective records.
- Rollback semantics are migration-specific; the artifact-type repair migration documents a no-op `down`.

## Side Effects

Migrations issue DDL and data statements through the supplied `SchemaManager`, using schema builders and raw SQL. Data migrations seed platform roles/permissions, feature catalog entries, and flags; most `down` methods reverse schema or remove seeded data, subject to migration-specific exceptions.

## Verification

From the repository root, run `cargo test -p backend`. The migration effects themselves require a separately configured control database to apply and verify.
