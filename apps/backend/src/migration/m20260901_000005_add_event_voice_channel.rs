//! Adds the optional Discord voice channel ID created for a live event.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Events::Table)
                    .add_column(ColumnDef::new(Events::DiscordVoiceChannelId).string_len(64))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Events::Table)
                    .drop_column(Events::DiscordVoiceChannelId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Events {
    Table,
    DiscordVoiceChannelId,
}
