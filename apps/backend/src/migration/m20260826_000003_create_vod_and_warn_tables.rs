//! Creates `vod_reviews`, `user_warns`, and `warn_escalations`.

use sea_orm_migration::prelude::*;

/// Migration step creating VOD review and warn register tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(VodReviews::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(VodReviews::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(VodReviews::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(VodReviews::SeasonId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(VodReviews::Url).string_len(512).not_null())
                    .col(
                        ColumnDef::new(VodReviews::DiscordThreadId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(VodReviews::DiscordMessageId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(VodReviews::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(VodReviews::Table, VodReviews::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(VodReviews::Table, VodReviews::SeasonId)
                            .to(ProgressionSeasons::Table, ProgressionSeasons::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_vod_reviews_season_url")
                    .table(VodReviews::Table)
                    .col(VodReviews::SeasonId)
                    .col(VodReviews::Url)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(UserWarns::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(UserWarns::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(UserWarns::UserId).big_integer().not_null())
                    .col(
                        ColumnDef::new(UserWarns::IssuedByUserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(UserWarns::Reason).text().not_null())
                    .col(
                        ColumnDef::new(UserWarns::Severity)
                            .string_len(16)
                            .not_null()
                            .default("warn"),
                    )
                    .col(ColumnDef::new(UserWarns::Multiplier).decimal_len(8, 4))
                    .col(ColumnDef::new(UserWarns::MultiplierExpiresAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(UserWarns::RevokedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(UserWarns::RevokedBy).big_integer())
                    .col(
                        ColumnDef::new(UserWarns::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(UserWarns::Table, UserWarns::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(UserWarns::Table, UserWarns::IssuedByUserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_user_warns_user_created")
                    .table(UserWarns::Table)
                    .col(UserWarns::UserId)
                    .col(UserWarns::CreatedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(WarnEscalations::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(WarnEscalations::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(WarnEscalations::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(WarnEscalations::ThresholdAtTime)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(WarnEscalations::WarnCountAtTime)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(WarnEscalations::OpenedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(WarnEscalations::AcknowledgedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(WarnEscalations::AcknowledgedBy).big_integer())
                    .col(ColumnDef::new(WarnEscalations::ClosedReason).string_len(64))
                    .foreign_key(
                        ForeignKey::create()
                            .from(WarnEscalations::Table, WarnEscalations::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // At most one OPEN escalation per user (unacked and not closed).
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_warn_escalations_one_open_per_user \
                 ON warn_escalations (user_id) \
                 WHERE acknowledged_at IS NULL AND closed_reason IS NULL",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_warn_escalations_one_open_per_user")
            .await?;
        manager
            .drop_table(Table::drop().table(WarnEscalations::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(UserWarns::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(VodReviews::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum VodReviews {
    Table,
    Id,
    UserId,
    SeasonId,
    Url,
    DiscordThreadId,
    DiscordMessageId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum UserWarns {
    Table,
    Id,
    UserId,
    IssuedByUserId,
    Reason,
    Severity,
    Multiplier,
    MultiplierExpiresAt,
    RevokedAt,
    RevokedBy,
    CreatedAt,
}

#[derive(DeriveIden)]
enum WarnEscalations {
    Table,
    Id,
    UserId,
    ThresholdAtTime,
    WarnCountAtTime,
    OpenedAt,
    AcknowledgedAt,
    AcknowledgedBy,
    ClosedReason,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum ProgressionSeasons {
    Table,
    Id,
}
