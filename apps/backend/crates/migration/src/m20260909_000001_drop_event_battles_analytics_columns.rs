//! Drops `event_battles`'s ten denormalized analytical columns: `guild_kills`,
//! `guild_deaths`, `guild_kill_fame`, `is_win`, `opponent_guild_id`,
//! `opponent_guild_name`, `opponent_players_count`, `opponent_kills`,
//! `opponent_deaths`, `opponent_kill_fame`.
//!
//! # Why this is safe now
//!
//! This is the closing step of plan §9 ("Pulizia"). Every reader of these
//! columns was migrated first, in this order:
//! - `intel::matchups::matchups()` — `is_win` replaced by the battle's
//!   canonical Fight outcome (`fights.outcome`), resolved via the same
//!   `fight_battles` lookup the function already used for Fight-dedup.
//! - `intel::report::compute_comps()` — `is_win`/`guild_kills`/`guild_deaths`
//!   replaced by each event's distinct `fights` (deduplicated, fixing a
//!   double-count of multi-segment engagements the old per-segment summing
//!   had) joined to `fight_stats`.
//! - `events::service`'s `build_top_opponents`/`apply_read_context_to_battles`/
//!   `to_event_battle_view`/`build_performance_stats`/`get_build_performance`
//!   — opponent identity and win/loss replaced by `battle_guild_stats`
//!   (`is_friendly`, `kill_fame`) and `fights.outcome`/`fight_stats`, via the
//!   new `opponent_rollups_for_battles`/`outcome_by_battle_id` helpers.
//! - `linked_battle_snapshot`/`apply_battle_snapshot`/
//!   `apply_canonical_snapshot_metrics` (the write side) no longer populate
//!   these columns at all — `LinkedBattleSnapshot` now carries only
//!   `guild_players_count`/`battle_total_players`, the two columns this
//!   migration does NOT touch.
//!
//! `guild_players_count`, `battle_total_players`, `event_id`,
//! `albionbb_battle_id`, `battle_started_at`, `fetched_at` are unaffected —
//! `event_battles` still exists as the raw link between an Event and the
//! `AlbionBB` battles it claims, just without the derived analytics that now
//! live in the canonical evidence tables.

use sea_orm_migration::prelude::*;

/// Migration step dropping `event_battles`'s denormalized analytics columns.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `SQLite` rejects more than one alter operation per `ALTER TABLE` statement
        // ("Sqlite doesn't support multiple alter options"), unlike Postgres — so each
        // column is dropped in its own statement rather than chained on one builder.
        for column in [
            EventBattles::GuildKills,
            EventBattles::GuildDeaths,
            EventBattles::GuildKillFame,
            EventBattles::IsWin,
            EventBattles::OpponentGuildId,
            EventBattles::OpponentGuildName,
            EventBattles::OpponentPlayersCount,
            EventBattles::OpponentKills,
            EventBattles::OpponentDeaths,
            EventBattles::OpponentKillFame,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(EventBattles::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Same one-operation-per-statement constraint as `up()`.
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(
                        ColumnDef::new(EventBattles::GuildKills)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(
                        ColumnDef::new(EventBattles::GuildDeaths)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(
                        ColumnDef::new(EventBattles::GuildKillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(
                        ColumnDef::new(EventBattles::IsWin)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentGuildId).string())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentGuildName).string())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentPlayersCount).integer())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentKills).big_integer())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentDeaths).big_integer())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(ColumnDef::new(EventBattles::OpponentKillFame).big_integer())
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum EventBattles {
    Table,
    GuildKills,
    GuildDeaths,
    GuildKillFame,
    IsWin,
    OpponentGuildId,
    OpponentGuildName,
    OpponentPlayersCount,
    OpponentKills,
    OpponentDeaths,
    OpponentKillFame,
}
