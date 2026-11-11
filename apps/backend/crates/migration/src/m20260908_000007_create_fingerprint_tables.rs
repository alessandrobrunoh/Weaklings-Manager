//! Creates the equipment identity tables: `loadout_fingerprints` and
//! `battle_loadout_observations`.
//!
//! Today "build" only means a planned, hand-authored loadout in
//! `comps::builds` — there is no way to ask "what did we actually field" or
//! "what is this enemy's real meta" from real battle evidence. This
//! migration adds the schema for that: a canonical equipment identity
//! (`loadout_fingerprints`), matched at most once against the internal build
//! catalog, plus an append-only bridge recording which fingerprint a player
//! wore in a given battle (`battle_loadout_observations`), for both our own
//! players and enemies alike — equipment identity doesn't care about side.
//!
//! This migration is purely additive: it does not touch any existing table,
//! backfill any data, or wire anything into ingestion.
//!
//! **No observation-count rollup on `loadout_fingerprints`.** This mirrors
//! the identity-vs-rollup split already established by
//! `m20260908_000005_create_enemy_identity_tables` for `enemy_guilds` /
//! `enemy_players`: battle hydration is re-run, and a battle's evidence rows
//! can be replaced when it is re-fetched (that is exactly why
//! `battle_loadout_observations` carries a unique `(battle_id, player_key)`
//! index — so a caller can safely replace one battle's observations without
//! duplicating them). If `loadout_fingerprints` carried a `times_observed`
//! counter incremented on ingestion, replaying or re-hydrating a battle
//! would double-count it, with no way to tell a correct total from an
//! inflated one short of recomputing from scratch anyway. Every rollup
//! (how often has this fingerprint been seen, over what period, on which
//! side) is computed at read time by aggregating `battle_loadout_observations`.
//! A future reader must not "helpfully" add a counter column to
//! `loadout_fingerprints` without understanding that this would immediately
//! reintroduce that bug.
//!
//! **A fingerprint's build match is set once, at creation time, and never
//! recomputed.** `matched_build_id` / `matched_build_loadout` /
//! `match_status` are written by the matcher when a fingerprint is first
//! created and are never revisited afterward, even if the build catalog
//! changes later — editing or archiving an internal build must not silently
//! rewrite what a fingerprint observed months ago. A fingerprint's match is
//! a historical fact about the catalog as it existed at observation time,
//! not a live join that should track the catalog's current state.
//!
//! `battle_loadout_observations.battle_id` is the `AlbionBB` battle id,
//! deliberately unconstrained — no foreign key — matching the established
//! idiom already used by `battle_guild_stats.battle_id` /
//! `battle_player_stats.battle_id` / `battle_kills.battle_id` /
//! `enemy_player_battles.battle_id`, so this evidence survives independently
//! of any snapshot pruning. `player_key` is the same opaque identity key
//! already established by `battle_player_stats.player_key`.

use sea_orm_migration::prelude::*;

/// Migration step creating the fingerprint tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[allow(clippy::too_many_lines)]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(LoadoutFingerprints::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(LoadoutFingerprints::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::Fingerprint)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::Mode)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::MainHandBaseItemId)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(LoadoutFingerprints::PrimaryRole).string())
                    .col(
                        ColumnDef::new(LoadoutFingerprints::SlotsJson)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(LoadoutFingerprints::MatchedBuildId).big_integer())
                    .col(ColumnDef::new(LoadoutFingerprints::MatchedBuildLoadout).string())
                    .col(
                        ColumnDef::new(LoadoutFingerprints::MatchStatus)
                            .string()
                            .not_null()
                            .default("unmatched"),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(LoadoutFingerprints::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_loadout_fingerprints_matched_build_id")
                            .from(
                                LoadoutFingerprints::Table,
                                LoadoutFingerprints::MatchedBuildId,
                            )
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_loadout_fingerprints_fingerprint_unique")
                    .table(LoadoutFingerprints::Table)
                    .col(LoadoutFingerprints::Fingerprint)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_loadout_fingerprints_matched_build_id")
                    .table(LoadoutFingerprints::Table)
                    .col(LoadoutFingerprints::MatchedBuildId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_loadout_fingerprints_last_seen_at")
                    .table(LoadoutFingerprints::Table)
                    .col(LoadoutFingerprints::LastSeenAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(BattleLoadoutObservations::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::BattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::PlayerKey)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::IsFriendly)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::FingerprintId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BattleLoadoutObservations::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_battle_loadout_observations_fingerprint_id")
                            .from(
                                BattleLoadoutObservations::Table,
                                BattleLoadoutObservations::FingerprintId,
                            )
                            .to(LoadoutFingerprints::Table, LoadoutFingerprints::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_loadout_observations_unique")
                    .table(BattleLoadoutObservations::Table)
                    .col(BattleLoadoutObservations::BattleId)
                    .col(BattleLoadoutObservations::PlayerKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_loadout_observations_fingerprint_id")
                    .table(BattleLoadoutObservations::Table)
                    .col(BattleLoadoutObservations::FingerprintId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_loadout_observations_occurred_at")
                    .table(BattleLoadoutObservations::Table)
                    .col(BattleLoadoutObservations::OccurredAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_battle_loadout_observations_is_friendly")
                    .table(BattleLoadoutObservations::Table)
                    .col(BattleLoadoutObservations::IsFriendly)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(BattleLoadoutObservations::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(LoadoutFingerprints::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum LoadoutFingerprints {
    Table,
    Id,
    Fingerprint,
    Mode,
    MainHandBaseItemId,
    PrimaryRole,
    SlotsJson,
    MatchedBuildId,
    MatchedBuildLoadout,
    MatchStatus,
    FirstSeenAt,
    LastSeenAt,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum BattleLoadoutObservations {
    Table,
    Id,
    BattleId,
    PlayerKey,
    IsFriendly,
    FingerprintId,
    OccurredAt,
    CreatedAt,
}

/// Reference to the existing `builds` table, owned by `comps::entities::build`.
#[derive(DeriveIden)]
enum Builds {
    Table,
    Id,
}
