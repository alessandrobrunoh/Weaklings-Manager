//! Migration script to create the `splits` table.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;

/// Migration step to create the `splits` table representing a loot-split session.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Splits::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Splits::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Splits::CreatedBy).big_integer().not_null())
                    .col(
                        ColumnDef::new(Splits::Status)
                            .string()
                            .not_null()
                            .default("draft"),
                    )
                    .col(
                        ColumnDef::new(Splits::EstimatedMarketValue)
                            .decimal_len(16, 2)
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Splits::RepairValue)
                            .decimal_len(16, 2)
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Splits::BagsValue)
                            .decimal_len(16, 2)
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(Splits::NetValue).decimal_len(16, 2))
                    .col(ColumnDef::new(Splits::Note).string())
                    .col(
                        ColumnDef::new(Splits::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(Splits::FinalizedAt).timestamp_with_time_zone())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Splits::Table, Splits::CreatedBy)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_splits_status")
                    .table(Splits::Table)
                    .col(Splits::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Splits::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Splits {
    Table,
    Id,
    CreatedBy,
    Status,
    EstimatedMarketValue,
    RepairValue,
    BagsValue,
    NetValue,
    Note,
    CreatedAt,
    FinalizedAt,
}
