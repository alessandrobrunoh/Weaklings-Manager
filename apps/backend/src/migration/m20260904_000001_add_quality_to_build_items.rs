//! Adds Albion item quality (1 Normal … 5 Masterpiece) to `build_items`.
//!
//! Existing rows default to Excellent (4), the grade the guild already treats as standard
//! loadout gear. Quality is independent of the identifier's enchantment suffix (`@3`).

use sea_orm_migration::prelude::*;

/// Migration step to persist per-slot Albion item quality on build items.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .add_column(
                        ColumnDef::new(BuildItems::OpenalbionItemQuality)
                            .small_integer()
                            .not_null()
                            .default(4),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .drop_column(BuildItems::OpenalbionItemQuality)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum BuildItems {
    Table,
    OpenalbionItemQuality,
}
