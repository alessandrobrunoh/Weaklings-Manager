//! Allow `alliance_shares.artifact_type` to record a published composition snapshot.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE alliance_shares DROP CONSTRAINT IF EXISTS alliance_shares_artifact_type_check",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_shares ADD CONSTRAINT alliance_shares_artifact_type_check \
             CHECK (artifact_type IN ('build', 'comp'))",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE alliance_shares DROP CONSTRAINT IF EXISTS alliance_shares_artifact_type_check",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE alliance_shares ADD CONSTRAINT alliance_shares_artifact_type_check \
             CHECK (artifact_type IN ('build'))",
        )
        .await?;
        Ok(())
    }
}
