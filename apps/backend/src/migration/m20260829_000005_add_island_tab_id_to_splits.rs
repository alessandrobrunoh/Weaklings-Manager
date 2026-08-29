//! Optional location of a loot split: which island tab the haul sits in.
//!
//! Nullable so historical splits stay valid. New creates require the column at the API layer.

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(ColumnDef::new(SplitIslandLink::IslandTabId).big_integer())
                    .to_owned(),
            )
            .await?;

        if manager.get_database_backend() == DatabaseBackend::Postgres {
            manager
                .create_foreign_key(
                    ForeignKey::create()
                        .name("fk_splits_island_tab_id")
                        .from(Splits::Table, SplitIslandLink::IslandTabId)
                        .to(SplitIslandTabs::Table, SplitIslandTabs::Id)
                        .on_delete(ForeignKeyAction::Restrict)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_index(
                Index::create()
                    .name("idx_splits_island_tab_id")
                    .table(Splits::Table)
                    .col(SplitIslandLink::IslandTabId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_splits_island_tab_id")
                    .table(Splits::Table)
                    .to_owned(),
            )
            .await?;

        if manager.get_database_backend() == DatabaseBackend::Postgres {
            manager
                .drop_foreign_key(
                    ForeignKey::drop()
                        .name("fk_splits_island_tab_id")
                        .table(Splits::Table)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(SplitIslandLink::IslandTabId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SplitIslandLink {
    IslandTabId,
}

#[derive(DeriveIden)]
enum SplitIslandTabs {
    Table,
    Id,
}
