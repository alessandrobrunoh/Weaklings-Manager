//! Guild-wide Discord publication mode for events.

use sea_orm_migration::prelude::*;

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
                        ColumnDef::new(Alias::new("discord_event_delivery"))
                            .string_len(16)
                            .not_null()
                            .default("calendar"),
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
                    .drop_column(Alias::new("discord_event_delivery"))
                    .to_owned(),
            )
            .await
    }
}
