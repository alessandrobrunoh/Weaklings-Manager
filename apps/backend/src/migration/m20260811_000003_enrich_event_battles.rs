//! Adds battle outcome and opponent metrics to linked event battles.
//!
//! The session linker stores a compact snapshot of AlbionBB battle summaries so
//! event and comp analytics can be rendered from the database without repeatedly
//! calling the upstream service.

use sea_orm_migration::prelude::*;

use super::m20260713_000002_create_event_battles::EventBattles;

/// Migration step for event-battle analytics columns.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .add_column(
                        ColumnDef::new(EventBattleMetrics::GuildKills)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .add_column(
                        ColumnDef::new(EventBattleMetrics::GuildDeaths)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .add_column(
                        ColumnDef::new(EventBattleMetrics::GuildKillFame)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .add_column(
                        ColumnDef::new(EventBattleMetrics::IsWin)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentGuildId).string())
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentGuildName).string())
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentPlayersCount).integer())
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentKills).big_integer())
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentDeaths).big_integer())
                    .add_column(ColumnDef::new(EventBattleMetrics::OpponentKillFame).big_integer())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(EventBattles::Table)
                    .drop_column(EventBattleMetrics::GuildKills)
                    .drop_column(EventBattleMetrics::GuildDeaths)
                    .drop_column(EventBattleMetrics::GuildKillFame)
                    .drop_column(EventBattleMetrics::IsWin)
                    .drop_column(EventBattleMetrics::OpponentGuildId)
                    .drop_column(EventBattleMetrics::OpponentGuildName)
                    .drop_column(EventBattleMetrics::OpponentPlayersCount)
                    .drop_column(EventBattleMetrics::OpponentKills)
                    .drop_column(EventBattleMetrics::OpponentDeaths)
                    .drop_column(EventBattleMetrics::OpponentKillFame)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
pub enum EventBattleMetrics {
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
