//! Stops keeping member emails on mirror requests (MS-S2 data fix).

use sea_orm_migration::prelude::*;

/// Mirror requests used to copy the requesting member's email across tenants. Identity is the
/// Discord snowflake now, so the stored addresses are cleared. The column stays for the
/// rollback window; nothing reads it after this change.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE event_mirror_requests SET actor_email = NULL WHERE actor_email IS NOT NULL;",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Cleared addresses cannot be restored.
        Ok(())
    }
}
