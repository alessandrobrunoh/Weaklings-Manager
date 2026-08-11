//! Sea-ORM entity for the `siphoned_energy_entries` table (the Guild Siphoned Energy ledger).
//!
//! A row is an immutable record of one Albion Online in-game event (deposit or withdrawal of
//! siphoned energy by a named player). There is no FK to `users` or `albion_links`: the export
//! only carries the in-game display name, so rows are grouped at query time via
//! `LOWER(player_name)` instead of by a stable player id. See `plans/siphoned-module.md`.

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "siphoned_energy_entries")]
pub struct Model {
    /// The unique primary key of the ledger entry.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// The in-game timestamp the event occurred (UTC, normalized by the frontend before ingest).
    pub occurred_at: DateTimeWithTimeZone,
    /// The Albion in-game player name, stored verbatim. Grouped case-insensitively at query time.
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    pub player_name: String,
    /// The raw Albion reason string (`"Withdrawal"`, `"Deposit"`, …). Free-form on purpose so new
    /// reasons from Albion don't require a migration.
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    pub reason: String,
    /// Signed amount: deposits positive, withdrawals negative. Preserved exactly as Albion reports.
    pub amount: Decimal,
    /// The origin of the row. Always `"albion_export"` in v1; future manual entries use `"manual"`.
    #[sea_orm(
        column_type = "String(StringLen::N(32))",
        default_value = "albion_export"
    )]
    pub source: String,
    /// UUID (string) of the bulk batch this row belongs to, or `None` for single-row inserts.
    #[sea_orm(column_type = "String(StringLen::N(36))", nullable)]
    pub ingest_batch: Option<String>,
    /// The server-side timestamp when the row was written.
    pub ingested_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
