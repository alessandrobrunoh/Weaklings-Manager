//! Clarifies the existing sidebar flag as the tenant switcher rail.

use sea_orm_migration::prelude::*;

use super::FEATURE_SIDEBAR;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                "UPDATE feature_catalog \
                 SET display_name = 'Tenant switcher', \
                     description = 'The left rail used to switch between tenants' \
                 WHERE key = '{FEATURE_SIDEBAR}'"
            ))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                "UPDATE feature_catalog \
                 SET display_name = 'Navigation sidebar', \
                     description = 'The tenant navigation sidebar shown beside the workspace' \
                 WHERE key = '{FEATURE_SIDEBAR}'"
            ))
            .await?;
        Ok(())
    }
}
