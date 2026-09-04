//! Adds the Albion enchantment level (0 … 4) to `build_items`.
//!
//! Item Power is a function of tier *and* enchantment — a T8.0 weapon is 1100, a T8.2 is 1300 —
//! and until now enchantment was representable nowhere: the bundled catalog carries only tiers 1
//! through 8, no identifier in it has an `@N` suffix, and `item_power` is null on every row. A
//! build could therefore say "T8 Excellent Polehammer" but never "T8.2", which leaves any Item
//! Power figure indeterminate.
//!
//! Existing rows default to 0, which is both the correct historical reading (nothing recorded an
//! enchantment, so none was chosen) and what the column default supplies without a backfill —
//! the same approach `m20260901_000002` took for `loadout`.

use sea_orm_migration::prelude::*;

/// Migration step to persist per-slot Albion enchantment level on build items.
#[derive(DeriveMigrationName)]
pub struct Migration;

const CHECK_NAME: &str = "chk_build_items_enchantment_range";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .add_column(
                        ColumnDef::new(BuildItems::OpenalbionItemEnchantment)
                            .small_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        // Postgres only; the check is a guard against a bad write, not a data migration, so a
        // backend that does not support it simply goes without.
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Postgres {
            manager
                .get_connection()
                .execute_unprepared(&format!(
                    "ALTER TABLE build_items ADD CONSTRAINT {CHECK_NAME} \
                     CHECK (openalbion_item_enchantment BETWEEN 0 AND 4)"
                ))
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == sea_orm::DatabaseBackend::Postgres {
            manager
                .get_connection()
                .execute_unprepared(&format!(
                    "ALTER TABLE build_items DROP CONSTRAINT IF EXISTS {CHECK_NAME}"
                ))
                .await?;
        }
        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .drop_column(BuildItems::OpenalbionItemEnchantment)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum BuildItems {
    Table,
    OpenalbionItemEnchantment,
}
