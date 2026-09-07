//! Lets an application ticket be reopened, and records the applicant's in-game name.
//!
//! A returning member reuses their old ticket instead of opening a second one,
//! so the channel — and the whole conversation in it — carries over. The row
//! goes back to `open`, which is why the reopen count is tracked separately:
//! without it a manager reading a reopened ticket has no idea it is not the
//! applicant's first.

use sea_orm_migration::prelude::*;

/// Migration step adding the reopen bookkeeping and the in-game name.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(DiscordApplications::Table)
                    .add_column(ColumnDef::new(DiscordApplications::IngameName).string_len(64))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(DiscordApplications::Table)
                    .add_column(
                        ColumnDef::new(DiscordApplications::ReopenedAt).timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(DiscordApplications::Table)
                    .add_column(
                        ColumnDef::new(DiscordApplications::ReopenCount)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            DiscordApplications::IngameName,
            DiscordApplications::ReopenedAt,
            DiscordApplications::ReopenCount,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(DiscordApplications::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum DiscordApplications {
    Table,
    IngameName,
    ReopenedAt,
    ReopenCount,
}
