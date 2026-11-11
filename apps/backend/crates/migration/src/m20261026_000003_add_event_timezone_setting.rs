//! Migration script adding the guild timezone used by Discord event creation.

use sea_orm_migration::prelude::*;

/// Adds a non-empty timezone setting so `21:00` is resolved the same way for
/// every member instead of depending on the command author's device locale.
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
                        ColumnDef::new(Alias::new("discord_event_timezone"))
                            .string()
                            .not_null()
                            .default("Europe/Rome"),
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
                    .drop_column(Alias::new("discord_event_timezone"))
                    .to_owned(),
            )
            .await
    }
}
