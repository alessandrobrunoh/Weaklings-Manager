//! Adds the Discord role given to alliance members on this tenant's server.
//!
//! On a guild tenant this is the local "you are in the alliance" role. On an alliance tenant it
//! is the member role on the alliance Discord. One column, meaning depends on `tenants.kind`.

use sea_orm_migration::prelude::*;

/// Migration step storing the alliance-member Discord role on `guild_settings`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(ColumnDef::new(GuildSettings::DiscordAllianceRoleId).string_len(64))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::DiscordAllianceRoleId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    DiscordAllianceRoleId,
}
