//! Migration script to extend the `events` table with session management fields.

use sea_orm_migration::prelude::*;

/// Migration step to extend `events` with session management fields.
///
/// Each column is added through its own `ALTER TABLE` because SQLite only supports a single
/// `ALTER TABLE` action per statement; PostgreSQL tolerates multi-action alters, the in-memory
/// SQLite used by the test suite does not.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `events` already exists (see m20260711_000002). Use `Alias` to reference
        // the table and new columns without redefining the original `Events` Iden enum,
        // which would clash with the import from the creating migration.
        let events_tbl = Alias::new("events").into_iden();

        let columns = [
            (
                Alias::new("status"),
                ColumnDef::new(Alias::new("status"))
                    .text()
                    .not_null()
                    .default("scheduled"),
            ),
            (
                Alias::new("started_at"),
                ColumnDef::new(Alias::new("started_at")).timestamp_with_time_zone(),
            ),
            (
                Alias::new("stopped_at"),
                ColumnDef::new(Alias::new("stopped_at")).timestamp_with_time_zone(),
            ),
            (
                Alias::new("auto_stop_deadline"),
                ColumnDef::new(Alias::new("auto_stop_deadline")).timestamp_with_time_zone(),
            ),
            (
                Alias::new("link_status"),
                ColumnDef::new(Alias::new("link_status"))
                    .text()
                    .not_null()
                    .default("pending"),
            ),
            (
                Alias::new("link_attempts"),
                ColumnDef::new(Alias::new("link_attempts"))
                    .big_integer()
                    .not_null()
                    .default(0),
            ),
            (
                Alias::new("link_last_error"),
                ColumnDef::new(Alias::new("link_last_error")).text(),
            ),
            (
                Alias::new("link_battles_completed_at"),
                ColumnDef::new(Alias::new("link_battles_completed_at")).timestamp_with_time_zone(),
            ),
        ];

        for (_, column_def) in columns {
            manager
                .alter_table(
                    Table::alter()
                        .table(events_tbl.clone())
                        .add_column(column_def)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_index(
                Index::create()
                    .name("idx_events_session_status")
                    .table(events_tbl)
                    .col(Alias::new("status"))
                    .col(Alias::new("started_at"))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let events_tbl = Alias::new("events").into_iden();

        manager
            .drop_index(
                Index::drop()
                    .name("idx_events_session_status")
                    .table(events_tbl.clone())
                    .to_owned(),
            )
            .await?;

        for column in [
            "status",
            "started_at",
            "stopped_at",
            "auto_stop_deadline",
            "link_status",
            "link_attempts",
            "link_last_error",
            "link_battles_completed_at",
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(events_tbl.clone())
                        .drop_column(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }
}
