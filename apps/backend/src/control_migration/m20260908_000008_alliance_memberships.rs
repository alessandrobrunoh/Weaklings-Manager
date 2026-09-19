//! Control-plane membership between an alliance tenant and guild tenants.
//!
//! A guild Discord can belong to at most one alliance (pending or active).

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS alliance_memberships (
                alliance_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                guild_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                status text NOT NULL,
                invited_by text,
                accepted_at timestamptz,
                PRIMARY KEY (alliance_tenant_id, guild_tenant_id),
                CONSTRAINT alliance_memberships_status_check
                    CHECK (status IN ('pending','active'))
            )",
        )
        .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS alliance_memberships_guild_tenant_id_key
             ON alliance_memberships (guild_tenant_id)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS alliance_memberships")
            .await?;
        Ok(())
    }
}
