//! Durable control-plane state for retryable event fanout.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE event_fanout_jobs (
                    id UUID PRIMARY KEY,
                    source_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    source_event_id BIGINT NOT NULL,
                    operation TEXT NOT NULL CHECK (operation IN ('publish', 'update', 'archive')),
                    idempotency_key TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'processing', 'complete', 'failed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    lease_until TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (source_tenant_id, source_event_id, operation, idempotency_key)
                );
                CREATE TABLE event_fanout_targets (
                    job_id UUID NOT NULL REFERENCES event_fanout_jobs(id) ON DELETE CASCADE,
                    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'processing', 'complete', 'failed', 'inactive')),
                    destination_event_id BIGINT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    lease_until TIMESTAMPTZ,
                    lease_token UUID,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (job_id, tenant_id)
                );
                CREATE TABLE event_fanout_assets (
                    job_id UUID NOT NULL,
                    tenant_id TEXT NOT NULL,
                    asset_type TEXT NOT NULL CHECK (asset_type IN ('comp', 'build')),
                    source_id BIGINT NOT NULL,
                    destination_id BIGINT NOT NULL,
                    PRIMARY KEY (job_id, tenant_id, asset_type, source_id),
                    CONSTRAINT fk_event_fanout_assets_target
                        FOREIGN KEY (job_id, tenant_id)
                        REFERENCES event_fanout_targets(job_id, tenant_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX idx_event_fanout_jobs_pending
                    ON event_fanout_jobs (next_attempt_at, created_at)
                    WHERE state IN ('pending', 'failed', 'processing');
                CREATE INDEX idx_event_fanout_targets_pending
                    ON event_fanout_targets (job_id, next_attempt_at, tenant_id)
                    WHERE state IN ('pending', 'failed', 'processing');",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE IF EXISTS event_fanout_assets;
                 DROP TABLE IF EXISTS event_fanout_targets;
                 DROP TABLE IF EXISTS event_fanout_jobs;",
            )
            .await?;
        Ok(())
    }
}
