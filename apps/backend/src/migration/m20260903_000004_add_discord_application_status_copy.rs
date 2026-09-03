//! Adds customizable application availability announcements.

use sea_orm_migration::prelude::*;

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
                        ColumnDef::new(GuildSettings::DiscordApplicationsStatusOpenMessage)
                            .string_len(4000)
                            .not_null()
                            .default("Le application sono aperte."),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::DiscordApplicationsStatusClosedMessage)
                            .string_len(4000)
                            .not_null()
                            .default("Le application sono chiuse."),
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
                    .drop_column(GuildSettings::DiscordApplicationsStatusClosedMessage)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordApplicationsStatusOpenMessage)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordApplicationsStatusOpenMessage,
    DiscordApplicationsStatusClosedMessage,
}
