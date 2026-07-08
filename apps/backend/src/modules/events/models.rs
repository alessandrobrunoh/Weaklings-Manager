//! Request/response DTOs and view models for the events module.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// General details of an event.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventView {
    /// The unique identifier of the event.
    #[schema(example = 1)]
    pub id: i64,
    /// The title of the event.
    pub title: String,
    /// An optional description of the event.
    pub description: Option<String>,
    /// The base composition ID associated with the event.
    #[schema(example = 10)]
    pub comp_id: i64,
    /// The name of the base composition.
    pub comp_name: String,
    /// The ID of the user who created this event.
    #[schema(example = 1)]
    pub created_by: i64,
    /// The username of the user who created this event.
    pub created_by_username: String,
    /// The start date of the event in UTC.
    pub event_date_utc: String,
    /// The timestamp when the event was created.
    pub created_at: String,
    /// The timestamp when the event was last updated.
    pub updated_at: String,
    /// Session status: `scheduled` | `live` | `stopped` | `auto_stopped`.
    pub status: String,
    /// When the session went live (RFC3339), if ever.
    pub started_at: Option<String>,
    /// When the session was stopped (RFC3339), if ever.
    pub stopped_at: Option<String>,
    /// Hard deadline (RFC3339) after which the session auto-stops.
    pub auto_stop_deadline: Option<String>,
    /// Linker status: `pending` | `in_progress` | `completed` | `failed`.
    pub link_status: String,
    /// Number of AlbionBB fetch attempts performed by the linker.
    pub link_attempts: i64,
    /// Last error message recorded by the linker, if any.
    pub link_last_error: Option<String>,
    /// When battle linking was definitively concluded (RFC3339), if ever.
    pub link_battles_completed_at: Option<String>,
}

/// Details of a participant in an event.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventParticipantView {
    /// The unique database user ID of the participant.
    #[schema(example = 2)]
    pub user_id: i64,
    /// The username of the participant.
    pub username: String,
    /// The primary build ID chosen by the participant.
    #[schema(example = 5)]
    pub primary_build_id: i64,
    /// The name of the primary build.
    pub primary_build_name: String,
    /// The optional secondary build ID.
    #[schema(example = 7)]
    pub secondary_build_id: Option<i64>,
    /// The name of the secondary build (if any).
    pub secondary_build_name: Option<String>,
}

/// A battle linked to an event session.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventBattleView {
    /// Row id in `event_battles`.
    pub id: i64,
    /// AlbionBB opaque battle id.
    pub albionbb_battle_id: String,
    /// When the battle started (RFC3339).
    pub battle_started_at: String,
    /// Number of players from the configured guild seen in this battle.
    pub guild_players_count: i32,
    /// Total players in the battle (across all guilds), if known.
    pub battle_total_players: Option<i32>,
    /// When this row was last refreshed from AlbionBB (RFC3339).
    pub fetched_at: String,
}

/// Full details of an event including active comp details and participants list.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventDetailView {
    /// The basic event view details.
    #[serde(flatten)]
    pub event: EventView,
    /// The active composition ID (might be base or variant depending on count).
    #[schema(example = 11)]
    pub active_comp_id: i64,
    /// The name of the active composition.
    pub active_comp_name: String,
    /// The total capacity of the active composition.
    #[schema(example = 25)]
    pub active_comp_capacity: i64,
    /// The list of registered participants.
    pub participants: Vec<EventParticipantView>,
    /// Battles linked to this event session (only populated while/after live).
    pub battles: Vec<EventBattleView>,
}

/// Request body to create a new event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "title": "ZvZ Castle Fight",
    "description": "Weekly Castle Fight. Be on time!",
    "comp_id": 1,
    "event_date_utc": "2026-07-20T20:00:00Z"
}))]
pub struct CreateEventRequest {
    /// The title of the event.
    pub title: String,
    /// An optional description of the event.
    pub description: Option<String>,
    /// The base composition ID to use.
    pub comp_id: i64,
    /// The start date and time of the event (UTC, e.g. RFC3339).
    pub event_date_utc: String,
}

/// Request body to update an existing event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "title": "ZvZ Castle Fight (Updated Time)",
    "event_date_utc": "2026-07-20T20:30:00Z"
}))]
pub struct UpdateEventRequest {
    /// The new title of the event.
    pub title: Option<String>,
    /// The new description of the event.
    pub description: Option<String>,
    /// The new base composition ID.
    pub comp_id: Option<i64>,
    /// The new start date and time of the event (UTC, e.g. RFC3339).
    pub event_date_utc: Option<String>,
}

/// Request body to participate in an event or update participation builds.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "primary_build_id": 5,
    "secondary_build_id": 7
}))]
pub struct ParticipateEventRequest {
    /// The primary build ID chosen (must have available slots in active comp).
    pub primary_build_id: i64,
    /// The optional backup/secondary build ID.
    pub secondary_build_id: Option<i64>,
}
