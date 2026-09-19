//! Adds outcome-persistence and staleness-tracking columns to `fights`, and
//! creates `fight_stats`: a persisted, rebuildable analytics rollup for one
//! Fight.
//!
//! # Persisting `outcome` without recreating the two-truths bug
//!
//! `battles::outcome`'s own doc comment describes how the same engagement
//! used to be classified three different ways, and how `combine_segments`
//! was built to give this codebase exactly one answer to "did we win". That
//! module computed the answer but never stored it, precisely because
//! persisting a computed verdict with no way to keep it in sync is how a
//! second, stale "truth" is born next to the live one. Adding
//! `fights.outcome`/`outcome_method` here does not reopen that risk, because
//! two things are true that were not true before: there is exactly one
//! recompute path (`fight_analytics`, see that module's doc comment) that is
//! ever allowed to write these columns, and every row's freshness is itself
//! observable rather than assumed. `analytics_stale` starts `true` for every
//! existing fight (never computed via this path) and is flipped back to
//! `true` by any future evidence/grouping change that could invalidate the
//! numbers; `analytics_computed_at` records when a recompute last actually
//! ran, or stays `NULL` if it never has. A stale or never-computed row is
//! therefore always distinguishable from a fresh one — the failure mode the
//! old, unpersisted approach could not even represent.
//!
//! `outcome` stores `BattleOutcome::as_str()`'s vocabulary
//! (`"victory"`/`"defeat"`/`"draw"`/`"unknown"`) as plain text, matching the
//! established idiom elsewhere in this codebase of not modelling small,
//! stable vocabularies as DB enums. `outcome_method` stores whatever reason
//! string `combine_segments` produced for that verdict (`"unanimous_segments"`,
//! `"mixed_segments"`, `"no_resolved_segments"`, `"no_segments"`, or one of
//! those with a `_partial_coverage` suffix); it is nullable because a fight
//! that has never been computed via this path has no method to report.
//!
//! # `fight_stats`: one row per fight, replaced wholesale on recompute
//!
//! Same policy as `battle_loss_estimates` (see
//! `m20260908_000008_create_battle_loss_estimates`'s doc comment for the
//! full rationale): this is not an immutable-identity table like
//! `loadout_fingerprints`, it is a "current best rollup" table, overwritten
//! in place every time it is recomputed. `computed_at` is the
//! reproducibility anchor that tells a reader when the row's figures were
//! last true.
//!
//! `fight_id` gets a real foreign key with `ON DELETE CASCADE`, unlike the
//! deliberately-unconstrained upstream-`battle_id` columns used elsewhere in
//! this codebase (`battle_guild_stats.battle_id`,
//! `battle_loss_estimates.battle_id`, etc.) — those reference an opaque
//! `AlbionBB` identifier this codebase does not own, whereas `fights` is a
//! table this codebase owns and controls the lifecycle of, so a real FK is
//! both possible and correct here.
//!
//! `unique_friendly_players`/`unique_enemy_players` are deduplicated by
//! `player_key` across every segment belonging to the fight. A fight can
//! span multiple `AlbionBB` battle segments (a long engagement that upstream
//! split into several battle reports), and a naive sum of per-segment player
//! counts double-counts any player who fought in more than one of those
//! segments — the same player simply shows up again in the next segment's
//! roster. Deduplicating by `player_key` across the whole fight, rather than
//! summing counts already computed per segment, is the fix for that bug.
//!
//! `friendly_estimated_loss`/`enemy_estimated_loss` are summed from
//! `battle_loss_estimates` across the fight's segments.
//! **`enemy_estimated_loss` is a trade indicator only** — this codebase's
//! non-negotiable rule (see `economy::mod`'s doc comment for the full
//! rationale) is that guild income is declared via `splits`, never inferred
//! from combat; this column must never be summed into any income/P&L total,
//! it exists purely so an officer can compare it against
//! `friendly_estimated_loss` to eyeball whether a fight was a good trade.
//!
//! This migration is purely additive: it does not touch any existing
//! router/service, backfill data beyond the sane column defaults described
//! above, or wire anything into ingestion.

use sea_orm_migration::prelude::*;

/// Migration step adding analytics columns to `fights` and creating
/// `fight_stats`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[allow(clippy::too_many_lines)]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("outcome"))
                            .string()
                            .not_null()
                            .default("unknown"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .add_column(ColumnDef::new(Alias::new("outcome_method")).string())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("analytics_computed_at"))
                            .timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("analytics_stale"))
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fights_analytics_stale")
                    .table(Fights::Table)
                    .col(Alias::new("analytics_stale"))
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(FightStats::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FightStats::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(FightStats::FightId).big_integer().not_null())
                    .col(
                        ColumnDef::new(FightStats::SegmentCount)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::UniqueFriendlyPlayers)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::UniqueEnemyPlayers)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::FriendlyKills)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::FriendlyDeaths)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::FriendlyKillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::EnemyKills)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::EnemyDeaths)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::EnemyKillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::AvgFriendlyItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(FightStats::AvgEnemyItemPower)
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(
                        ColumnDef::new(FightStats::FriendlyEstimatedLoss)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::EnemyEstimatedLoss)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FightStats::ComputedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(FightStats::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(FightStats::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_fight_stats_fight_id")
                            .from(FightStats::Table, FightStats::FightId)
                            .to(Fights::Table, Fights::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fight_stats_fight_id_unique")
                    .table(FightStats::Table)
                    .col(FightStats::FightId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_fight_stats_computed_at")
                    .table(FightStats::Table)
                    .col(FightStats::ComputedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(FightStats::Table).to_owned())
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .drop_column(Alias::new("analytics_stale"))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .drop_column(Alias::new("analytics_computed_at"))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .drop_column(Alias::new("outcome_method"))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Fights::Table)
                    .drop_column(Alias::new("outcome"))
                    .to_owned(),
            )
            .await
    }
}

/// Minimal local iden for `fights`, covering both the `ALTER TABLE` target
/// (only `Table` is needed there) and the `fight_stats.fight_id` foreign key
/// target (`Table` + `Id`). `fights` was created by
/// `m20260901_000006_create_fights`, whose own `Fights` iden enum is not
/// `pub`, so this migration declares its own to reference the table — the
/// established workaround in this codebase for touching a table whose
/// original migration didn't make its iden enum public.
#[derive(DeriveIden)]
enum Fights {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum FightStats {
    Table,
    Id,
    FightId,
    SegmentCount,
    UniqueFriendlyPlayers,
    UniqueEnemyPlayers,
    FriendlyKills,
    FriendlyDeaths,
    FriendlyKillFame,
    EnemyKills,
    EnemyDeaths,
    EnemyKillFame,
    AvgFriendlyItemPower,
    AvgEnemyItemPower,
    FriendlyEstimatedLoss,
    EnemyEstimatedLoss,
    ComputedAt,
    CreatedAt,
    UpdatedAt,
}
