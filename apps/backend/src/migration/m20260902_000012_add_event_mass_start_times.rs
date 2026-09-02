//! Adds separate mass and automatic start timestamps to events.

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let events = Alias::new("events").into_iden();

        for column in ["mass_time_utc", "start_time_utc"] {
            manager
                .alter_table(
                    Table::alter()
                        .table(events.clone())
                        .add_column(ColumnDef::new(Alias::new(column)).timestamp_with_time_zone())
                        .to_owned(),
                )
                .await?;
        }

        // Use backend-native expressions so this migration works for both PostgreSQL and SQLite.
        let statement = match manager.get_database_backend() {
            DbBackend::Postgres => Statement::from_string(
                DbBackend::Postgres,
                "UPDATE events SET mass_time_utc = event_date_utc - INTERVAL '30 minutes', start_time_utc = event_date_utc WHERE mass_time_utc IS NULL OR start_time_utc IS NULL".to_owned(),
            ),
            DbBackend::Sqlite => Statement::from_string(
                DbBackend::Sqlite,
                "UPDATE events SET mass_time_utc = datetime(event_date_utc, '-30 minutes'), start_time_utc = event_date_utc WHERE mass_time_utc IS NULL OR start_time_utc IS NULL".to_owned(),
            ),
            backend => return Err(DbErr::Migration(format!("unsupported database backend: {backend:?}"))),
        };
        manager.get_connection().execute(statement).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let events = Alias::new("events").into_iden();
        for column in ["mass_time_utc", "start_time_utc"] {
            manager
                .alter_table(
                    Table::alter()
                        .table(events.clone())
                        .drop_column(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}
