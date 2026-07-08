//! Migration script to create the `comp_builds` table.

use sea_orm_migration::prelude::*;

use super::m20260710_000005_create_builds_table::Builds;
use super::m20260710_000007_create_comps_table::Comps;

/// Migration step to create the `comp_builds` table linking comps to builds with quantities.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(CompBuilds::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CompBuilds::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(CompBuilds::CompId).big_integer().not_null())
                    .col(ColumnDef::new(CompBuilds::BuildId).big_integer().not_null())
                    .col(
                        ColumnDef::new(CompBuilds::Quantity)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(CompBuilds::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(CompBuilds::Table, CompBuilds::CompId)
                            .to(Comps::Table, Comps::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(CompBuilds::Table, CompBuilds::BuildId)
                            .to(Builds::Table, Builds::Id)
                            .on_delete(ForeignKeyAction::Restrict),
                    )
                    .to_owned(),
            )
            .await?;

        // Add unique constraint on (comp_id, build_id)
        manager
            .create_index(
                Index::create()
                    .name("idx_comp_builds_comp_id_build_id_unique")
                    .table(CompBuilds::Table)
                    .col(CompBuilds::CompId)
                    .col(CompBuilds::BuildId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // Add index for comp_id lookups
        manager
            .create_index(
                Index::create()
                    .name("idx_comp_builds_comp_id")
                    .table(CompBuilds::Table)
                    .col(CompBuilds::CompId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CompBuilds::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum CompBuilds {
    Table,
    Id,
    CompId,
    BuildId,
    Quantity,
    CreatedAt,
}
