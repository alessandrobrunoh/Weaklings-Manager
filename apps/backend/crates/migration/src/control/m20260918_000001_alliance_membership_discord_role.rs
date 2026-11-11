//! Per-guild Discord role on the alliance hub.
//!
//! Alliance Discords assign a different role to members of each invited guild.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE alliance_memberships \
                 ADD COLUMN IF NOT EXISTS discord_role_id text",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE alliance_memberships DROP COLUMN IF EXISTS discord_role_id",
            )
            .await?;
        Ok(())
    }
}
