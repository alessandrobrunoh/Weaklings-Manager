//! Separates the Albion market tax from the guild split fee.
//!
//! * `guild_settings.market_tax_percent` (default 6) is the tax the seller account pays on the
//!   loot it sells on the market. Every guild gets it, editable in the finance settings.
//! * `splits.market_tax` is the tax a split was created with. Existing splits get 0, so their
//!   net value is unchanged; new splits copy the guild setting.
//! * The guild fee default for new guilds becomes 15 (15% fee + 6% tax replaces a 20% fee that
//!   silently included the tax). A guild counts as new here when it has no split yet and still
//!   has the untouched default of 20; every other guild keeps the fee it stored.
//!
//! One `ALTER` per column keeps the migration SQLite-safe.

use sea_orm_migration::prelude::*;

/// Migration step adding the market tax columns.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .add_column(
                        ColumnDef::new(GuildSettings::MarketTaxPercent)
                            .decimal_len(5, 2)
                            .not_null()
                            .default(6),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(
                        ColumnDef::new(Splits::MarketTax)
                            .decimal_len(5, 2)
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        let no_split_yet = Query::select()
            .expr(Expr::val(1))
            .from(Splits::Table)
            .to_owned();
        manager
            .exec_stmt(
                Query::update()
                    .table(GuildSettings::Table)
                    .value(GuildSettings::DefaultSplitFee, 15)
                    .and_where(Expr::col(GuildSettings::DefaultSplitFee).eq(20))
                    .and_where(Expr::exists(no_split_yet).not())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Splits::MarketTax)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GuildSettings::Table)
                    .drop_column(GuildSettings::MarketTaxPercent)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    MarketTaxPercent,
    DefaultSplitFee,
}

#[derive(DeriveIden)]
enum Splits {
    Table,
    MarketTax,
}
