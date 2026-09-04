//! Creates giveaway, prize, and entry tables.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260709_000003_create_transactions_table::Transactions;

/// Migration step to persist guild giveaways, their item prizes, and Discord entries.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Giveaways::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Giveaways::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Giveaways::Title).string().not_null())
                    .col(ColumnDef::new(Giveaways::Description).string())
                    .col(
                        ColumnDef::new(Giveaways::EndsAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Giveaways::Status)
                            .string()
                            .not_null()
                            .default("open"),
                    )
                    .col(
                        ColumnDef::new(Giveaways::CreatedBy)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Giveaways::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(Giveaways::SilverAmount).decimal_len(16, 2))
                    .col(ColumnDef::new(Giveaways::WinnerUserId).big_integer())
                    .col(ColumnDef::new(Giveaways::DrawnAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(Giveaways::SilverTransactionId).big_integer())
                    .col(ColumnDef::new(Giveaways::DiscordMessageId).string_len(64))
                    .col(ColumnDef::new(Giveaways::DiscordChannelId).string_len(64))
                    .col(ColumnDef::new(Giveaways::CancelledAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(Giveaways::CancelledBy).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Giveaways::Table, Giveaways::CreatedBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Giveaways::Table, Giveaways::WinnerUserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Giveaways::Table, Giveaways::CancelledBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Giveaways::Table, Giveaways::SilverTransactionId)
                            .to(Transactions::Table, Transactions::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_giveaways_status_ends_at")
                    .table(Giveaways::Table)
                    .col(Giveaways::Status)
                    .col(Giveaways::EndsAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(GiveawayPrizes::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GiveawayPrizes::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(GiveawayPrizes::GiveawayId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GiveawayPrizes::OpenalbionItemId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GiveawayPrizes::OpenalbionItemName)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(GiveawayPrizes::OpenalbionItemIcon).string())
                    .col(ColumnDef::new(GiveawayPrizes::OpenalbionItemIdentifier).string())
                    .col(ColumnDef::new(GiveawayPrizes::OpenalbionItemTier).string())
                    .col(
                        ColumnDef::new(GiveawayPrizes::OpenalbionItemQuality)
                            .small_integer()
                            .not_null()
                            .default(4),
                    )
                    .col(
                        ColumnDef::new(GiveawayPrizes::Quantity)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(GiveawayPrizes::Table, GiveawayPrizes::GiveawayId)
                            .to(Giveaways::Table, Giveaways::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(GiveawayEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GiveawayEntries::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(GiveawayEntries::GiveawayId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GiveawayEntries::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(GiveawayEntries::EnteredAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(GiveawayEntries::Table, GiveawayEntries::GiveawayId)
                            .to(Giveaways::Table, Giveaways::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(GiveawayEntries::Table, GiveawayEntries::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_giveaway_entries_giveaway_user_unique")
                    .table(GiveawayEntries::Table)
                    .col(GiveawayEntries::GiveawayId)
                    .col(GiveawayEntries::UserId)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(GiveawayEntries::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(GiveawayPrizes::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Giveaways::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Giveaways {
    Table,
    Id,
    Title,
    Description,
    EndsAt,
    Status,
    CreatedBy,
    CreatedAt,
    SilverAmount,
    WinnerUserId,
    DrawnAt,
    SilverTransactionId,
    DiscordMessageId,
    DiscordChannelId,
    CancelledAt,
    CancelledBy,
}

#[derive(DeriveIden)]
enum GiveawayPrizes {
    Table,
    Id,
    GiveawayId,
    OpenalbionItemId,
    OpenalbionItemName,
    OpenalbionItemIcon,
    OpenalbionItemIdentifier,
    OpenalbionItemTier,
    OpenalbionItemQuality,
    Quantity,
}

#[derive(DeriveIden)]
enum GiveawayEntries {
    Table,
    Id,
    GiveawayId,
    UserId,
    EnteredAt,
}
