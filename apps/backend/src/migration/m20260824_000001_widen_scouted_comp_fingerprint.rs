//! Widens `scouted_comps.fingerprint` from a bounded `varchar(512)` to `text`.
//!
//! The fingerprint is `"role:n,role:n|weapon:n,weapon:n,..."`, one entry per
//! distinct weapon observed in the kill feed. A ZvZ can field several dozen
//! distinct Albion weapon identifiers, each ~25-30 characters — 512 was sized
//! for a small-scale skirmish and overflows in production on large fights,
//! which is exactly the class of battle Intel most needs to scout. `text` has
//! no such ceiling, matching every other unbounded string already in this
//! table (`roles_json`, `weapons_json`, `players_json`).
//!
//! This migration only exists because `m20260823_000001_create_scouted_comps`
//! had already run against a live database by the time the bug surfaced — the
//! original migration is not rewritten in place, since doing so would silently
//! skip this fix on any database where it already applied.
//!
//! Skipped entirely on SQLite: its backend does not support `ALTER COLUMN`
//! at all (sea-query panics on the attempt), and the point is moot there
//! anyway — SQLite has no enforced column-length limit to begin with, so the
//! original `varchar(512)` never actually constrained anything on that
//! backend. Only Postgres, which the application actually runs on, needed
//! the fix.

use sea_orm_migration::prelude::*;

/// Migration step to widen the fingerprint column.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Sqlite {
            return Ok(());
        }
        manager
            .alter_table(
                Table::alter()
                    .table(ScoutedComps::Table)
                    .modify_column(ColumnDef::new(ScoutedComps::Fingerprint).text().not_null())
                    .to_owned(),
            )
            .await
    }

    /// # Data-loss / failure warning
    ///
    /// Rolling back narrows `fingerprint` from unbounded `text` back to `varchar(512)`. This is
    /// exactly the scenario `up()`'s doc comment above describes as the reason this migration
    /// exists: a ZvZ fight easily produces a fingerprint well past 512 characters. On Postgres,
    /// narrowing a column fails outright (`ERROR: value too long for type character varying(512)`)
    /// against any row already exceeding the new limit, aborting the rollback; even for rows that
    /// happen to fit, this reintroduces the original overflow bug for the next large fight scouted.
    /// Confirm every `scouted_comps.fingerprint` value is at most 512 characters before rolling
    /// this migration back, and expect to have to prune/truncate long fingerprints first if not.
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Sqlite {
            return Ok(());
        }
        manager
            .alter_table(
                Table::alter()
                    .table(ScoutedComps::Table)
                    .modify_column(
                        ColumnDef::new(ScoutedComps::Fingerprint)
                            .string_len(512)
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ScoutedComps {
    Table,
    Fingerprint,
}
