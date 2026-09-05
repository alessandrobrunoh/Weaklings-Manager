//! Creates `combat_runs`: the pinned result of running one `combat_scenarios` version.
//!
//! `engine_version` and `dataset_commit` are stamped at run time so a result stays legible after an
//! Albion patch or an engine change shifts the numbers underneath it — a run from before a patch
//! reads as "this is what it was, then", never silently reinterpreted against today's dataset.

use sea_orm_migration::prelude::*;

use super::m20260906_000003_create_combat_scenarios::CombatScenarios;

/// Migration for the `combat_runs` table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(CombatRuns::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CombatRuns::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(CombatRuns::ScenarioId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CombatRuns::EngineVersion)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CombatRuns::DatasetCommit)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(CombatRuns::ResultJson).text().not_null())
                    .col(ColumnDef::new(CombatRuns::RanBy).big_integer().not_null())
                    .col(
                        ColumnDef::new(CombatRuns::RanAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_combat_runs_scenario_id")
                            .from(CombatRuns::Table, CombatRuns::ScenarioId)
                            .to(CombatScenarios::Table, CombatScenarios::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_combat_runs_ran_by")
                            .from(CombatRuns::Table, CombatRuns::RanBy)
                            .to(Users::Table, Users::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_combat_runs_scenario_id")
                    .table(CombatRuns::Table)
                    .col(CombatRuns::ScenarioId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CombatRuns::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum CombatRuns {
    Table,
    Id,
    ScenarioId,
    EngineVersion,
    DatasetCommit,
    ResultJson,
    RanBy,
    RanAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
