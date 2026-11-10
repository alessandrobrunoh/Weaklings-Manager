//! Durable outbox for self-service participation forwarded to alliance event copies.
//!
//! One row per (origin event, peer tenant, participant) carries the *latest intended state*
//! of that participant on that peer: join (with builds) or leave. A newer intent overwrites
//! the row (bumping `revision`), so a retry can never resurrect a participant who has since
//! left. The row is deleted once the peer took the change.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE event_participation_forwards (
                    origin_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    origin_event_id BIGINT NOT NULL,
                    peer_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    peer_event_id BIGINT NOT NULL,
                    discord_id TEXT NOT NULL,
                    username TEXT NOT NULL,
                    from_tenant_id TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK (operation IN ('join', 'leave')),
                    primary_build_id BIGINT,
                    secondary_build_id BIGINT,
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'failed', 'exhausted')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revision BIGINT NOT NULL DEFAULT 1,
                    lease_until TIMESTAMPTZ,
                    lease_token UUID,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (origin_tenant_id, origin_event_id, peer_tenant_id, discord_id)
                );
                CREATE INDEX idx_event_participation_forwards_due
                    ON event_participation_forwards (next_attempt_at)
                    WHERE state IN ('pending', 'failed');",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS event_participation_forwards;")
            .await?;
        Ok(())
    }
}
