//! Adds the Discord channel and optional ping role used for guild giveaways.

use sea_orm_migration::prelude::*;

/// Migration step to store giveaway announcement targets on `guild_settings`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::DiscordGiveawaysChannelId).string_len(64),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::DiscordGiveawaysRoleId).string_len(64),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordGiveawaysRoleId)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordGiveawaysChannelId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordGiveawaysChannelId,
    DiscordGiveawaysRoleId,
}
