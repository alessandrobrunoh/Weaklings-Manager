//! Migration script to create the `comps` table.

use sea_orm_migration::prelude::*;

use super::m20260710_000004_create_comp_categories_table::CompCategories;
use super::m20260708_000001_create_users_table::Users;

/// Migration step to create the `comps` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Comps::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Comps::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Comps::Name).string().not_null())
                    .col(ColumnDef::new(Comps::Description).string())
                    .col(ColumnDef::new(Comps::CategoryId).big_integer().not_null())
                    .col(ColumnDef::new(Comps::CreatedBy).big_integer().not_null())
                    .col(
                        ColumnDef::new(Comps::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Comps::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Comps::Table, Comps::CategoryId)
                            .to(CompCategories::Table, CompCategories::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Comps::Table, Comps::CreatedBy)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;

        // Add index for category_id lookups
        manager
            .create_index(
                Index::create()
                    .name("idx_comps_category_id")
                    .table(Comps::Table)
                    .col(Comps::CategoryId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Comps::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Comps {
    Table,
    Id,
    Name,
    Description,
    CategoryId,
    CreatedBy,
    CreatedAt,
    UpdatedAt,
}
