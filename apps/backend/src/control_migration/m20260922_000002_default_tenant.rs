//! Adds the single platform-wide default tenant used by automatic login.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE tenants \
             ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false",
        )
        .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS tenants_single_default \
             ON tenants (is_default) WHERE is_default",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP INDEX IF EXISTS tenants_single_default")
            .await?;
        db.execute_unprepared("ALTER TABLE tenants DROP COLUMN IF EXISTS is_default")
            .await?;
        Ok(())
    }
}
