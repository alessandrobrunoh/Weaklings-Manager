//! Adds the percentage fee retained from a split's estimated market value.
//!
//! `m20260709_000001_create_splits_table` was later amended to declare `fee` inline, so a database
//! created from scratch already has the column and this migration would fail on it. The guard
//! keeps both paths working: existing databases get the column added, fresh ones skip it.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_column("splits", "fee").await? {
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(
                        ColumnDef::new(Splits::Fee)
                            .decimal_len(16, 2)
                            .not_null()
                            .default(20),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_column("splits", "fee").await? {
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Splits::Fee)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Splits {
    Table,
    Fee,
}
