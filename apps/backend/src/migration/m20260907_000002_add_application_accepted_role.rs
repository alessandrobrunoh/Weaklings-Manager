//! Adds the Discord role assigned when an application is accepted.

use sea_orm_migration::prelude::*;

/// Migration step to store the accepted application Discord role on `guild_settings`.
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
                        ColumnDef::new(GuildSettings::DiscordApplicationsAcceptedRoleId)
                            .string_len(64),
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
                    .drop_column(GuildSettings::DiscordApplicationsAcceptedRoleId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordApplicationsAcceptedRoleId,
}
