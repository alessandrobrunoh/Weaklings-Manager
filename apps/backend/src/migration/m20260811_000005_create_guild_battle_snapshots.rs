//! Creates persistent guild battle snapshots.
//!
//! AlbionBB is the source of truth, but analytics must be queryable from our DB without repeatedly
//! scraping upstream. This table stores the hydrated battle payload plus derived market loss
//! estimates as JSON strings so future player/build/comp dashboards can aggregate locally.

use sea_orm_migration::prelude::*;

/// Migration step for persisted guild battle analytics snapshots.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(GuildBattleSnapshots::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::BattleId)
                            .big_integer()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::StartTime)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(GuildBattleSnapshots::EndTime).timestamp_with_time_zone())
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::TotalPlayers)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::TotalKills)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::TotalFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::GuildsJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::PlayersJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::KillsJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::LossesJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GuildBattleSnapshots::FetchedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_guild_battle_snapshots_start_time")
                    .table(GuildBattleSnapshots::Table)
                    .col(GuildBattleSnapshots::StartTime)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(GuildBattleSnapshots::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum GuildBattleSnapshots {
    Table,
    Id,
    BattleId,
    StartTime,
    EndTime,
    TotalPlayers,
    TotalKills,
    TotalFame,
    GuildsJson,
    PlayersJson,
    KillsJson,
    LossesJson,
    FetchedAt,
}
