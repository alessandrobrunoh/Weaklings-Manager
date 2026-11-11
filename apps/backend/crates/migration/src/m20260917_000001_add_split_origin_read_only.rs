//! Marks loot-split rows that are a published alliance snapshot and must not be mutated.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;

/// Adds `splits.origin_read_only` (false for guild-owned rows).
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("origin_read_only"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Alias::new("origin_read_only"))
                    .to_owned(),
            )
            .await
    }
}
