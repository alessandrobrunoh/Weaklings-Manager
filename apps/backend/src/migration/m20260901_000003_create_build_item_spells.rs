//! Migration script to create the `build_item_spells` table.
//!
//! An ability choice belongs to the item in a slot, not to the build: the equipped weapon is what
//! decides which spells are on offer. Hanging the rows off `build_item_id` means the main loadout
//! and the swap keep separate choices for free, and swapping an item out cascades its choices away.
//!
//! `kind` is `active` or `passive`; `slot_index` is 1-based within that kind — active 1/2/3 are the
//! player's Q/W/E on a weapon, while an armor piece has a single active slot bound to D, R or F.

use sea_orm_migration::prelude::*;

use super::m20260710_000006_create_build_items_table::BuildItems;

/// Migration step to create the `build_item_spells` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(BuildItemSpells::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(BuildItemSpells::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(BuildItemSpells::BuildItemId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BuildItemSpells::Kind).string().not_null())
                    .col(
                        ColumnDef::new(BuildItemSpells::SlotIndex)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(BuildItemSpells::SpellId).string().not_null())
                    .col(
                        ColumnDef::new(BuildItemSpells::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(BuildItemSpells::Table, BuildItemSpells::BuildItemId)
                            .to(BuildItems::Table, BuildItems::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // One ability per slot, per kind, per item.
        manager
            .create_index(
                Index::create()
                    .name("idx_build_item_spells_item_kind_slot_unique")
                    .table(BuildItemSpells::Table)
                    .col(BuildItemSpells::BuildItemId)
                    .col(BuildItemSpells::Kind)
                    .col(BuildItemSpells::SlotIndex)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_build_item_spells_build_item_id")
                    .table(BuildItemSpells::Table)
                    .col(BuildItemSpells::BuildItemId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(BuildItemSpells::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum BuildItemSpells {
    Table,
    Id,
    BuildItemId,
    Kind,
    SlotIndex,
    SpellId,
    CreatedAt,
}
