//! Migration script to create the `build_categories` table.

use sea_orm_migration::prelude::*;

/// Migration step to create the `build_categories` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BuildCategories::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BuildCategories::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(BuildCategories::Name).string().not_null())
                    .col(ColumnDef::new(BuildCategories::Slug).string().not_null())
                    .col(ColumnDef::new(BuildCategories::Description).string())
                    .col(
                        ColumnDef::new(BuildCategories::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        // Add unique constraints
        manager
            .create_index(
                Index::create()
                    .name("idx_build_categories_name_unique")
                    .table(BuildCategories::Table)
                    .col(BuildCategories::Name)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_build_categories_slug_unique")
                    .table(BuildCategories::Table)
                    .col(BuildCategories::Slug)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BuildCategories::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum BuildCategories {
    Table,
    Id,
    Name,
    Slug,
    Description,
    CreatedAt,
}
