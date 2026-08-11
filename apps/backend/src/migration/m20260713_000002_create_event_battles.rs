//! Migration script to create the `event_battles` table.

use sea_orm_migration::prelude::*;

use super::m20260711_000002_create_events_table::Events;

/// Migration step to create the `event_battles` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventBattles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventBattles::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EventBattles::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventBattles::AlbionbbBattleId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventBattles::BattleStartedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventBattles::GuildPlayersCount)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(EventBattles::BattleTotalPlayers).integer())
                    .col(
                        ColumnDef::new(EventBattles::FetchedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(EventBattles::Table, EventBattles::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Add unique constraint on (event_id, albionbb_battle_id)
        manager
            .create_index(
                Index::create()
                    .name("idx_event_battles_event_id_albionbb_battle_id_unique")
                    .table(EventBattles::Table)
                    .col(EventBattles::EventId)
                    .col(EventBattles::AlbionbbBattleId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // Add index for (event_id, battle_started_at) queries
        manager
            .create_index(
                Index::create()
                    .name("idx_event_battles_event_started")
                    .table(EventBattles::Table)
                    .col(EventBattles::EventId)
                    .col(EventBattles::BattleStartedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EventBattles::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum EventBattles {
    Table,
    Id,
    EventId,
    AlbionbbBattleId,
    BattleStartedAt,
    GuildPlayersCount,
    BattleTotalPlayers,
    FetchedAt,
}
