//! Migration script to create the `split_participants` table.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260709_000001_create_splits_table::Splits;

/// Migration step to create the `split_participants` table linking users to a split with a weight.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SplitParticipants::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SplitParticipants::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SplitParticipants::SplitId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SplitParticipants::UserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SplitParticipants::Weight)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SplitParticipants::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SplitParticipants::Table, SplitParticipants::SplitId)
                            .to(Splits::Table, Splits::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(SplitParticipants::Table, SplitParticipants::UserId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_split_participants_split_user")
                    .table(SplitParticipants::Table)
                    .col(SplitParticipants::SplitId)
                    .col(SplitParticipants::UserId)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SplitParticipants::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum SplitParticipants {
    Table,
    Id,
    SplitId,
    UserId,
    Weight,
    CreatedAt,
}
