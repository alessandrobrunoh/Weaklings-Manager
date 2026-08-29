//! Catalog of guild islands and their named chest tabs, used when locating a loot split.

use sea_orm_migration::prelude::*;

/// Creates `split_islands` and `split_island_tabs`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SplitIslands::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SplitIslands::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SplitIslands::Name).string().not_null())
                    .col(ColumnDef::new(SplitIslands::City).string().not_null())
                    .col(
                        ColumnDef::new(SplitIslands::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_split_islands_city_name_unique")
                    .table(SplitIslands::Table)
                    .col(SplitIslands::City)
                    .col(SplitIslands::Name)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(SplitIslandTabs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SplitIslandTabs::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SplitIslandTabs::IslandId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SplitIslandTabs::Name).string().not_null())
                    .col(
                        ColumnDef::new(SplitIslandTabs::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(SplitIslandTabs::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_split_island_tabs_island_id")
                            .from(SplitIslandTabs::Table, SplitIslandTabs::IslandId)
                            .to(SplitIslands::Table, SplitIslands::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_split_island_tabs_island_name_unique")
                    .table(SplitIslandTabs::Table)
                    .col(SplitIslandTabs::IslandId)
                    .col(SplitIslandTabs::Name)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SplitIslandTabs::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(SplitIslands::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SplitIslands {
    Table,
    Id,
    Name,
    City,
    CreatedAt,
}

#[derive(DeriveIden)]
enum SplitIslandTabs {
    Table,
    Id,
    IslandId,
    Name,
    SortOrder,
    CreatedAt,
}
