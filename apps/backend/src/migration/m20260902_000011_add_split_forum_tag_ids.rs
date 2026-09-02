//! Adds configurable Discord Forum tag IDs for split lifecycle states.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::DiscordSplitPendingTagId,
            GuildSettings::DiscordSplitCompletedTagId,
            GuildSettings::DiscordSplitNotCompletedTagId,
            GuildSettings::DiscordSplitLostTagId,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .add_column(ColumnDef::new(column).string_len(64))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite cannot reliably drop columns across supported versions; these settings are
        // nullable and harmless if a deployment rolls back the application binary.
        Ok(())
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordSplitPendingTagId,
    DiscordSplitCompletedTagId,
    DiscordSplitNotCompletedTagId,
    DiscordSplitLostTagId,
}
