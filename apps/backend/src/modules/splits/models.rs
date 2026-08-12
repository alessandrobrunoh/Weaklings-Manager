//! Request/response DTOs and view models for the splits module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over
//! the API and their `OpenAPI` schemas.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::SplitStatus;

/// A participant's weight-based share within a split.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct SplitParticipantView {
    /// The participating user's id.
    #[schema(example = 7)]
    pub user_id: i64,
    /// The participating user's username.
    #[schema(example = "rust_developer")]
    pub username: String,
    /// The normalized weight of this participant relative to others in the split.
    #[schema(example = 20)]
    pub weight: i32,
    /// The computed share amount. Populated once the split is completed.
    #[schema(value_type = Option<String>, example = "16.66")]
    pub share_amount: Option<Decimal>,
}

/// A split's summary, as shown in list views.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct SplitSummary {
    /// The unique identifier of the split.
    #[schema(example = 1)]
    pub id: i64,
    /// The username of the user who created the split.
    #[schema(example = "raid_leader")]
    pub created_by_username: String,
    /// The lifecycle status of the split.
    pub status: SplitStatus,
    /// The estimated market value of the loot before deductions.
    #[schema(value_type = String, example = "100.00")]
    pub estimated_market_value: Decimal,
    /// The repair costs deducted from the market value.
    #[schema(value_type = String, example = "10.00")]
    pub repair_value: Decimal,
    /// The bags/consumables value added to the market value.
    #[schema(value_type = String, example = "5.00")]
    pub bags_value: Decimal,
    /// The net value distributed among participants, set only once completed.
    #[schema(value_type = Option<String>, example = "85.00")]
    pub net_value: Option<Decimal>,
    /// An optional free-text note (e.g. boss/item name).
    #[schema(example = "Ancient Avalon boss drop")]
    pub note: Option<String>,
    /// Event linked to this split, if the loot belongs to a tracked activity.
    #[schema(example = 42)]
    pub event_id: Option<i64>,
    /// Event title for display without an extra frontend lookup.
    pub event_title: Option<String>,
    /// The timestamp when the split was created.
    pub created_at: String,
    /// The timestamp when the split was completed (money paid out), if it has been. Despite the
    /// field name, this is only ever set by `POST /splits/{id}/complete` — not by
    /// `not-completed` or `lost`, which leave it `null`.
    pub finalized_at: Option<String>,
    /// The number of participants in the split.
    #[schema(example = 3)]
    pub participant_count: u64,
}

/// A split's full detail, including participants.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct SplitDetail {
    /// The split's summary fields.
    #[serde(flatten)]
    pub summary: SplitSummary,
    /// The list of participants and their computed shares.
    pub participants: Vec<SplitParticipantView>,
}

/// Request body to request a new split.
///
/// Participants must be provided upfront — a split cannot be requested without knowing who
/// should be paid out.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "estimated_market_value": "100.00",
    "repair_value": "10.00",
    "bags_value": "5.00",
    "note": "Ancient Avalon boss drop",
    "participants": [
        { "user_id": 7, "weight": 20 },
        { "user_id": 12, "weight": 10 }
    ]
}))]
pub struct CreateSplitRequest {
    /// The estimated market value of the loot before deductions.
    #[schema(value_type = String, example = "100.00")]
    pub estimated_market_value: Decimal,
    /// The repair costs deducted from the market value.
    #[schema(value_type = String, example = "10.00")]
    pub repair_value: Decimal,
    /// The bags/consumables value added to the market value.
    #[schema(value_type = String, example = "5.00")]
    pub bags_value: Decimal,
    /// An optional free-text note (e.g. boss/item name).
    #[schema(example = "Ancient Avalon boss drop")]
    pub note: Option<String>,
    /// Optional event id to connect the split to an event's post-activity statistics.
    ///
    /// When `participants` is empty and this is set, the split's roster is seeded from the
    /// event's sign-ups (each with the default event weight).
    #[schema(example = 42)]
    pub event_id: Option<i64>,
    /// The participants to distribute the loot to, with their relative weights. Must be
    /// non-empty and contain no duplicate user ids.
    pub participants: Vec<UpsertParticipantRequest>,
}

/// Request body for editing the mutable fields of a pending split.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "estimated_market_value": "125.00",
    "repair_value": "12.00",
    "bags_value": "5.00",
    "note": "Updated Avalon boss drop"
}))]
pub struct UpdateSplitRequest {
    /// New estimated market value. Omit to keep the current value.
    #[schema(value_type = Option<String>, example = "125.00")]
    pub estimated_market_value: Option<Decimal>,
    /// New repair costs. Omit to keep the current value.
    #[schema(value_type = Option<String>, example = "12.00")]
    pub repair_value: Option<Decimal>,
    /// New bags/consumables value. Omit to keep the current value.
    #[schema(value_type = Option<String>, example = "5.00")]
    pub bags_value: Option<Decimal>,
    /// New free-text note. Send an empty string to clear it.
    pub note: Option<String>,
    /// New event link. `null` clears the association.
    ///
    /// Side effect: setting this to `Some(event_id)` synchronizes the split's participants
    /// with the event's sign-ups — existing participants absent from the event are removed,
    /// event sign-ups not yet in the split are added with a default weight, and participants
    /// in both keep their current weight.
    pub event_id: Option<Option<i64>>,
}

/// Request body to add or update a participant's weight in a pending split.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpsertParticipantRequest {
    /// The user id to add or update.
    #[schema(example = 7)]
    pub user_id: i64,
    /// The normalized weight to assign this participant. Must be positive.
    #[schema(example = 20)]
    pub weight: i32,
}

/// Request body for matching a list of raw (e.g. OCR-extracted) names against known,
/// already-linked Albion Online players.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({ "names": ["Alice", "Bob", "SomeRandomOcrNoise"] }))]
pub struct MatchParticipantsRequest {
    /// Raw candidate names to match, e.g. lines extracted from a screenshot via OCR.
    /// Matching is case-insensitive; unmatched names are silently dropped from the response.
    pub names: Vec<String>,
}

/// A single candidate name that was successfully matched to a saved user account via that
/// user's linked Albion Online character name.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MatchedParticipant {
    /// The matched user's id — usable directly as a split participant's `user_id`.
    #[schema(example = 7)]
    pub user_id: i64,
    /// The matched user's username.
    #[schema(example = "rust_developer")]
    pub username: String,
    /// The Albion Online character name that was matched, for transparency about which
    /// candidate string produced this match.
    #[schema(example = "Alice")]
    pub matched_name: String,
}

/// Filters that can be applied when listing splits.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SplitFilters {
    /// Filter splits by their status.
    pub status: Option<SplitStatus>,
    /// Filter splits linked to a specific event.
    pub event_id: Option<i64>,
    /// Filter by note or creator username.
    pub search: Option<String>,
    /// Filter by created_at date (inclusive).
    pub date_from: Option<String>,
    /// Filter by created_at date (inclusive).
    pub date_to: Option<String>,
}
