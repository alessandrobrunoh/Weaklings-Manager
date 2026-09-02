//! Adds a unique index on `scouted_comps(opponent_guild_id, category, fingerprint)`.
//!
//! `IntelService::scout_battle` decides whether an incoming draft matches an existing
//! scout in application code (`is_same_comp`, the strong fingerprint match) before
//! choosing between `insert_draft` and `merge_draft` — but that read-then-write is not
//! atomic, so two requests scouting the same battle concurrently (the background worker
//! retrying alongside a manual scout, say) can both miss each other's still-uncommitted
//! insert and each create their own row for what should be one scout.
//!
//! This index does not capture the service's full match logic (it also falls back to a
//! case-insensitive guild-name match when `opponent_guild_id` is `NULL`), but it does
//! cover the common, exact-fingerprint case, which is what a race between two identical
//! scouting attempts of the same battle actually produces. `insert_draft` now catches the
//! resulting unique-constraint violation and merges into the row that won the race instead
//! of erroring.
//!
//! `opponent_guild_id` is nullable; both Postgres and SQLite treat each `NULL` as distinct
//! for uniqueness purposes, so this only constrains rows that actually have a guild id,
//! which is the overwhelming majority scouted from real battle snapshots.

use sea_orm_migration::prelude::*;

/// Migration step adding the scouted-comps dedup index.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .name("idx_scouted_comps_guild_category_fingerprint_unique")
                    .table(ScoutedComps::Table)
                    .col(ScoutedComps::OpponentGuildId)
                    .col(ScoutedComps::Category)
                    .col(ScoutedComps::Fingerprint)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_scouted_comps_guild_category_fingerprint_unique")
                    .table(ScoutedComps::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ScoutedComps {
    Table,
    OpponentGuildId,
    Category,
    Fingerprint,
}
