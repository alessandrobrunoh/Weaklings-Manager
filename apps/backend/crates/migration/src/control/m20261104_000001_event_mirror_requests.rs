//! Durable retry state for guild-to-alliance event mirrors.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE IF NOT EXISTS event_mirror_requests (
                    id UUID PRIMARY KEY,
                    source_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    source_event_id BIGINT NOT NULL,
                    actor_discord_id TEXT NOT NULL,
                    actor_username TEXT NOT NULL,
                    actor_email TEXT,
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'processing', 'complete', 'failed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    mirror_event_id BIGINT,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    lease_until TIMESTAMPTZ,
                    lease_token UUID,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (source_tenant_id, source_event_id)
                );
                CREATE INDEX IF NOT EXISTS idx_event_mirror_requests_pending
                    ON event_mirror_requests (next_attempt_at)
                    WHERE state IN ('pending', 'failed', 'processing');",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS event_mirror_requests;")
            .await?;
        Ok(())
    }
}
