//! Lets an officer block a member from the manager.
//!
//! A blocked member keeps their row (history, splits, links) but cannot log in or use any
//! authenticated endpoint. `blocked_by` is the `users.id` of the officer; it has no foreign key
//! so deleting the officer's row never unblocks anyone. One `ALTER` per column keeps the
//! migration SQLite-safe.

use sea_orm_migration::prelude::*;

/// Migration step adding the block columns to `users`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(
                        ColumnDef::new(Users::BlockedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(ColumnDef::new(Users::BlockedBy).big_integer().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Users::Table)
                    .add_column(ColumnDef::new(Users::BlockedReason).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [Users::BlockedReason, Users::BlockedBy, Users::BlockedAt] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Users::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Users {
    Table,
    BlockedAt,
    BlockedBy,
    BlockedReason,
}
