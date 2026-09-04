//! Adds `archived_at` to `events` and `splits`.
//!
//! Officers used to hard-delete these rows, which either failed on foreign keys or — for splits
//! linked to an event — left the split behind with `event_id` set to NULL (`ON DELETE SET NULL`).
//! Archiving keeps the primary key, title, dates, and every dependent row. `NULL` means active.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;
use super::m20260711_000002_create_events_table::Events;

/// Migration step to add `archived_at` to events and splits.
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
                        ColumnDef::new(Alias::new("archived_at")).timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("archived_at")).timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Alias::new("archived_at"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Events::Table)
                    .drop_column(Alias::new("archived_at"))
                    .to_owned(),
            )
            .await
    }
}
