//! Migration script to create the `events` table.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260710_000007_create_comps_table::Comps;

/// Migration step to create the `events` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Events::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Events::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Events::Title).string().not_null())
                    .col(ColumnDef::new(Events::Description).string())
                    .col(ColumnDef::new(Events::CompId).big_integer().not_null())
                    .col(ColumnDef::new(Events::CreatedBy).big_integer().not_null())
                    .col(
                        ColumnDef::new(Events::EventDateUtc)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Events::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Events::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Events::Table, Events::CompId)
                            .to(Comps::Table, Comps::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Events::Table, Events::CreatedBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;

        // Add index for event_date_utc lookups
        manager
            .create_index(
                Index::create()
                    .name("idx_events_event_date_utc")
                    .table(Events::Table)
                    .col(Events::EventDateUtc)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Events::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Events {
    Table,
    Id,
    Title,
    Description,
    CompId,
    CreatedBy,
    EventDateUtc,
    CreatedAt,
    UpdatedAt,
}
