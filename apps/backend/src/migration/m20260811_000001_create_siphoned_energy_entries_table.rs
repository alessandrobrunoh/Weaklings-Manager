//! Migration script to create the `siphoned_energy_entries` table (the Guild Siphoned Energy ledger).

use sea_orm::DatabaseBackend;
use sea_orm_migration::prelude::*;

/// Migration step to create the `siphoned_energy_entries` table.
///
/// Each row is an immutable ledger entry imported from the Albion Online siphoned-energy export.
/// There is no FK to `users` or `albion_links`: rows are attributed to an in-game player name
/// (see `player_name`) and grouped case-insensitively at query time via `LOWER(player_name)`.
///
/// `ingest_batch` is stored as `VARCHAR(36)` (UUID string) rather than a native UUID type so the
/// migration is portable across `PostgreSQL` and `SQLite` — the test suite runs against
/// `sqlite::memory:`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SiphonedEnergyEntries::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::PlayerName)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::Reason)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::Amount)
                            .decimal_len(16, 0)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::Source)
                            .string_len(32)
                            .not_null()
                            .default("albion_export"),
                    )
                    .col(ColumnDef::new(SiphonedEnergyEntries::IngestBatch).string_len(36))
                    .col(
                        ColumnDef::new(SiphonedEnergyEntries::IngestedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        // Functional `LOWER()` index: only PostgreSQL supports expression indexes, and the
        // in-memory SQLite used by the test suite panics on them.
        if manager.get_database_backend() == DatabaseBackend::Postgres {
            manager
                .create_index(
                    Index::create()
                        .name("idx_siphoned_player_lower")
                        .table(SiphonedEnergyEntries::Table)
                        .col(Expr::cust("LOWER(\"player_name\")"))
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_index(
                Index::create()
                    .name("idx_siphoned_occurred_at")
                    .table(SiphonedEnergyEntries::Table)
                    .col(SiphonedEnergyEntries::OccurredAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_siphoned_ingest_batch")
                    .table(SiphonedEnergyEntries::Table)
                    .col(SiphonedEnergyEntries::IngestBatch)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SiphonedEnergyEntries::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum SiphonedEnergyEntries {
    Table,
    Id,
    OccurredAt,
    PlayerName,
    Reason,
    Amount,
    Source,
    IngestBatch,
    IngestedAt,
}
