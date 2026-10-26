# Tenant migrations

## Overview

This directory contains the tenant-schema SeaORM migrations. `Migrator::migrations()` returns an explicit manually maintained list; migrations are not discovered automatically.

## Interface

Each migration follows SeaORM's `MigrationTrait` contract with async `up` and `down` methods taking a `SchemaManager` and returning `Result<(), DbErr>`. The directory's `Migrator` exposes the registered migration sequence.

## Invariants

- A new migration must be declared in the module and added to the vector returned by `Migrator::migrations()`.
- The registration vector determines the migration order and may differ from the declaration order.
- Rollback behavior is migration-specific; a `down` implementation is not necessarily a perfect inverse of `up`.
- Migration filenames alone do not establish their behavior; inspect the implementation.

## Side Effects

Migrations issue schema and data changes through SeaORM schema/query APIs. For example, the bundle includes table creation, permission seeding, and intentional no-op migrations. Applying or rolling back them changes the tenant database; this README does not claim a migration was run.

## Verification

From the repository root, run `cargo test -p backend`. Database migration behavior requires a separately configured database migration run.
