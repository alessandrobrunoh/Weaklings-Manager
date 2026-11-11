//! Distinguishes Discord tenants that are a guild workspace from those that are an alliance hub.
//!
//! Existing rows are guilds. `kind` is required so register and the bot can branch without a
//! nullable sentinel.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE tenants \
             ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'guild'",
        )
        .await?;
        db.execute_unprepared("ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_kind_check")
            .await?;
        db.execute_unprepared(
            "ALTER TABLE tenants ADD CONSTRAINT tenants_kind_check \
             CHECK (kind IN ('guild','alliance'))",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_kind_check")
            .await?;
        db.execute_unprepared("ALTER TABLE tenants DROP COLUMN IF EXISTS kind")
            .await?;
        Ok(())
    }
}
