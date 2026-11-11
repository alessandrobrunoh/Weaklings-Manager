//! Guild-initiated departure from an active alliance.
//!
//! Membership and event-sync rows stay so history can still be read. Sync is
//! switched off, and Discord role cleanup is recorded before any API call.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE alliance_memberships ADD COLUMN IF NOT EXISTS left_at timestamptz",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_memberships DROP CONSTRAINT IF EXISTS alliance_memberships_status_check",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_memberships ADD CONSTRAINT alliance_memberships_status_check \
             CHECK (status IN ('pending', 'active', 'left'))",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE event_sync_links \
             ADD COLUMN IF NOT EXISTS sync_enabled boolean NOT NULL DEFAULT true",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS alliance_role_grants (
                alliance_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                guild_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                discord_guild_id text NOT NULL,
                discord_user_id text NOT NULL,
                role_id text NOT NULL,
                granted_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (
                    alliance_tenant_id, guild_tenant_id, discord_guild_id, discord_user_id, role_id
                )
            )",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS alliance_role_revocations (
                id uuid PRIMARY KEY,
                alliance_tenant_id text NOT NULL,
                guild_tenant_id text NOT NULL,
                discord_guild_id text NOT NULL,
                discord_user_id text NOT NULL,
                role_id text NOT NULL,
                status text NOT NULL,
                detail text,
                created_at timestamptz NOT NULL DEFAULT now(),
                verified_at timestamptz,
                CONSTRAINT alliance_role_revocations_status_check
                    CHECK (status IN ('pending', 'verified', 'ambiguous')),
                UNIQUE (
                    alliance_tenant_id, guild_tenant_id, discord_guild_id, discord_user_id, role_id
                )
            )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS alliance_role_revocations")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS alliance_role_grants")
            .await?;
        db.execute_unprepared("ALTER TABLE event_sync_links DROP COLUMN IF EXISTS sync_enabled")
            .await?;
        db.execute_unprepared(
            "UPDATE alliance_memberships SET status = 'active' WHERE status = 'left'",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_memberships DROP CONSTRAINT IF EXISTS alliance_memberships_status_check",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_memberships ADD CONSTRAINT alliance_memberships_status_check \
             CHECK (status IN ('pending', 'active'))",
        )
        .await?;
        db.execute_unprepared("ALTER TABLE alliance_memberships DROP COLUMN IF EXISTS left_at")
            .await?;
        Ok(())
    }
}
