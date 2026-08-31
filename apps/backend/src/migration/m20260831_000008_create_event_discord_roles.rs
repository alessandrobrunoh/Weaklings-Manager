//! Stores the Discord roles selected for each event announcement.

use sea_orm_migration::prelude::*;

use super::m20260711_000002_create_events_table::Events;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventDiscordRoles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventDiscordRoles::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventDiscordRoles::DiscordRoleId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventDiscordRoles::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .primary_key(
                        Index::create()
                            .col(EventDiscordRoles::EventId)
                            .col(EventDiscordRoles::DiscordRoleId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_event_discord_roles_event_id")
                            .from(EventDiscordRoles::Table, EventDiscordRoles::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EventDiscordRoles::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum EventDiscordRoles {
    Table,
    EventId,
    DiscordRoleId,
    SortOrder,
}
