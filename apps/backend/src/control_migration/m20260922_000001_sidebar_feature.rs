//! Adds the tenant navigation sidebar as a platform-configurable feature.

use sea_orm_migration::prelude::*;

use super::FEATURE_SIDEBAR;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(&format!(
            "INSERT INTO feature_catalog (key, display_name, description, always_on) \
             VALUES ('{FEATURE_SIDEBAR}', 'Navigation sidebar', \
              'The tenant navigation sidebar shown beside the workspace', false) \
             ON CONFLICT (key) DO NOTHING"
        ))
        .await?;

        // The sidebar is enabled for all existing tenants on rollout. The
        // conflict clause preserves a platform admin's choice if this
        // migration is ever replayed against a partially upgraded database.
        db.execute_unprepared(&format!(
            "INSERT INTO tenant_feature_flags \
             (tenant_id, feature_key, enabled, enabled_at, enabled_by) \
             SELECT id, '{FEATURE_SIDEBAR}', true, now(), 'migration' \
             FROM tenants \
             ON CONFLICT (tenant_id, feature_key) DO NOTHING"
        ))
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(&format!(
            "DELETE FROM tenant_feature_flags WHERE feature_key = '{FEATURE_SIDEBAR}'"
        ))
        .await?;
        db.execute_unprepared(&format!(
            "DELETE FROM feature_catalog WHERE key = '{FEATURE_SIDEBAR}'"
        ))
        .await?;
        Ok(())
    }
}
