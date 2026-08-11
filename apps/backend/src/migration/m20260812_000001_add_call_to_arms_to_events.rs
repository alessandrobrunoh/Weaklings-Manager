//! Migration script adding the `call_to_arms` flag to the `events` table.

use sea_orm_migration::prelude::*;

/// Migration step that flags events intended as urgent call-to-arms announcements.
///
/// A `call_to_arms` event is posted to the dedicated Discord CTA channel and shown
/// as priority content on the frontend, so existing rows default to `false`.
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
                        ColumnDef::new(Alias::new("call_to_arms"))
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
                    .table(Alias::new("events"))
                    .drop_column(Alias::new("call_to_arms"))
                    .to_owned(),
            )
            .await
    }
}
