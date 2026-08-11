//! Adds battle outcome and opponent metrics to linked event battles.
//!
//! The session linker stores a compact snapshot of AlbionBB battle summaries so
//! event and comp analytics can be rendered from the database without repeatedly
//! calling the upstream service.

use sea_orm_migration::prelude::*;

use super::m20260713_000002_create_event_battles::EventBattles;

/// Migration step for event-battle analytics columns.
///
/// Each column is added through its own `ALTER TABLE` because SQLite only supports a single
/// `ALTER TABLE` action per statement; PostgreSQL tolerates multi-action alters, the in-memory
/// SQLite used by the test suite does not.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// Adds one column to `event_battles` via a single-action `ALTER TABLE`.
async fn add_column(manager: &SchemaManager<'_>, column_def: ColumnDef) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(EventBattles::Table)
                .add_column(column_def)
                .to_owned(),
        )
        .await
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let mut column = ColumnDef::new("guild_kills");
        column.big_integer().not_null().default(0);
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("guild_deaths");
        column.big_integer().not_null().default(0);
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("guild_kill_fame");
        column.big_integer().not_null().default(0);
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("is_win");
        column.boolean().not_null().default(false);
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_guild_id");
        column.string();
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_guild_name");
        column.string();
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_players_count");
        column.integer();
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_kills");
        column.big_integer();
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_deaths");
        column.big_integer();
        add_column(manager, column).await?;

        let mut column = ColumnDef::new("opponent_kill_fame");
        column.big_integer();
        add_column(manager, column).await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            "guild_kills",
            "guild_deaths",
            "guild_kill_fame",
            "is_win",
            "opponent_guild_id",
            "opponent_guild_name",
            "opponent_players_count",
            "opponent_kills",
            "opponent_deaths",
            "opponent_kill_fame",
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(EventBattles::Table)
                        .drop_column(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }
}
