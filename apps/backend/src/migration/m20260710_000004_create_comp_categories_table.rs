//! Migration script to create the `comp_categories` table.

use sea_orm_migration::prelude::*;

/// Migration step to create the `comp_categories` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(CompCategories::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CompCategories::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(CompCategories::Name).string().not_null())
                    .col(ColumnDef::new(CompCategories::Slug).string().not_null())
                    .col(ColumnDef::new(CompCategories::Description).string())
                    .col(
                        ColumnDef::new(CompCategories::CreatedAt)
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
                    .name("idx_comp_categories_name_unique")
                    .table(CompCategories::Table)
                    .col(CompCategories::Name)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_comp_categories_slug_unique")
                    .table(CompCategories::Table)
                    .col(CompCategories::Slug)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CompCategories::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum CompCategories {
    Table,
    Id,
    Name,
    Slug,
    Description,
    CreatedAt,
}
