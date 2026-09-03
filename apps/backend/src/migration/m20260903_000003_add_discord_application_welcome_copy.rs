//! Adds customizable copy for the application welcome message.

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
                        ColumnDef::new(GuildSettings::DiscordApplicationsWelcomeTitle)
                            .string_len(256)
                            .not_null()
                            .default("Benvenuto"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::DiscordApplicationsWelcomeMessage)
                            .string_len(4000)
                            .not_null()
                            .default("Di cosa hai bisogno?"),
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
                    .drop_column(GuildSettings::DiscordApplicationsWelcomeMessage)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordApplicationsWelcomeTitle)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordApplicationsWelcomeTitle,
    DiscordApplicationsWelcomeMessage,
}
