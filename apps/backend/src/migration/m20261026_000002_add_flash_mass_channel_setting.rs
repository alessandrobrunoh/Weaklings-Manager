//! Migration script adding the flash mass announcement channel setting.

use sea_orm_migration::prelude::*;

/// Adds `discord_flash_mass_channel_id` to `guild_settings`.
///
/// Flash masses (see `m20261026_000001`) announce in their own channel;
/// `NULL` means the guild has not configured one yet and the poller keeps
/// retrying loudly instead of falling back into the events or CTA channel.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("guild_settings"))
                    .add_column(
                        ColumnDef::new(Alias::new("discord_flash_mass_channel_id"))
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("guild_settings"))
                    .drop_column(Alias::new("discord_flash_mass_channel_id"))
                    .to_owned(),
            )
            .await
    }
}
