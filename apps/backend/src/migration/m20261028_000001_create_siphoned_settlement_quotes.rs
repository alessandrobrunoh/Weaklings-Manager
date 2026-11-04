//! Stores short-lived, single-use server-generated siphoned settlement quotes.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SiphonedSettlementQuotes::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::Id)
                            .string_len(36)
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::PlayerName)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::ActorUserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::Debt)
                            .decimal_len(16, 0)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::UnitPrice)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::Total)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedSettlementQuotes::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(SiphonedSettlementQuotes::ConsumedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(SiphonedSettlementQuotes::SiphonedEntryId).big_integer())
                    .col(ColumnDef::new(SiphonedSettlementQuotes::TransactionId).big_integer())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_siphoned_settlement_quotes_expiry")
                    .table(SiphonedSettlementQuotes::Table)
                    .col(SiphonedSettlementQuotes::ExpiresAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SiphonedSettlementQuotes::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SiphonedSettlementQuotes {
    Table,
    Id,
    PlayerName,
    UserId,
    ActorUserId,
    Debt,
    UnitPrice,
    Total,
    ExpiresAt,
    CreatedAt,
    ConsumedAt,
    SiphonedEntryId,
    TransactionId,
}
