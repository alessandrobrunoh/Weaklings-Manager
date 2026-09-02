//! Migration script to add `archived_at` to `builds` and `comps`.
//!
//! Deleting a build or comp is `RESTRICT`-blocked the moment anything real depends on it (a comp
//! using the build, an event using the comp), which is exactly when an officer most wants it out of
//! the picker lists — so there was no way to retire one without either leaving it cluttering every
//! dropdown forever or waiting until nothing references it any more. Archiving sidesteps the FKs
//! entirely: the row (and everything that already points to it) is untouched, `archived_at` just
//! records when it stopped being offered for new use. `NULL` means active; a timestamp means
//! archived, so existing rows keep working with no backfill needed.

use sea_orm_migration::prelude::*;

use super::m20260710_000005_create_builds_table::Builds;
use super::m20260710_000007_create_comps_table::Comps;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Builds::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("archived_at")).timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Comps::Table)
                    .add_column(
                        ColumnDef::new(Alias::new("archived_at")).timestamp_with_time_zone(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Comps::Table)
                    .drop_column(Alias::new("archived_at"))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Builds::Table)
                    .drop_column(Alias::new("archived_at"))
                    .to_owned(),
            )
            .await
    }
}
