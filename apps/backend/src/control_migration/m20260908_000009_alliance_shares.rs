//! Control-plane record of an artifact published from a guild tenant into an alliance tenant.
//!
//! The published copy lives in the alliance schema (`published_id`). This row is the mapping back
//! to the source guild build, and the unique key makes re-share idempotent.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS alliance_shares (
                id uuid PRIMARY KEY,
                alliance_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                source_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                artifact_type text NOT NULL,
                source_id bigint NOT NULL,
                published_id bigint NOT NULL,
                shared_by text NOT NULL,
                shared_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT alliance_shares_artifact_type_check
                    CHECK (artifact_type IN ('build')),
                CONSTRAINT alliance_shares_source_unique
                    UNIQUE (alliance_tenant_id, artifact_type, source_tenant_id, source_id)
            )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS alliance_shares")
            .await?;
        Ok(())
    }
}
