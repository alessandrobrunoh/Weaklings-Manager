//! Creates the `regear_deaths` and `regear_settings` tables backing the Call-To-Arms gear
//! reimbursement workflow.
//!
//! `regear_deaths` holds one row per eligible guild-member death in a battle linked to a
//! `call_to_arms` event. The extraction job (`regear::extractor`) is the only writer; user and
//! officer actions only mutate the lifecycle columns. `regear_settings` is a singleton (enforced
//! by `CHECK (id = 1)`) holding the admin-tunable caps and pricing knobs.

use sea_orm_migration::prelude::*;

/// Migration step creating the regear tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(RegearDeaths::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(RegearDeaths::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::EventId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::EventBattleId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::AlbionbbBattleId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::AlbionKillEventId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::KilledAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(RegearDeaths::UserId).big_integer())
                    .col(
                        ColumnDef::new(RegearDeaths::PlayerName)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::GuildId)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(ColumnDef::new(RegearDeaths::PrimaryBuildId).big_integer())
                    .col(ColumnDef::new(RegearDeaths::LoadoutJson).text().not_null())
                    .col(
                        ColumnDef::new(RegearDeaths::AutoEstimateTotal)
                            .decimal_len(20, 0)
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::AutoEstimateBreakdownJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::Status)
                            .string_len(16)
                            .not_null()
                            .default("available"),
                    )
                    .col(ColumnDef::new(RegearDeaths::RequestedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(RegearDeaths::DecidedAt).timestamp_with_time_zone())
                    .col(ColumnDef::new(RegearDeaths::DecidedByUserId).big_integer())
                    .col(ColumnDef::new(RegearDeaths::FinalAmount).decimal_len(20, 0))
                    .col(ColumnDef::new(RegearDeaths::FinalBreakdownJson).text())
                    .col(ColumnDef::new(RegearDeaths::OfficerNote).text())
                    .col(ColumnDef::new(RegearDeaths::BankTransactionId).big_integer())
                    .col(
                        ColumnDef::new(RegearDeaths::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(RegearDeaths::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .index(
                        Index::create()
                            .name("idx_regear_deaths_unique")
                            .table(RegearDeaths::Table)
                            .col(RegearDeaths::EventBattleId)
                            .col(RegearDeaths::AlbionKillEventId)
                            .col(RegearDeaths::PlayerName)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_regear_deaths_user")
                    .table(RegearDeaths::Table)
                    .col(RegearDeaths::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_regear_deaths_status")
                    .table(RegearDeaths::Table)
                    .col(RegearDeaths::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_regear_deaths_event")
                    .table(RegearDeaths::Table)
                    .col(RegearDeaths::EventId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(RegearSettings::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(RegearSettings::Id)
                            .big_integer()
                            .not_null()
                            .primary_key()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::MaxRegearsPerEvent)
                            .integer()
                            .not_null()
                            .default(2),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::MaxRegearsPerMonth)
                            .integer()
                            .not_null()
                            .default(10),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::EnabledSlotsMask)
                            .integer()
                            .not_null()
                            .default(0b1111_1111_1111),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::PricingLocation)
                            .string_len(64)
                            .not_null()
                            .default("Caerleon"),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::PricingFallbackStrategy)
                            .string_len(16)
                            .not_null()
                            .default("cheapest_any"),
                    )
                    .col(
                        ColumnDef::new(RegearSettings::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(RegearSettings::UpdatedByUserId).big_integer())
                    .to_owned(),
            )
            .await?;

        // Seed the singleton row so reads never have to handle the "no settings yet" case.
        manager
            .exec_stmt(
                Query::insert()
                    .into_table(RegearSettings::Table)
                    .columns([RegearSettings::Id])
                    .values_panic([1.into()])
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(RegearSettings::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(RegearDeaths::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum RegearDeaths {
    Table,
    Id,
    EventId,
    EventBattleId,
    AlbionbbBattleId,
    AlbionKillEventId,
    KilledAt,
    UserId,
    PlayerName,
    GuildId,
    PrimaryBuildId,
    LoadoutJson,
    AutoEstimateTotal,
    AutoEstimateBreakdownJson,
    Status,
    RequestedAt,
    DecidedAt,
    DecidedByUserId,
    FinalAmount,
    FinalBreakdownJson,
    OfficerNote,
    BankTransactionId,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum RegearSettings {
    Table,
    Id,
    MaxRegearsPerEvent,
    MaxRegearsPerMonth,
    EnabledSlotsMask,
    PricingLocation,
    PricingFallbackStrategy,
    UpdatedAt,
    UpdatedByUserId,
}
