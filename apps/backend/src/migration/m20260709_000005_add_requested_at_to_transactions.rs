//! Migration script to add the `requested_at` column to `transactions`, backing the
//! request-then-accept withdrawal workflow: a user requests a withdrawal (pending -> requested),
//! then an officer accepts it (requested -> withdrawn), becoming the recorded payer.

use sea_orm_migration::prelude::*;

use super::m20260709_000003_create_transactions_table::Transactions;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Transactions::Table)
                    .add_column(ColumnDef::new(Transactions::RequestedAt).timestamp_with_time_zone())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Transactions::Table)
                    .drop_column(Transactions::RequestedAt)
                    .to_owned(),
            )
            .await
    }
}
