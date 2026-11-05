//! Allows one source event to sync to many tenants while preventing duplicate
//! links to the same destination tenant.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_sync_links_source_target \
                 ON event_sync_links (source_tenant_id, source_event_id, mirror_tenant_id)",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_event_sync_links_source_target")
            .await?;
        Ok(())
    }
}
