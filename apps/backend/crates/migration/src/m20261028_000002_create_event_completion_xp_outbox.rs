//! Durable, tenant-local snapshot of XP recipients at successful event completion.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(EventCompletionXp::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(EventCompletionXp::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::Source)
                            .string_len(32)
                            .not_null(),
                    )
                    .col(ColumnDef::new(EventCompletionXp::SeasonId).big_integer())
                    .col(
                        ColumnDef::new(EventCompletionXp::BaseAmount)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::IdempotencyKey)
                            .string_len(160)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::Status)
                            .string_len(24)
                            .not_null()
                            .default("pending"),
                    )
                    .col(
                        ColumnDef::new(EventCompletionXp::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .index(
                        Index::create()
                            .name("uq_event_completion_xp_event_user_source")
                            .table(EventCompletionXp::Table)
                            .col(EventCompletionXp::EventId)
                            .col(EventCompletionXp::UserId)
                            .col(EventCompletionXp::Source)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(EventCompletionXp::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum EventCompletionXp {
    Table,
    Id,
    EventId,
    UserId,
    Source,
    SeasonId,
    BaseAmount,
    IdempotencyKey,
    Status,
    CreatedAt,
}
