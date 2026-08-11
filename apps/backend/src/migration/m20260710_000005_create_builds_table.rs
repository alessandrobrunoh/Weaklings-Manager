//! Migration script to create the `builds` table.

use sea_orm_migration::prelude::*;

use super::m20260708_000001_create_users_table::Users;
use super::m20260710_000003_create_build_categories_table::BuildCategories;

/// Migration step to create the `builds` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Builds::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Builds::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Builds::Name).string().not_null())
                    .col(ColumnDef::new(Builds::Description).string())
                    .col(ColumnDef::new(Builds::Role).string().not_null())
                    .col(ColumnDef::new(Builds::CategoryId).big_integer().not_null())
                    .col(ColumnDef::new(Builds::CreatedBy).big_integer().not_null())
                    .col(
                        ColumnDef::new(Builds::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(Builds::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Builds::Table, Builds::CategoryId)
                            .to(BuildCategories::Table, BuildCategories::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Builds::Table, Builds::CreatedBy)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;

        // Add indexes
        manager
            .create_index(
                Index::create()
                    .name("idx_builds_role")
                    .table(Builds::Table)
                    .col(Builds::Role)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_builds_category_id")
                    .table(Builds::Table)
                    .col(Builds::CategoryId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Builds::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Builds {
    Table,
    Id,
    Name,
    Description,
    Role,
    CategoryId,
    CreatedBy,
    CreatedAt,
    UpdatedAt,
}
