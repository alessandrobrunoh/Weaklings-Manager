//! Migration script to give build items a loadout, so a build can carry one swap set.
//!
//! `m20260710_000006_create_build_items_table` made `(build_id, slot)` unique, which allows exactly
//! one item per slot per build. A swap needs a second item in the same slot, so the uniqueness moves
//! to `(build_id, loadout, slot)`.
//!
//! Every existing row is the main loadout, which the column default supplies — no backfill statement
//! is needed, and reads keep working before the API learns about loadouts.

use sea_orm_migration::prelude::*;

/// Migration step to add the `loadout` discriminator to `build_items`.
#[derive(DeriveMigrationName)]
pub struct Migration;

const OLD_UNIQUE_INDEX: &str = "idx_build_items_build_id_slot_unique";
const NEW_UNIQUE_INDEX: &str = "idx_build_items_build_id_loadout_slot_unique";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .add_column(
                        ColumnDef::new(BuildItems::Loadout)
                            .string()
                            .not_null()
                            .default("main"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .drop_index(
                Index::drop()
                    .name(OLD_UNIQUE_INDEX)
                    .table(BuildItems::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name(NEW_UNIQUE_INDEX)
                    .table(BuildItems::Table)
                    .col(BuildItems::BuildId)
                    .col(BuildItems::Loadout)
                    .col(BuildItems::Slot)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name(NEW_UNIQUE_INDEX)
                    .table(BuildItems::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(BuildItems::Table)
                    .drop_column(BuildItems::Loadout)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name(OLD_UNIQUE_INDEX)
                    .table(BuildItems::Table)
                    .col(BuildItems::BuildId)
                    .col(BuildItems::Slot)
                    .unique()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum BuildItems {
    Table,
    BuildId,
    Slot,
    Loadout,
}
