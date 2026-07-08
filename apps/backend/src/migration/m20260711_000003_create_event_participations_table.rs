//! Migration script to create the `event_participations` table.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260710_000005_create_builds_table::Builds;
use super::m20260711_000002_create_events_table::Events;

/// Migration step to create the `event_participations` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventParticipations::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventParticipations::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(EventParticipations::EventId).big_integer().not_null())
                    .col(ColumnDef::new(EventParticipations::UserId).big_integer().not_null())
                    .col(ColumnDef::new(EventParticipations::PrimaryBuildId).big_integer().not_null())
                    .col(ColumnDef::new(EventParticipations::SecondaryBuildId).big_integer())
                    .col(
                        ColumnDef::new(EventParticipations::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(EventParticipations::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(EventParticipations::Table, EventParticipations::EventId)
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(EventParticipations::Table, EventParticipations::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(EventParticipations::Table, EventParticipations::PrimaryBuildId)
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(EventParticipations::Table, EventParticipations::SecondaryBuildId)
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;

        // Add unique constraint on (event_id, user_id)
        manager
            .create_index(
                Index::create()
                    .name("idx_event_participations_event_id_user_id_unique")
                    .table(EventParticipations::Table)
                    .col(EventParticipations::EventId)
                    .col(EventParticipations::UserId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // Add index for event_id lookups
        manager
            .create_index(
                Index::create()
                    .name("idx_event_participations_event_id")
                    .table(EventParticipations::Table)
                    .col(EventParticipations::EventId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EventParticipations::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum EventParticipations {
    Table,
    Id,
    EventId,
    UserId,
    PrimaryBuildId,
    SecondaryBuildId,
    CreatedAt,
    UpdatedAt,
}
