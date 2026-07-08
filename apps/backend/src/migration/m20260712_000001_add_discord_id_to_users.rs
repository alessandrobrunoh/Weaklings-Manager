//! Migration script to add the `discord_id` column to the `users` table.
//!
//! Bridges `users` to `albion_links` (keyed by Discord snowflake), so an Albion Online
//! character name linked via `albion_links` can be resolved back to a `users.id`.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;

/// Migration step to add `discord_id` to users.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(ColumnDef::new(Alias::new("discord_id")).string())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_users_discord_id")
                    .table(Users::Table)
                    .col(Alias::new("discord_id"))
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(Index::drop().name("idx_users_discord_id").table(Users::Table).to_owned())
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .drop_column(Alias::new("discord_id"))
                    .to_owned(),
            )
            .await
    }
}
