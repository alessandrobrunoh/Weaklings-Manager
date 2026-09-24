//! Stores Discord support ticket thread bindings and lifecycle state.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(DiscordTickets::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DiscordTickets::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(DiscordTickets::UserDiscordId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(ColumnDef::new(DiscordTickets::UserId).big_integer())
                    .col(
                        ColumnDef::new(DiscordTickets::UsernameSnapshot)
                            .string_len(256)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DiscordTickets::ThreadId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DiscordTickets::Status)
                            .string_len(32)
                            .not_null()
                            .default("open"),
                    )
                    .col(
                        ColumnDef::new(DiscordTickets::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(DiscordTickets::ClosedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(DiscordTickets::ClosedByDiscordId).string_len(64))
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_tickets_one_open_per_user \
                 ON discord_tickets (user_discord_id) WHERE status = 'open'",
            )
            .await
            .map(|_| ())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_discord_tickets_one_open_per_user")
            .await?;
        manager
            .drop_table(Table::drop().table(DiscordTickets::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum DiscordTickets {
    Table,
    Id,
    UserDiscordId,
    UserId,
    UsernameSnapshot,
    ThreadId,
    Status,
    CreatedAt,
    ClosedAt,
    ClosedByDiscordId,
}
