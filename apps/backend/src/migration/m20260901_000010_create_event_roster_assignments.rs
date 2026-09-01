//! Adds durable event roster assignments and their optimistic revision.

use sea_orm_migration::prelude::*;

/// Adds the roster revision to events and creates seat assignments.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Events::Table)
                    .add_column(
                        ColumnDef::new(Events::RosterVersion)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(EventRosterAssignments::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventRosterAssignments::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventRosterAssignments::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventRosterAssignments::SeatKey)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventRosterAssignments::AssignedBy)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventRosterAssignments::AssignedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(EventRosterAssignments::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .primary_key(
                        Index::create()
                            .col(EventRosterAssignments::EventId)
                            .col(EventRosterAssignments::UserId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                EventRosterAssignments::Table,
                                EventRosterAssignments::EventId,
                            )
                            .to(Events::Table, Events::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                EventRosterAssignments::Table,
                                EventRosterAssignments::UserId,
                            )
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                EventRosterAssignments::Table,
                                EventRosterAssignments::AssignedBy,
                            )
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_event_roster_assignments_event_seat_unique")
                    .table(EventRosterAssignments::Table)
                    .col(EventRosterAssignments::EventId)
                    .col(EventRosterAssignments::SeatKey)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(EventRosterAssignments::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Events::Table)
                    .drop_column(Events::RosterVersion)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Events {
    Table,
    Id,
    RosterVersion,
}
#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
#[derive(DeriveIden)]
enum EventRosterAssignments {
    Table,
    EventId,
    UserId,
    SeatKey,
    AssignedBy,
    AssignedAt,
    UpdatedAt,
}
