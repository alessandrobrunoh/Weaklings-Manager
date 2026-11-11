//! Marks loot splits whose roster was edited by an officer by hand.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;

/// Adds `splits.roster_locked` (false unless an officer edited the participants by hand).
///
/// Event-driven roster sync imports sign-ups into a split only while its roster is not
/// locked, so a hand-curated split keeps the people the officer chose.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("roster_locked"))
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Splits::Table)
                    .drop_column(Alias::new("roster_locked"))
                    .to_owned(),
            )
            .await
    }
}
