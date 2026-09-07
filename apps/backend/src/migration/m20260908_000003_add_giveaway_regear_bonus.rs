//! Adds an optional "regear request bonus" prize channel to giveaways, alongside the existing
//! `silver_amount`. On draw, if set, the winner's bonus regear-request pool is credited by this
//! many requests (clamped at the tenant's `regear_settings.bonus_request_cap`).

use sea_orm_migration::prelude::*;

/// Migration step adding `giveaways.regear_request_bonus`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Giveaways::Table)
                    .add_column(ColumnDef::new(Giveaways::RegearRequestBonus).integer())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Giveaways::Table)
                    .drop_column(Giveaways::RegearRequestBonus)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Giveaways {
    Table,
    RegearRequestBonus,
}
