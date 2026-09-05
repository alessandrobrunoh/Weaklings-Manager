//! Individual bag amounts for a loot split.
//!
//! `splits.bags_value` stays the sum used by net-value math. This table stores
//! the separate bags an officer entered so they can be edited one by one.
//! Existing non-zero totals are copied as a single bag.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;

/// Migration step to create `split_bags` and backfill from `splits.bags_value`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SplitBags::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SplitBags::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SplitBags::SplitId).big_integer().not_null())
                    .col(
                        ColumnDef::new(SplitBags::Amount)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SplitBags::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SplitBags::Table, SplitBags::SplitId)
                            .to(Splits::Table, Splits::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_split_bags_split_id")
                    .table(SplitBags::Table)
                    .col(SplitBags::SplitId)
                    .to_owned(),
            )
            .await?;

        let db = manager.get_connection();
        db.execute_unprepared(
            "INSERT INTO split_bags (split_id, amount) SELECT id, bags_value FROM splits WHERE bags_value > 0",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SplitBags::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SplitBags {
    Table,
    Id,
    SplitId,
    Amount,
    CreatedAt,
}
