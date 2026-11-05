//! Adds a destination-side idempotency key for alliance split credits.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            ColumnDef::new(Transactions::AllianceDistributionKey).string(),
            ColumnDef::new(Transactions::SourceAllianceTenantId).string(),
            ColumnDef::new(Transactions::SourceAllianceSplitId).big_integer(),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Transactions::Table)
                        .add_column(column)
                        .to_owned(),
                )
                .await?;
        }
        manager
            .create_index(
                Index::create()
                    .name("idx_transactions_alliance_distribution_key")
                    .table(Transactions::Table)
                    .col(Transactions::AllianceDistributionKey)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_transactions_alliance_distribution_key")
                    .table(Transactions::Table)
                    .to_owned(),
            )
            .await?;
        for column in [
            Transactions::SourceAllianceSplitId,
            Transactions::SourceAllianceTenantId,
            Transactions::AllianceDistributionKey,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Transactions::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Transactions {
    Table,
    AllianceDistributionKey,
    SourceAllianceTenantId,
    SourceAllianceSplitId,
}
