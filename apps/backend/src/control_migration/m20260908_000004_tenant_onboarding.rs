//! Per-tenant Albion settings and Discord-user memberships.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE tenants \
             ADD COLUMN IF NOT EXISTS albion_guild_id text, \
             ADD COLUMN IF NOT EXISTS albion_api_region text NOT NULL DEFAULT 'europe', \
             ADD COLUMN IF NOT EXISTS albion_allied_guild_ids text NOT NULL DEFAULT '', \
             ADD COLUMN IF NOT EXISTS albion_allied_guild_names text NOT NULL DEFAULT '', \
             ADD COLUMN IF NOT EXISTS discord_icon_hash text",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS user_tenant_memberships (
                discord_id text NOT NULL,
                tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (discord_id, tenant_id)
            )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS user_tenant_memberships")
            .await?;
        db.execute_unprepared(
            "ALTER TABLE tenants \
             DROP COLUMN IF EXISTS albion_guild_id, \
             DROP COLUMN IF EXISTS albion_api_region, \
             DROP COLUMN IF EXISTS albion_allied_guild_ids, \
             DROP COLUMN IF EXISTS albion_allied_guild_names, \
             DROP COLUMN IF EXISTS discord_icon_hash",
        )
        .await?;
        Ok(())
    }
}
