//! Creates `combat_scenarios`: a saved combat test — a declared burst window an officer can
//! reopen, tweak and re-run.
//!
//! Versioned the same way `builds`/`comps` are: each version is its own row, unique on
//! `(name, version)`, rather than a separate parent/version-history table — editing a scenario
//! creates a new version and the old one stays exactly as it was run.
//!
//! The scenario itself — its unit groups and declared casts — is stored as a JSON string
//! (`definition_json`), the same choice `scouted_comps` made for its roster payload: the shape is
//! validated by the request DTOs at the API boundary, not by the database.

use sea_orm_migration::prelude::*;

/// Migration for the `combat_scenarios` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(CombatScenarios::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CombatScenarios::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(CombatScenarios::Name).string().not_null())
                    .col(
                        ColumnDef::new(CombatScenarios::Version)
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(CombatScenarios::DefinitionJson)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CombatScenarios::CreatedBy)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CombatScenarios::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(
                        ColumnDef::new(CombatScenarios::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(CombatScenarios::ArchivedAt).timestamp_with_time_zone())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_combat_scenarios_created_by")
                            .from(CombatScenarios::Table, CombatScenarios::CreatedBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_combat_scenarios_name_version_unique")
                    .table(CombatScenarios::Table)
                    .col(CombatScenarios::Name)
                    .col(CombatScenarios::Version)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CombatScenarios::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum CombatScenarios {
    Table,
    Id,
    Name,
    Version,
    DefinitionJson,
    CreatedBy,
    CreatedAt,
    UpdatedAt,
    ArchivedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
