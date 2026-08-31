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
