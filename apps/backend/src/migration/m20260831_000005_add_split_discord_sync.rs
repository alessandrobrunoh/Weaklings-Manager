//! Adds incremental synchronization state and mutation watermarks for split Discord threads.

use sea_orm_migration::prelude::*;

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
                        ColumnDef::new(Splits::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Transactions::Table)
                    .add_column(
                        ColumnDef::new(Transactions::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(AuditLogs::Table)
                    .add_column(ColumnDef::new(AuditLogs::SplitId).big_integer())
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(SplitDiscordSync::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SplitDiscordSync::SplitId)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SplitDiscordSync::ThreadId).string_len(64))
                    .col(ColumnDef::new(SplitDiscordSync::SummaryMessageId).string_len(64))
                    .col(
                        ColumnDef::new(SplitDiscordSync::LastAuditId)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(SplitDiscordSync::LastTransactionId)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(SplitDiscordSync::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(SplitDiscordSync::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SplitDiscordSync::Table, SplitDiscordSync::SplitId)
                            .to(Splits::Table, Splits::Id),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SplitDiscordSync::Table).to_owned())
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(AuditLogs::Table)
                    .drop_column(AuditLogs::SplitId)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Transactions::Table)
                    .drop_column(Transactions::UpdatedAt)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Splits::UpdatedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Splits {
    Table,
    Id,
    UpdatedAt,
}
#[derive(DeriveIden)]
enum Transactions {
    Table,
    UpdatedAt,
}
#[derive(DeriveIden)]
enum AuditLogs {
    Table,
    SplitId,
}
#[derive(DeriveIden)]
enum SplitDiscordSync {
    Table,
    SplitId,
    ThreadId,
    SummaryMessageId,
    LastAuditId,
    LastTransactionId,
    CreatedAt,
    UpdatedAt,
}
