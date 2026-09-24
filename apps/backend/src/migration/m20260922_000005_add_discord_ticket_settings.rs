use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            (
                GuildSettings::DiscordTicketsArchiveChannelId,
                ColumnDef::new(GuildSettings::DiscordTicketsArchiveChannelId).string_len(64),
            ),
            (
                GuildSettings::DiscordTicketsWelcomeTitle,
                ColumnDef::new(GuildSettings::DiscordTicketsWelcomeTitle)
                    .string_len(256)
                    .not_null()
                    .default("Ticket di supporto"),
            ),
            (
                GuildSettings::DiscordTicketsWelcomeMessage,
                ColumnDef::new(GuildSettings::DiscordTicketsWelcomeMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Descrivi qui il problema: un membro dello staff ti risponderà appena possibile."),
            ),
            (
                GuildSettings::DiscordTicketsClosedTitle,
                ColumnDef::new(GuildSettings::DiscordTicketsClosedTitle)
                    .string_len(256)
                    .not_null()
                    .default("Ticket chiuso"),
            ),
            (
                GuildSettings::DiscordTicketsClosedMessage,
                ColumnDef::new(GuildSettings::DiscordTicketsClosedMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Questo ticket è stato chiuso."),
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
            GuildSettings::DiscordTicketsClosedMessage,
            GuildSettings::DiscordTicketsClosedTitle,
            GuildSettings::DiscordTicketsWelcomeMessage,
            GuildSettings::DiscordTicketsWelcomeTitle,
            GuildSettings::DiscordTicketsArchiveChannelId,
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
    DiscordTicketsArchiveChannelId,
    DiscordTicketsWelcomeTitle,
    DiscordTicketsWelcomeMessage,
    DiscordTicketsClosedTitle,
    DiscordTicketsClosedMessage,
}
