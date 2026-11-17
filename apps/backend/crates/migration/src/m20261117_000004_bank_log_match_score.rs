//! Stores how likely an automatic bank log suggestion is (0-100), so officers see the best one
//! first and "fill all suggested" can pick it.

use sea_orm_migration::prelude::*;

/// Adds `bank_log_matches.score`. Manual links and links from before this migration have none.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BankLogMatches::Table)
                    .add_column(ColumnDef::new(BankLogMatches::Score).integer())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BankLogMatches::Table)
                    .drop_column(BankLogMatches::Score)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum BankLogMatches {
    Table,
    Score,
}
