//! Adds the per-guild brand colours the web app themes itself with.
//!
//! Nullable on purpose: a guild that never picks colours keeps the product
//! defaults, and clearing a colour is how you go back to them.

use sea_orm_migration::prelude::*;

/// Migration step storing the three brand colours on `guild_settings`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::BrandPrimaryColor,
            GuildSettings::BrandSecondaryColor,
            GuildSettings::BrandTertiaryColor,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        // `#rrggbb` — 7 characters, with room to spare.
                        .add_column(ColumnDef::new(column).string_len(16))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            GuildSettings::BrandPrimaryColor,
            GuildSettings::BrandSecondaryColor,
            GuildSettings::BrandTertiaryColor,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(GuildSettings::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum GuildSettings {
    Table,
    BrandPrimaryColor,
    BrandSecondaryColor,
    BrandTertiaryColor,
}
