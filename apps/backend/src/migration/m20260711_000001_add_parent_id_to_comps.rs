//! Migration script to add the `parent_id` column to the `comps` table.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::DbBackend;

use super::m20260710_000007_create_comps_table::Comps;

/// Migration step to add `parent_id` to comps.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Comps::Table)
                    .add_column(ColumnDef::new(Alias::new("parent_id")).big_integer())
                    .to_owned(),
            )
            .await?;

        // Add foreign key constraint (PostgreSQL only - SQLite does not support ALTER TABLE ADD FOREIGN KEY)
        if manager.get_database_backend() != DbBackend::Sqlite {
            manager
                .create_foreign_key(
                    ForeignKey::create()
                        .name("fk_comps_parent_id")
                        .from(Comps::Table, Alias::new("parent_id"))
                        .to(Comps::Table, Comps::Id)
                        .on_delete(ForeignKeyAction::Cascade)
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() != DbBackend::Sqlite {
            manager
                .drop_foreign_key(
                    ForeignKey::drop()
                        .name("fk_comps_parent_id")
                        .table(Comps::Table)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .alter_table(
                Table::alter()
                    .table(Comps::Table)
                    .drop_column(Alias::new("parent_id"))
                    .to_owned(),
            )
            .await
    }
}
