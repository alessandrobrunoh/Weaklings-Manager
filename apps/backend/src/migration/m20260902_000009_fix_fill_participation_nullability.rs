//! Repairs `event_participations.primary_build_id` nullability on Postgres deployments.
//!
//! `m20260901_000009_allow_fill_event_participations` intended to make the column nullable so a
//! participant can take the virtual `Fill` role without a build, but its Postgres branch built the
//! `modify_column` without `.null()`. sea-query only emits a `DROP NOT NULL` clause when the
//! `ColumnSpec::Null` spec is present, so the statement degenerated to `ALTER COLUMN
//! "primary_build_id" TYPE bigint` and the original NOT NULL constraint stayed in place — every
//! Fill signup (from Discord or the manager UI) failed with
//! `null value in column "primary_build_id" ... violates not-null constraint`.
//!
//! That migration is already recorded as applied on live databases, so fixing it in place only
//! helps databases created from scratch. This step drops the constraint for the ones already
//! migrated. It is a no-op on SQLite, where the earlier migration rebuilt the table correctly, and
//! re-running `DROP NOT NULL` on an already-nullable column is harmless.

use sea_orm::{ConnectionTrait, DatabaseBackend};
use sea_orm_migration::prelude::*;

/// Migration step dropping the leftover NOT NULL on `event_participations.primary_build_id`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        if db.get_database_backend() != DatabaseBackend::Postgres {
            return Ok(());
        }

        db.execute_unprepared(
            "ALTER TABLE event_participations ALTER COLUMN primary_build_id DROP NOT NULL",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "cannot restore NOT NULL while Fill participations exist".to_string(),
        ))
    }
}
