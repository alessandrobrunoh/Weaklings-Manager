//! Store the source identity used to deduplicate cross-tenant event copies.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE events
                    ADD COLUMN source_tenant_id TEXT,
                    ADD COLUMN source_event_id BIGINT;
                 ALTER TABLE events
                    ADD CONSTRAINT uq_events_source_identity
                    UNIQUE (source_tenant_id, source_event_id);",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE events DROP CONSTRAINT uq_events_source_identity;
                 ALTER TABLE events DROP COLUMN source_tenant_id, DROP COLUMN source_event_id;",
            )
            .await?;
        Ok(())
    }
}
