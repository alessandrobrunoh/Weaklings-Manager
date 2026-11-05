//! Marks loot splits whose roster sync failed while their event was stopping.

use sea_orm_migration::prelude::*;

use super::m20260709_000001_create_splits_table::Splits;

/// Adds `splits.needs_resync` (false unless the last event-driven roster sync failed).
///
/// The event transition core runs the split roster sync in a SAVEPOINT so a
/// failure never rolls back the stop; the flag records that the split is stale
/// until a later sync succeeds.
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
                        ColumnDef::new(Alias::new("needs_resync"))
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
                    .drop_column(Alias::new("needs_resync"))
                    .to_owned(),
            )
            .await
    }
}
