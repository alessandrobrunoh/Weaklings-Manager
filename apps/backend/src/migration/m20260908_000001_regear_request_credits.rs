//! Replaces the regear per-event/per-month usage caps with a two-pool request-credit economy.
//!
//! `max_regears_per_event`/`max_regears_per_month` enforced a blunt usage counter that reset
//! arbitrarily and gave officers no way to reward a member with extra reimbursement slack. In
//! their place, `regear_settings` now carries three tunables for a per-user request-credit
//! balance: `weekly_request_topup_amount`/`weekly_request_cap` govern a rollover weekly
//! allowance (computed lazily — see `regear::credits`), and `bonus_request_cap` bounds a
//! separate pool only ever topped up by a giveaway prize (see `m20260908_000003`).
//!
//! `regear_request_balances` is the new per-user ledger those two pools live in. It has no
//! explicit FK on `user_id`, matching `regear_deaths.user_id`, which has none either.

use sea_orm_migration::prelude::*;

/// Migration step introducing the regear request-credit balance model.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .drop_column(RegearSettings::MaxRegearsPerEvent)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .drop_column(RegearSettings::MaxRegearsPerMonth)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .add_column(
                        ColumnDef::new(RegearSettings::WeeklyRequestTopupAmount)
                            .integer()
                            .not_null()
                            .default(2),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .add_column(
                        ColumnDef::new(RegearSettings::WeeklyRequestCap)
                            .integer()
                            .not_null()
                            .default(4),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .add_column(
                        ColumnDef::new(RegearSettings::BonusRequestCap)
                            .integer()
                            .not_null()
                            .default(10),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(RegearRequestBalances::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(RegearRequestBalances::UserId)
                            .big_integer()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(RegearRequestBalances::WeeklyBalance)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(RegearRequestBalances::WeeklyLastTopupAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RegearRequestBalances::BonusBalance)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(RegearRequestBalances::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(RegearRequestBalances::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(RegearRequestBalances::Table).to_owned())
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .drop_column(RegearSettings::BonusRequestCap)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .drop_column(RegearSettings::WeeklyRequestCap)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .drop_column(RegearSettings::WeeklyRequestTopupAmount)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .add_column(
                        ColumnDef::new(RegearSettings::MaxRegearsPerMonth)
                            .integer()
                            .not_null()
                            .default(10),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(RegearSettings::Table)
                    .add_column(
                        ColumnDef::new(RegearSettings::MaxRegearsPerEvent)
                            .integer()
                            .not_null()
                            .default(2),
                    )
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum RegearSettings {
    Table,
    MaxRegearsPerEvent,
    MaxRegearsPerMonth,
    WeeklyRequestTopupAmount,
    WeeklyRequestCap,
    BonusRequestCap,
}

#[derive(DeriveIden)]
enum RegearRequestBalances {
    Table,
    UserId,
    WeeklyBalance,
    WeeklyLastTopupAt,
    BonusBalance,
    CreatedAt,
    UpdatedAt,
}
