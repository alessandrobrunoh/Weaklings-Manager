//! Control-plane pieces of Discord delivery: per-tenant delivery mode and bot instances (DO-S1).

use sea_orm_migration::prelude::*;

/// Adds `tenants.discord_delivery_mode` (`off` by default, so nothing changes until a flip)
/// and the `discord_bot_instances` registry used for routing and the "bot offline" signal.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE tenants ADD COLUMN discord_delivery_mode TEXT NOT NULL DEFAULT 'off' \
             CHECK (discord_delivery_mode IN ('off', 'shadow', 'on'))",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE discord_bot_instances (
                instance_id TEXT PRIMARY KEY,
                guild_ids TEXT[] NOT NULL DEFAULT '{}',
                bot_version TEXT,
                protocol INTEGER NOT NULL,
                transport TEXT NOT NULL DEFAULT 'poll' CHECK (transport IN ('sse', 'poll')),
                connected_at TIMESTAMPTZ,
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX ix_bot_instances_seen ON discord_bot_instances (last_seen_at)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS discord_bot_instances")
            .await?;
        db.execute_unprepared("ALTER TABLE tenants DROP COLUMN IF EXISTS discord_delivery_mode")
            .await?;
        Ok(())
    }
}
