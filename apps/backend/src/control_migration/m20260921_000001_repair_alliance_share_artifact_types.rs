//! Restore split shares on databases that applied the composition migration after the split migration.

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
             CHECK (artifact_type IN ('build', 'comp', 'split'))",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // The repaired constraint is the canonical current schema. There is no safe
        // downgrade that can remove split rows already written by this migration.
        Ok(())
    }
}
