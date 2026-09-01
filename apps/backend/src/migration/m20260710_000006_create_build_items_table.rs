//! Migration script to create the `build_items` table.

use sea_orm_migration::prelude::*;

use super::m20260710_000005_create_builds_table::Builds;

/// Migration step to create the `build_items` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BuildItems::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BuildItems::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BuildItems::BuildId).big_integer().not_null())
                    .col(ColumnDef::new(BuildItems::Slot).string().not_null())
                    .col(
                        ColumnDef::new(BuildItems::OpenalbionItemType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BuildItems::OpenalbionItemId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(BuildItems::OpenalbionItemName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BuildItems::OpenalbionItemIcon).string())
                    .col(ColumnDef::new(BuildItems::OpenalbionItemTier).string())
                    .col(
                        ColumnDef::new(BuildItems::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(BuildItems::Table, BuildItems::BuildId)
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // Add unique constraint on (build_id, slot)
        manager
            .create_index(
                Index::create()
                    .name("idx_build_items_build_id_slot_unique")
                    .table(BuildItems::Table)
                    .col(BuildItems::BuildId)
                    .col(BuildItems::Slot)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // Add index for build_id lookups
        manager
            .create_index(
                Index::create()
                    .name("idx_build_items_build_id")
                    .table(BuildItems::Table)
                    .col(BuildItems::BuildId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BuildItems::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum BuildItems {
    Table,
    Id,
    BuildId,
    Slot,
    OpenalbionItemType,
    OpenalbionItemId,
    OpenalbionItemName,
    OpenalbionItemIcon,
    OpenalbionItemTier,
    CreatedAt,
}
