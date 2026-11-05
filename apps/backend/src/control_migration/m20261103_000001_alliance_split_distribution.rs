//! Durable batch and recipient state for alliance split projections.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE alliance_split_distribution_batches (
                    id UUID PRIMARY KEY,
                    alliance_tenant_id TEXT NOT NULL REFERENCES tenants(id),
                    split_id BIGINT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'processing'
                        CHECK (state IN ('processing', 'failed', 'complete')),
                    actor_user_id BIGINT NOT NULL,
                    last_error TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (alliance_tenant_id, split_id)
                );
                CREATE TABLE alliance_split_distribution_items (
                    batch_id UUID NOT NULL REFERENCES alliance_split_distribution_batches(id) ON DELETE CASCADE,
                    guild_tenant_id TEXT NOT NULL REFERENCES tenants(id),
                    discord_id TEXT NOT NULL,
                    source_user_id BIGINT NOT NULL,
                    destination_user_id BIGINT NOT NULL,
                    amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'complete')),
                    transaction_id BIGINT,
                    last_error TEXT,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (batch_id, discord_id)
                );
                CREATE INDEX idx_alliance_split_distribution_pending
                    ON alliance_split_distribution_batches (updated_at)
                    WHERE state IN ('processing', 'failed');",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE IF EXISTS alliance_split_distribution_items;
                 DROP TABLE IF EXISTS alliance_split_distribution_batches;",
            )
            .await?;
        Ok(())
    }
}
