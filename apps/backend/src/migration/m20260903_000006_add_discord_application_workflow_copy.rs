//! Adds admin-configurable copy for every Discord application workflow response.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for (column, definition) in [
            (
                GuildSettings::DiscordApplicationsManageTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsManageTitle)
                    .string_len(256)
                    .not_null()
                    .default("Gestione application"),
            ),
            (
                GuildSettings::DiscordApplicationsManageMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsManageMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Scegli Accept o Decline."),
            ),
            (
                GuildSettings::DiscordApplicationsClosedMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsClosedMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Le application sono momentaneamente chiuse."),
            ),
            (
                GuildSettings::DiscordApplicationsClosedTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsClosedTitle)
                    .string_len(256)
                    .not_null()
                    .default("Applications closed"),
            ),
            (
                GuildSettings::DiscordApplicationsCloseTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsCloseTitle)
                    .string_len(256)
                    .not_null()
                    .default("Application chiusa"),
            ),
            (
                GuildSettings::DiscordApplicationsCloseMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsCloseMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Application chiusa."),
            ),
            (
                GuildSettings::DiscordApplicationsAcceptTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsAcceptTitle)
                    .string_len(256)
                    .not_null()
                    .default("Application accettata"),
            ),
            (
                GuildSettings::DiscordApplicationsDeclineTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsDeclineTitle)
                    .string_len(256)
                    .not_null()
                    .default("Application rifiutata"),
            ),
            (
                GuildSettings::DiscordApplicationsNoPermissionTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsNoPermissionTitle)
                    .string_len(256)
                    .not_null()
                    .default("Permessi insufficienti"),
            ),
            (
                GuildSettings::DiscordApplicationsAlreadyOpenTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsAlreadyOpenTitle)
                    .string_len(256)
                    .not_null()
                    .default("Application already open"),
            ),
            (
                GuildSettings::DiscordApplicationsFinalTitle,
                ColumnDef::new(GuildSettings::DiscordApplicationsFinalTitle)
                    .string_len(256)
                    .not_null()
                    .default("Application conclusa"),
            ),
            (
                GuildSettings::DiscordApplicationsNoPermissionMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsNoPermissionMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Non hai i permessi per questa azione."),
            ),
            (
                GuildSettings::DiscordApplicationsAlreadyOpenMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsAlreadyOpenMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Hai già un'applicatione aperta."),
            ),
            (
                GuildSettings::DiscordApplicationsAcceptMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsAcceptMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Application accettata."),
            ),
            (
                GuildSettings::DiscordApplicationsDeclineMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsDeclineMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Application rifiutata."),
            ),
            (
                GuildSettings::DiscordApplicationsErrorMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsErrorMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Si è verificato un errore durante l'elaborazione dell'application."),
            ),
            (
                GuildSettings::DiscordApplicationsResultMessage,
                ColumnDef::new(GuildSettings::DiscordApplicationsResultMessage)
                    .string_len(4000)
                    .not_null()
                    .default("Application aggiornata."),
            ),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .add_column(definition)
                        .to_owned(),
                )
                .await
                .map_err(|error| {
                    // Keep the tuple's column name useful in migration logs without changing the
                    // database error type used by SeaORM.
                    let _ = column;
                    error
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::DiscordApplicationsResultMessage,
            GuildSettings::DiscordApplicationsErrorMessage,
            GuildSettings::DiscordApplicationsDeclineMessage,
            GuildSettings::DiscordApplicationsAcceptMessage,
            GuildSettings::DiscordApplicationsAlreadyOpenMessage,
            GuildSettings::DiscordApplicationsNoPermissionMessage,
            GuildSettings::DiscordApplicationsFinalTitle,
            GuildSettings::DiscordApplicationsAlreadyOpenTitle,
            GuildSettings::DiscordApplicationsNoPermissionTitle,
            GuildSettings::DiscordApplicationsDeclineTitle,
            GuildSettings::DiscordApplicationsAcceptTitle,
            GuildSettings::DiscordApplicationsCloseMessage,
            GuildSettings::DiscordApplicationsCloseTitle,
            GuildSettings::DiscordApplicationsClosedTitle,
            GuildSettings::DiscordApplicationsClosedMessage,
            GuildSettings::DiscordApplicationsManageMessage,
            GuildSettings::DiscordApplicationsManageTitle,
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
    DiscordApplicationsManageTitle,
    DiscordApplicationsManageMessage,
    DiscordApplicationsClosedMessage,
    DiscordApplicationsClosedTitle,
    DiscordApplicationsCloseTitle,
    DiscordApplicationsCloseMessage,
    DiscordApplicationsAcceptTitle,
    DiscordApplicationsDeclineTitle,
    DiscordApplicationsNoPermissionTitle,
    DiscordApplicationsAlreadyOpenTitle,
    DiscordApplicationsFinalTitle,
    DiscordApplicationsNoPermissionMessage,
    DiscordApplicationsAlreadyOpenMessage,
    DiscordApplicationsAcceptMessage,
    DiscordApplicationsDeclineMessage,
    DiscordApplicationsErrorMessage,
    DiscordApplicationsResultMessage,
}
