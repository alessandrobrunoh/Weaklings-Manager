//! Migration script to create the `transactions` table (the Guild Bank ledger).

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260709_000001_create_splits_table::Splits;

/// Migration step to create the `transactions` table representing the Guild Bank ledger.
///
/// `from_user_id` is nullable: `NULL` represents the Guild Bank (a virtual party, not a real user row).
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Transactions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Transactions::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Transactions::FromUserId).big_integer())
                    .col(
                        ColumnDef::new(Transactions::ToUserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Transactions::Amount)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Transactions::Status)
                            .string()
                            .not_null()
                            .default("pending"),
                    )
                    .col(ColumnDef::new(Transactions::Type).string().not_null())
                    .col(ColumnDef::new(Transactions::SplitId).big_integer())
                    .col(
                        ColumnDef::new(Transactions::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(Transactions::WithdrawnAt).timestamp_with_time_zone())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Transactions::Table, Transactions::FromUserId)
                            .to(Users::Table, Users::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Transactions::Table, Transactions::ToUserId)
                            .to(Users::Table, Users::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Transactions::Table, Transactions::SplitId)
                            .to(Splits::Table, Splits::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_transactions_to_user_status")
                    .table(Transactions::Table)
                    .col(Transactions::ToUserId)
                    .col(Transactions::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_transactions_split_id")
                    .table(Transactions::Table)
                    .col(Transactions::SplitId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Transactions::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Transactions {
    Table,
    Id,
    FromUserId,
    ToUserId,
    ToGuildBank,
    Amount,
    Status,
    Type,
    SplitId,
    CreatedAt,
    WithdrawnAt,
    /// Added by `m20260709_000005_add_requested_at_to_transactions`.
    RequestedAt,
}
