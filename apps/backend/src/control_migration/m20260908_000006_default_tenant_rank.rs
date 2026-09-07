//! Marks one tenant rank as the default handed to newly registered tenants.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE tenant_ranks \
             ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false",
        )
        .await?;
        // Partial unique index: at most one rank may carry the default flag.
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS tenant_ranks_single_default \
             ON tenant_ranks (is_default) WHERE is_default",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP INDEX IF EXISTS tenant_ranks_single_default")
            .await?;
        db.execute_unprepared("ALTER TABLE tenant_ranks DROP COLUMN IF EXISTS is_default")
            .await?;
        Ok(())
    }
}
