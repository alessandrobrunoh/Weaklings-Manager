//! Seeds `sync.view` and `sync.manage` to every role that holds `alliance.share`.
//!
//! Sync status and retry are operator tools for the same people who publish
//! into the alliance, so the grant follows that permission.

use sea_orm_migration::prelude::*;

/// Grants the two sync permissions to the holders of `alliance.share`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for permission in ["sync.view", "sync.manage"] {
            manager
                .get_connection()
                .execute_unprepared(&format!(
                    "INSERT INTO role_permissions (role_id, permission) \
                     SELECT DISTINCT role_id, '{permission}' FROM role_permissions \
                     WHERE permission = 'alliance.share' \
                     ON CONFLICT DO NOTHING"
                ))
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DELETE FROM role_permissions WHERE permission IN ('sync.view', 'sync.manage')",
            )
            .await
            .map(|_| ())
    }
}
