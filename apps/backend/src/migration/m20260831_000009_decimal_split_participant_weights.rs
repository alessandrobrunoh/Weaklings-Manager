//! Allow split participant weights to contain decimal percentages.

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

/// Changes split participant weights from integers to fixed-point decimals.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite does not support ALTER COLUMN. Its dynamic typing still stores the decimal
        // values correctly, and the initial schema uses the decimal definition below.
        if manager.get_database_backend() == DatabaseBackend::Sqlite {
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(SplitParticipants::Table)
                    .modify_column(
                        ColumnDef::new(SplitParticipants::Weight)
                            .decimal_len(16, 2)
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }

    /// # Data-loss warning
    ///
    /// Rolling back narrows `weight` from `decimal(16, 2)` back to `integer`. Any row that was
    /// written with a fractional weight since `up()` ran (e.g. `1.5`) is silently truncated to
    /// its integer part by the database's implicit cast, not rejected — participant weighting on
    /// any split saved with decimal weights will be permanently altered. Confirm no live split
    /// participant carries a fractional weight before rolling this migration back.
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.get_database_backend() == DatabaseBackend::Sqlite {
            return Ok(());
        }

        manager
            .alter_table(
                Table::alter()
                    .table(SplitParticipants::Table)
                    .modify_column(
                        ColumnDef::new(SplitParticipants::Weight)
                            .integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SplitParticipants {
    Table,
    Weight,
}
