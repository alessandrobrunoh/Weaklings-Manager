//! Control-plane links between a guild event and its alliance mirror.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE IF NOT EXISTS event_sync_links (
                    id uuid PRIMARY KEY,
                    source_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    source_event_id bigint NOT NULL,
                    mirror_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    mirror_event_id bigint NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now(),
                    UNIQUE (source_tenant_id, source_event_id),
                    UNIQUE (mirror_tenant_id, mirror_event_id)
                )",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS event_sync_links")
            .await?;
        Ok(())
    }
}
