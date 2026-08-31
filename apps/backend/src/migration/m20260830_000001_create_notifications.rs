//! Creates `notification_broadcasts` and `notifications`.
//!
//! One `notifications` row per recipient. Broadcasts fan out from
//! `notification_broadcasts` so each guild announcement has a stable source id
//! for the unique `(user_id, kind, source_type, source_id)` index.

use sea_orm_migration::prelude::*;

/// Migration step creating the notification inbox tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(NotificationBroadcasts::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(NotificationBroadcasts::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(NotificationBroadcasts::Title)
                            .string_len(120)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(NotificationBroadcasts::Body)
                            .string_len(2000)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(NotificationBroadcasts::CreatedByUserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(NotificationBroadcasts::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_notification_broadcasts_created_by")
                            .from(
                                NotificationBroadcasts::Table,
                                NotificationBroadcasts::CreatedByUserId,
                            )
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Notifications::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Notifications::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Notifications::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Notifications::Kind)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Notifications::Title)
                            .string_len(120)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Notifications::Body)
                            .string_len(2000)
                            .not_null(),
                    )
                    .col(ColumnDef::new(Notifications::LinkPath).string_len(512))
                    .col(
                        ColumnDef::new(Notifications::SourceType)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Notifications::SourceId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Notifications::CreatedByUserId).big_integer())
                    .col(ColumnDef::new(Notifications::ReadAt).timestamp_with_time_zone())
                    .col(
                        ColumnDef::new(Notifications::DiscordDmStatus)
                            .string_len(16)
                            .not_null()
                            .default("pending"),
                    )
                    .col(
                        ColumnDef::new(Notifications::DiscordDmAttempts)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(Notifications::DiscordDmLastError).string_len(512))
                    .col(
                        ColumnDef::new(Notifications::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_notifications_user")
                            .from(Notifications::Table, Notifications::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_notifications_created_by")
                            .from(Notifications::Table, Notifications::CreatedByUserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_notifications_unique_source")
                    .table(Notifications::Table)
                    .col(Notifications::UserId)
                    .col(Notifications::Kind)
                    .col(Notifications::SourceType)
                    .col(Notifications::SourceId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_notifications_inbox")
                    .table(Notifications::Table)
                    .col(Notifications::UserId)
                    .col(Notifications::ReadAt)
                    .col(Notifications::CreatedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_notifications_discord_dm")
                    .table(Notifications::Table)
                    .col(Notifications::DiscordDmStatus)
                    .col(Notifications::CreatedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Notifications::Table).to_owned())
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(NotificationBroadcasts::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Notifications {
    Table,
    Id,
    UserId,
    Kind,
    Title,
    Body,
    LinkPath,
    SourceType,
    SourceId,
    CreatedByUserId,
    ReadAt,
    DiscordDmStatus,
    DiscordDmAttempts,
    DiscordDmLastError,
    CreatedAt,
}

#[derive(DeriveIden)]
enum NotificationBroadcasts {
    Table,
    Id,
    Title,
    Body,
    CreatedByUserId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
