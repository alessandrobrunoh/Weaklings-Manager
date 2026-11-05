//! Allow one canonical event to have several tenant-local copies.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE event_sync_links \
                 DROP CONSTRAINT IF EXISTS event_sync_links_source_tenant_id_source_event_id_key",
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE INDEX IF NOT EXISTS idx_event_sync_links_source \
                 ON event_sync_links (source_tenant_id, source_event_id) \
                 WHERE sync_enabled",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DO $$ BEGIN \
                   IF EXISTS ( \
                     SELECT 1 FROM event_sync_links \
                     GROUP BY source_tenant_id, source_event_id \
                     HAVING COUNT(*) > 1 \
                   ) THEN \
                     RAISE EXCEPTION 'cannot restore one-to-one event links while fanout links exist'; \
                   END IF; \
                 END $$",
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_event_sync_links_source")
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE event_sync_links \
                 ADD CONSTRAINT event_sync_links_source_tenant_id_source_event_id_key \
                 UNIQUE (source_tenant_id, source_event_id)",
            )
            .await?;
        Ok(())
    }
}
