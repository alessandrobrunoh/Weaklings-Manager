//! Adds `events.mass_notified_at`, the Discord mass-notice stamp (DO-S1).

use sea_orm_migration::prelude::*;

/// Set once the mass notice for the current schedule was emitted. Cleared by a time change
/// (R22) so a postponed event is announced again.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .add_column(
                        ColumnDef::new(Alias::new("mass_notified_at"))
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("mass_notified_at"))
                    .to_owned(),
            )
            .await
    }
}
