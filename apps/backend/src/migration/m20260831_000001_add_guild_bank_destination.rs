//! Migration to mark ledger rows whose destination is the virtual Guild Bank.

use sea_orm_migration::prelude::*;

use super::m20260709_000003_create_transactions_table::Transactions;

/// Adds an explicit virtual destination flag without changing the historical recipient foreign key.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Transactions::Table)
                    .add_column(
                        ColumnDef::new(Transactions::ToGuildBank)
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
                    .table(Transactions::Table)
                    .drop_column(Transactions::ToGuildBank)
                    .to_owned(),
            )
            .await
    }
}
