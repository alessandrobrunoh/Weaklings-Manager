//! Store the source identity used to deduplicate cross-tenant event copies.

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        if manager.get_database_backend() == DatabaseBackend::Postgres {
            db.execute_unprepared(
                "ALTER TABLE events
                    ADD COLUMN source_tenant_id TEXT,
                    ADD COLUMN source_event_id BIGINT;
                 ALTER TABLE events
                    ADD CONSTRAINT uq_events_source_identity
                    UNIQUE (source_tenant_id, source_event_id);",
            )
            .await?;
            return Ok(());
        }

        // SQLite (in-memory test backend) accepts one ADD COLUMN per ALTER TABLE and cannot add
        // a named constraint to an existing table; a unique index enforces the same rule.
        db.execute_unprepared("ALTER TABLE events ADD COLUMN source_tenant_id TEXT")
            .await?;
        db.execute_unprepared("ALTER TABLE events ADD COLUMN source_event_id BIGINT")
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX uq_events_source_identity
                ON events (source_tenant_id, source_event_id)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        if manager.get_database_backend() == DatabaseBackend::Postgres {
            db.execute_unprepared(
                "ALTER TABLE events DROP CONSTRAINT uq_events_source_identity;
                 ALTER TABLE events DROP COLUMN source_tenant_id, DROP COLUMN source_event_id;",
            )
            .await?;
            return Ok(());
        }

        db.execute_unprepared("DROP INDEX uq_events_source_identity")
            .await?;
        db.execute_unprepared("ALTER TABLE events DROP COLUMN source_event_id")
            .await?;
        db.execute_unprepared("ALTER TABLE events DROP COLUMN source_tenant_id")
            .await?;
        Ok(())
    }
}
