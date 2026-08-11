//! Migration script to extend the `events` table with session management fields.

use sea_orm_migration::prelude::*;

/// Migration step to extend `events` with session management fields.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `events` already exists (see m20260711_000002). Use `Alias` to reference
        // the table and new columns without redefining the original `Events` Iden enum,
        // which would clash with the import from the creating migration.
        let events_tbl = Alias::new("events").into_iden();

        manager
            .alter_table(
                Table::alter()
                    .table(events_tbl.clone())
                    .add_column(
                        ColumnDef::new(Alias::new("status"))
                            .text()
                            .not_null()
                            .default("scheduled"),
                    )
                    .add_column(ColumnDef::new(Alias::new("started_at")).timestamp_with_time_zone())
                    .add_column(ColumnDef::new(Alias::new("stopped_at")).timestamp_with_time_zone())
                    .add_column(
                        ColumnDef::new(Alias::new("auto_stop_deadline")).timestamp_with_time_zone(),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("link_status"))
                            .text()
                            .not_null()
                            .default("pending"),
                    )
                    .add_column(
                        ColumnDef::new(Alias::new("link_attempts"))
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .add_column(ColumnDef::new(Alias::new("link_last_error")).text())
                    .add_column(
                        ColumnDef::new(Alias::new("link_battles_completed_at"))
                            .timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await?;

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

        manager
            .alter_table(
                Table::alter()
                    .table(events_tbl)
                    .drop_column(Alias::new("status"))
                    .drop_column(Alias::new("started_at"))
                    .drop_column(Alias::new("stopped_at"))
                    .drop_column(Alias::new("auto_stop_deadline"))
                    .drop_column(Alias::new("link_status"))
                    .drop_column(Alias::new("link_attempts"))
                    .drop_column(Alias::new("link_last_error"))
                    .drop_column(Alias::new("link_battles_completed_at"))
                    .to_owned(),
            )
            .await
    }
}
