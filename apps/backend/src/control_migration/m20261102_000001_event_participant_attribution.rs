//! Durable participant-to-guild attribution for linked events.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE IF NOT EXISTS event_participant_attributions (
                    id UUID PRIMARY KEY,
                    source_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    source_event_id BIGINT NOT NULL,
                    discord_id TEXT NOT NULL,
                    guild_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (source_tenant_id, source_event_id, discord_id)
                );",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS event_participant_attributions;")
            .await?;
        Ok(())
    }
}
