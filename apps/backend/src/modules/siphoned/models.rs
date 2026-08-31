//! Request/response DTOs and view models for the siphoned module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over the
//! API and their `OpenAPI` schemas.

use std::str::FromStr;

use chrono::{DateTime, FixedOffset};
use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::entities::Model;
use super::status::SiphonedEntrySource;

/// One ledger row, as seen by a client.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EntryView {
    /// The unique identifier of the ledger entry.
    #[schema(example = 1)]
    pub id: i64,
    /// The in-game timestamp when the event occurred (RFC3339 / ISO8601 UTC).
    #[schema(example = "2026-08-10T20:37:41Z")]
    pub occurred_at: String,
    /// The Albion in-game player name.
    #[schema(example = "Galvdon")]
    pub player_name: String,
    /// The raw Albion reason string.
    #[schema(example = "Withdrawal")]
    pub reason: String,
    /// Signed amount: deposits positive, withdrawals negative. String-encoded to preserve exact
    /// decimal semantics (the `bank` module uses the same convention).
    #[schema(value_type = String, example = "-10")]
    pub amount: Decimal,
    /// The origin of the row.
    pub source: SiphonedEntrySource,
    /// UUID (string) of the bulk batch this row belongs to, or `None`.
    #[schema(example = "0191abc4-1234-5678-9abc-def012345678")]
    pub ingest_batch: Option<String>,
    /// The server-side timestamp when the row was written.
    #[schema(example = "2026-08-11T14:22:01Z")]
    pub ingested_at: String,
}

impl EntryView {
    /// Builds a view from a `SeaORM` model row. The enum is parsed leniently: an unknown `source`
    /// string in the DB falls back to [`SiphonedEntrySource::AlbionExport`] rather than failing
    /// the whole read, so a stale row from a removed variant never breaks the listing endpoint.
    pub(super) fn from_model(model: Model) -> Self {
        let source = SiphonedEntrySource::from_str(&model.source)
            .unwrap_or(SiphonedEntrySource::AlbionExport);
        Self {
            id: model.id,
            occurred_at: model.occurred_at.to_rfc3339(),
            player_name: model.player_name,
            reason: model.reason,
            amount: model.amount,
            source,
            ingest_batch: model.ingest_batch,
            ingested_at: model.ingested_at.to_rfc3339(),
        }
    }
}

/// Per-player aggregates returned by `GET /balances`.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct PlayerBalance {
    /// The Albion player name. Uses the casing of the most recent row for that player so the
    /// client renders the "current" spelling.
    #[schema(example = "MrMaranza06")]
    pub player_name: String,
    /// Total deposited (sum of all positive amounts). Always >= 0.
    #[schema(value_type = String, example = "13")]
    pub total_deposited: Decimal,
    /// Total withdrawn (sum of all negative amounts, sign-flipped). Always >= 0.
    #[schema(value_type = String, example = "53")]
    pub total_withdrawn: Decimal,
    /// Net = `total_deposited - total_withdrawn`. Negative means the player is in debt.
    #[schema(value_type = String, example = "-40")]
    pub net: Decimal,
    /// Total number of ledger rows contributing to this aggregate.
    #[schema(example = 6)]
    pub entry_count: u64,
    /// RFC3339 timestamp of the earliest row for this player.
    #[schema(example = "2026-07-19T18:40:02Z")]
    pub first_seen: String,
    /// RFC3339 timestamp of the latest row for this player.
    #[schema(example = "2026-08-10T14:56:09Z")]
    pub last_seen: String,
}

/// Single-player detail returned by `GET /balances/{player_name}`.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct PlayerBalanceDetail {
    /// The aggregated balance.
    pub balance: PlayerBalance,
    /// The most recent entries for this player (default 20, capped by the service).
    pub recent_entries: Vec<EntryView>,
}

/// Sort options for `GET /balances`.
#[derive(Debug, Clone, Copy, Deserialize, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum BalanceSort {
    /// Smallest net first (biggest debtors on top). Default.
    #[default]
    NetAsc,
    /// Largest net first (biggest creditors on top).
    NetDesc,
    /// Alphabetical by player name.
    NameAsc,
}

