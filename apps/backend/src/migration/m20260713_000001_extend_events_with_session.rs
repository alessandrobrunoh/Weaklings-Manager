//! Migration script to extend the `events` table with session management fields.

use sea_orm_migration::prelude::*;

/// Migration step to extend `events` with session management fields.
///
/// Each column is added through its own `ALTER TABLE` because SQLite only supports a single
/// `ALTER TABLE` action per statement; PostgreSQL tolerates multi-action alters, the in-memory
/// SQLite used by the test suite does not.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// Adds one column to `events` via a single-action `ALTER TABLE`.
async fn add_column<T: IntoTableRef>(
    manager: &SchemaManager<'_>,
    table: T,
    column_def: ColumnDef,
) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(table)
                .add_column(column_def)
                .to_owned(),
        )
        .await
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `events` already exists (see m20260711_000002). Use `Alias` to reference
        // the table and new columns without redefining the original `Events` Iden enum,
        // which would clash with the import from the creating migration.
        let events_tbl = Alias::new("events").into_iden();

        let mut column = ColumnDef::new("status");
        column.text().not_null().default("scheduled");
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("started_at");
        column.timestamp_with_time_zone();
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("stopped_at");
        column.timestamp_with_time_zone();
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("auto_stop_deadline");
        column.timestamp_with_time_zone();
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("link_status");
        column.text().not_null().default("pending");
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("link_attempts");
        column.big_integer().not_null().default(0);
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("link_last_error");
        column.text();
        add_column(manager, events_tbl.clone(), column).await?;

        let mut column = ColumnDef::new("link_battles_completed_at");
        column.timestamp_with_time_zone();
        add_column(manager, events_tbl.clone(), column).await?;

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
