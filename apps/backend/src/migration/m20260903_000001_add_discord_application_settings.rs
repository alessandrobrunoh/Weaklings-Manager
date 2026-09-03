//! Adds admin-configurable Discord application workflow settings.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            (
                GuildSettings::DiscordApplicationsChannelId,
                ColumnDef::new(GuildSettings::DiscordApplicationsChannelId).string_len(64),
            ),
            (
                GuildSettings::DiscordApplicationsCategoryId,
                ColumnDef::new(GuildSettings::DiscordApplicationsCategoryId).string_len(64),
            ),
            (
                GuildSettings::DiscordApplicationsArchiveCategoryId,
                ColumnDef::new(GuildSettings::DiscordApplicationsArchiveCategoryId).string_len(64),
            ),
            (
                GuildSettings::DiscordApplicationsManageRoleId,
                ColumnDef::new(GuildSettings::DiscordApplicationsManageRoleId).string_len(64),
            ),
            (
                GuildSettings::DiscordApplicationsStatusChannelId,
                ColumnDef::new(GuildSettings::DiscordApplicationsStatusChannelId).string_len(64),
            ),
            (
                GuildSettings::DiscordApplicationsOpen,
                ColumnDef::new(GuildSettings::DiscordApplicationsOpen)
                    .boolean()
                    .not_null()
                    .default(false),
            ),
            (
                GuildSettings::DiscordApplicationsPanelTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsPanelTitle)
                    .string_len(256)
                    .not_null()
                    .default("Applications"),
            ),
            (
                GuildSettings::DiscordApplicationsPanelMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsPanelMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Clicca il pulsante per creare una application."),
            ),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .add_column(column.1)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::DiscordApplicationsPanelMessage,
            GuildSettings::DiscordApplicationsPanelTitle,
            GuildSettings::DiscordApplicationsOpen,
            GuildSettings::DiscordApplicationsStatusChannelId,
            GuildSettings::DiscordApplicationsManageRoleId,
            GuildSettings::DiscordApplicationsArchiveCategoryId,
            GuildSettings::DiscordApplicationsCategoryId,
            GuildSettings::DiscordApplicationsChannelId,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordApplicationsChannelId,
    DiscordApplicationsCategoryId,
    DiscordApplicationsArchiveCategoryId,
    DiscordApplicationsManageRoleId,
    DiscordApplicationsStatusChannelId,
    DiscordApplicationsOpen,
    DiscordApplicationsPanelTitle,
    DiscordApplicationsPanelMessage,
}
