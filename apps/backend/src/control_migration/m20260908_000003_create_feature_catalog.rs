//! Feature catalog and per-tenant flag rows.
//!
//! Seeds the two MVP flags (`regolamento`, `splits.paid`). Flags default to
//! off; enabling them is a platform-admin action in later stages.

use sea_orm_migration::prelude::*;

use super::{FEATURE_REGOLAMENTO, FEATURE_SPLITS_PAID};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(FeatureCatalog::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FeatureCatalog::Key)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(FeatureCatalog::DisplayName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(FeatureCatalog::Description).string())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(TenantFeatureFlags::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(TenantFeatureFlags::TenantId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(TenantFeatureFlags::FeatureKey)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(TenantFeatureFlags::Enabled)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(TenantFeatureFlags::EnabledAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(TenantFeatureFlags::EnabledBy).string_len(64))
                    .primary_key(
                        Index::create()
                            .col(TenantFeatureFlags::TenantId)
                            .col(TenantFeatureFlags::FeatureKey),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(TenantFeatureFlags::Table, TenantFeatureFlags::TenantId)
                            .to(Tenants::Table, Tenants::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(TenantFeatureFlags::Table, TenantFeatureFlags::FeatureKey)
                            .to(FeatureCatalog::Table, FeatureCatalog::Key)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        let db = manager.get_connection();
        db.execute_unprepared(&format!(
            "INSERT INTO feature_catalog (key, display_name, description) VALUES \
             ('{FEATURE_REGOLAMENTO}', 'Regolamento', \
              'Server rules: every member can read and acknowledge; staff can edit'), \
             ('{FEATURE_SPLITS_PAID}', 'Split premium', \
              'Premium split features (Discord forum sync, islands/tabs)')"
        ))
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(TenantFeatureFlags::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(FeatureCatalog::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum FeatureCatalog {
    Table,
    Key,
    DisplayName,
    Description,
}

#[derive(DeriveIden)]
enum TenantFeatureFlags {
    Table,
    TenantId,
    FeatureKey,
    Enabled,
    EnabledAt,
    EnabledBy,
}

#[derive(DeriveIden)]
enum Tenants {
    Table,
    Id,
}
