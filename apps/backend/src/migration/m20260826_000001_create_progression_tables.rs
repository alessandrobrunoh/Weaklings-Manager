//! Creates the progression (season XP / levels) tables.
//!
//! - `progression_settings` — singleton admin knobs (curve, XP rates, warn threshold).
//! - `progression_seasons` — modellable Albion-aligned seasons (dates can move).
//! - `progression_accounts` — per-user XP/level for one season.
//! - `progression_xp_ledger` — append-only awards, unique on `(season_id, idempotency_key)`.

use sea_orm_migration::prelude::*;

/// Migration step creating the progression tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ProgressionSettings::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ProgressionSettings::Id)
                            .big_integer()
                            .not_null()
                            .primary_key()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpBase)
                            .integer()
                            .not_null()
                            .default(100),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpExponent)
                            .decimal_len(8, 4)
                            .not_null()
                            .default(1.5),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::MaxLevel)
                            .integer()
                            .not_null()
                            .default(50),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpMessage)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpEventCreate)
                            .integer()
                            .not_null()
                            .default(25),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpEventJoin)
                            .integer()
                            .not_null()
                            .default(10),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpEventComplete)
                            .integer()
                            .not_null()
                            .default(15),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::XpVod)
                            .integer()
                            .not_null()
                            .default(40),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::MessageCooldownSecs)
                            .integer()
                            .not_null()
                            .default(60),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::MessageMinChars)
                            .integer()
                            .not_null()
                            .default(2),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::WarnThreshold)
                            .integer()
                            .not_null()
                            .default(3),
                    )
                    .col(ColumnDef::new(ProgressionSettings::VodForumChannelId).string_len(64))
                    .col(
                        ColumnDef::new(ProgressionSettings::MessageChannelDenyListJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(ProgressionSettings::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(ProgressionSettings::UpdatedByUserId).big_integer())
                    .to_owned(),
            )
            .await?;

        manager
            .exec_stmt(
                Query::insert()
                    .into_table(ProgressionSettings::Table)
                    .columns([ProgressionSettings::Id])
                    .values_panic([1.into()])
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ProgressionSeasons::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ProgressionSeasons::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ProgressionSeasons::Name)
                            .string_len(128)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionSeasons::StartsAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionSeasons::EndsAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionSeasons::IsActive)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(ProgressionSeasons::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(ProgressionSeasons::UpdatedByUserId).big_integer())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ProgressionAccounts::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ProgressionAccounts::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::SeasonId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::Xp)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::Level)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::XpMultiplier)
                            .decimal_len(8, 4)
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::MultiplierExpiresAt)
                            .timestamp_with_time_zone(),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::XpRemainder)
                            .decimal_len(12, 8)
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::LastMessageXpAt)
                            .timestamp_with_time_zone(),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(ProgressionAccounts::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ProgressionAccounts::Table, ProgressionAccounts::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ProgressionAccounts::Table, ProgressionAccounts::SeasonId)
                            .to(ProgressionSeasons::Table, ProgressionSeasons::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_progression_accounts_user_season")
                    .table(ProgressionAccounts::Table)
                    .col(ProgressionAccounts::UserId)
                    .col(ProgressionAccounts::SeasonId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ProgressionXpLedger::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ProgressionXpLedger::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::SeasonId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::Source)
                            .string_len(32)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::BaseAmount)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::AppliedAmount)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::MultiplierAtTime)
                            .decimal_len(8, 4)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ProgressionXpLedger::IdempotencyKey)
                            .string_len(191)
                            .not_null(),
                    )
                    .col(ColumnDef::new(ProgressionXpLedger::ActorUserId).big_integer())
                    .col(
                        ColumnDef::new(ProgressionXpLedger::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ProgressionXpLedger::Table, ProgressionXpLedger::UserId)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ProgressionXpLedger::Table, ProgressionXpLedger::SeasonId)
                            .to(ProgressionSeasons::Table, ProgressionSeasons::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_progression_xp_ledger_season_key")
                    .table(ProgressionXpLedger::Table)
                    .col(ProgressionXpLedger::SeasonId)
                    .col(ProgressionXpLedger::IdempotencyKey)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_progression_xp_ledger_user_season")
                    .table(ProgressionXpLedger::Table)
                    .col(ProgressionXpLedger::SeasonId)
                    .col(ProgressionXpLedger::UserId)
                    .col(ProgressionXpLedger::CreatedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ProgressionXpLedger::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ProgressionAccounts::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ProgressionSeasons::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(ProgressionSettings::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ProgressionSettings {
    Table,
    Id,
    XpBase,
    XpExponent,
    MaxLevel,
    XpMessage,
    XpEventCreate,
    XpEventJoin,
    XpEventComplete,
    XpVod,
    MessageCooldownSecs,
    MessageMinChars,
    WarnThreshold,
    VodForumChannelId,
    MessageChannelDenyListJson,
    UpdatedAt,
    UpdatedByUserId,
}

#[derive(DeriveIden)]
enum ProgressionSeasons {
    Table,
    Id,
    Name,
    StartsAt,
    EndsAt,
    IsActive,
    UpdatedAt,
    UpdatedByUserId,
}

#[derive(DeriveIden)]
enum ProgressionAccounts {
    Table,
    Id,
    UserId,
    SeasonId,
    Xp,
    Level,
    XpMultiplier,
    MultiplierExpiresAt,
    XpRemainder,
    LastMessageXpAt,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum ProgressionXpLedger {
    Table,
    Id,
    UserId,
    SeasonId,
    Source,
    BaseAmount,
    AppliedAmount,
    MultiplierAtTime,
    IdempotencyKey,
    ActorUserId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