/// `GET /balances` query filters.
#[derive(Debug, Deserialize, Default, utoipa::IntoParams)]
pub struct BalanceQuery {
    /// Only return players whose `net` is strictly less than this value. Useful for
    /// "show me debtors" views (`min_debt=0`). Omit for the full list. Sent as a string-encoded
    /// Decimal (e.g. `min_debt=-10`).
    #[param(value_type = Option<String>, example = "-10")]
    pub min_debt: Option<Decimal>,
    /// Sort order. Defaults to `net_asc` (biggest debtors first).
    pub sort: Option<BalanceSort>,
    /// Case-insensitive substring match on player name.
    pub search: Option<String>,
    /// 1-indexed page. Defaults to 1.
    pub page: Option<u64>,
    /// Page size. Defaults to 10.
    pub limit: Option<u64>,
}

/// Editable fields for a single siphoned ledger row.
///
/// Manual entry edits use the same shape as an imported Albion row so officers can correct copy
/// mistakes without learning a second payload format.
///
/// # Example
/// ```json
/// { "occurred_at": "2026-08-10T20:37:41Z", "player_name": "Galvdon", "reason": "Withdrawal", "amount": "-10" }
/// ```
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct EntryMutationRequest {
    /// The in-game timestamp of the event, already normalized to UTC RFC3339 by the frontend.
    #[schema(value_type = String, example = "2026-08-10T20:37:41Z")]
    pub occurred_at: DateTime<FixedOffset>,
    /// The Albion in-game player name (1..=64 chars after trim).
    #[schema(example = "Galvdon")]
    pub player_name: String,
    /// The raw Albion reason string (1..=64 chars after trim).
    #[schema(example = "Withdrawal")]
    pub reason: String,
    /// Signed amount, string-encoded by the client to preserve exact decimal semantics; the
    /// backend parses it into a `Decimal`.
    #[schema(value_type = String, example = "-10")]
    pub amount: Decimal,
}

/// A single row in an ingest payload. Mirrors one line of the Albion in-game export.
pub type IngestRow = EntryMutationRequest;

/// Request body for `POST /api/siphoned/ingest`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct IngestRequest {
    /// The rows to import. Must be non-empty; at most 1000 per request.
    pub rows: Vec<IngestRow>,
}

/// Result of a successful bulk ingest.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct IngestResponse {
    /// UUID (string) of the batch all imported rows were tagged with.
    #[schema(example = "0191abc4-1234-5678-9abc-def012345678")]
    pub batch_id: String,
    /// How many rows were actually written.
    #[schema(example = 32)]
    pub ingested_count: u64,
    /// RFC3339 timestamp at which the batch was committed.
    #[schema(example = "2026-08-11T14:22:01Z")]
    pub ingested_at: String,
}

/// Filters that can be applied when listing entries via `GET /entries`.
#[derive(Debug, Clone, Deserialize, Default, ToSchema)]
pub struct EntryFilters {
    /// Case-insensitive match on `player_name`.
    pub player_name: Option<String>,
    /// Exact match on `reason` (e.g. `"Withdrawal"`).
    pub reason: Option<String>,
    /// Inclusive lower bound on `occurred_at` (RFC3339).
    #[schema(value_type = Option<String>, example = "2026-08-01T00:00:00Z")]
    pub since: Option<DateTime<FixedOffset>>,
    /// Inclusive upper bound on `occurred_at` (RFC3339).
    #[schema(value_type = Option<String>, example = "2026-08-31T23:59:59Z")]
    pub until: Option<DateTime<FixedOffset>>,
    /// Restrict to rows from one ingestion batch.
    pub batch_id: Option<String>,
    /// Case-insensitive substring match on `player_name` or `reason`.
    pub search: Option<String>,
    /// Sort column. Allowed: `occurred_at` (default), `player_name`, `amount`, `reason`, `ingested_at`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
}

/// One row of `GET /batches`.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BatchSummary {
    /// UUID (string) of the batch.
    #[schema(example = "0191abc4-1234-5678-9abc-def012345678")]
    pub batch_id: String,
    /// RFC3339 timestamp of the earliest `ingested_at` in the batch (a proxy for "when it was
    /// imported", since all rows in one batch share the same ingestion moment).
    #[schema(example = "2026-08-11T14:22:01Z")]
    pub ingested_at: String,
    /// Number of rows in the batch.
    #[schema(example = 32)]
    pub row_count: u64,
}

/// Payload returned by `DELETE /batches/{batch_id}`.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct DeletedCount {
    /// How many rows were removed.
    #[schema(example = 32)]
    pub deleted_count: u64,
}
