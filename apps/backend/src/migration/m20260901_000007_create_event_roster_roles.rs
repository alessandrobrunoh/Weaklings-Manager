//! Stores event-specific extra roster roles backed by existing builds.

use sea_orm_migration::prelude::*;

use super::m20260710_000005_create_builds_table::Builds;
use super::m20260711_000002_create_events_table::Events;

/// Creates the `event_roster_roles` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventRosterRoles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventRosterRoles::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EventRosterRoles::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventRosterRoles::BuildId)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_event_roster_roles_event_id")
                            .from(EventRosterRoles::Table, EventRosterRoles::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_event_roster_roles_build_id")
                            .from(EventRosterRoles::Table, EventRosterRoles::BuildId)
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_event_roster_roles_event_build_unique")
                    .table(EventRosterRoles::Table)
                    .col(EventRosterRoles::EventId)
                    .col(EventRosterRoles::BuildId)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EventRosterRoles::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum EventRosterRoles {
    Table,
    Id,
    EventId,
    BuildId,
}
