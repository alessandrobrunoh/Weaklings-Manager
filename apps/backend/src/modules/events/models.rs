//! Request/response DTOs and view models for the events module.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::modules::battles::models::BattleLossEstimate;

/// Filters for listing events.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct EventFilters {
    /// Filter by event title (case-insensitive partial match).
    pub search: Option<String>,
    /// Filter by start date (inclusive).
    pub date_from: Option<String>,
    /// Filter by end date (inclusive).
    pub date_to: Option<String>,
}

/// Aggregated performance metrics for an event or composition.
#[derive(Debug, Serialize, Clone, Default, ToSchema)]
pub struct BattlePerformanceStats {
    /// Total battles linked to the analytical scope.
    pub total_battles: i64,
    /// Battles won by the configured guild.
    pub wins: i64,
    /// Battles lost or not marked as won by AlbionBB.
    pub losses: i64,
    /// Win percentage in the `0..=100` range.
    pub win_rate: f64,
    /// Kills scored by the configured guild.
    pub total_kills: i64,
    /// Deaths suffered by the configured guild.
    pub total_deaths: i64,
    /// Kill/death ratio. Uses kills as-is when deaths are zero.
    pub kill_death_ratio: f64,
    /// Kill fame scored by the configured guild.
    pub total_kill_fame: i64,
    /// Average guild player count across linked battles.
    pub average_guild_players: f64,
    /// Most frequent or highest-impact opponents faced in this scope.
    pub top_opponents: Vec<OpponentPerformanceView>,
}

/// Opponent rollup for event and comp analytics.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct OpponentPerformanceView {
    /// AlbionBB guild id when available.
    pub guild_id: Option<String>,
    /// Human-readable guild name when available.
    pub guild_name: String,
    /// Number of linked battles against this opponent.
    pub battles: i64,
    /// Wins against this opponent.
    pub wins: i64,
    /// Losses against this opponent.
    pub losses: i64,
    /// Kill fame scored by our guild in these matchups.
    pub guild_kill_fame: i64,
    /// Kill fame scored by the opponent in these matchups.
    pub opponent_kill_fame: i64,
}

/// Historical performance of a comp across linked event sessions.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompPerformanceView {
    /// Composition identifier used by the events.
    pub comp_id: i64,
    /// Composition display name.
    pub comp_name: String,
    /// Number of events that currently have at least one linked battle.
    pub events_with_battles: i64,
    /// Aggregated battle performance for all events using this comp.
    pub stats: BattlePerformanceStats,
}

/// Aggregated loot split metrics linked to an event.
#[derive(Debug, Serialize, Clone, Default, ToSchema)]
pub struct EventSplitStats {
    /// Number of splits linked to the event.
    pub total_splits: i64,
    /// Splits still awaiting officer closure.
    pub pending_splits: i64,
    /// Splits completed and credited to participants.
    pub completed_splits: i64,
    /// Splits marked as not completed.
    pub not_completed_splits: i64,
    /// Splits marked as lost.
    pub lost_splits: i64,
    /// Sum of estimated market values across linked splits.
    #[schema(value_type = String, example = "1000000.00")]
    pub estimated_market_value: Decimal,
    /// Sum of repair deductions across linked splits.
    #[schema(value_type = String, example = "25000.00")]
    pub repair_value: Decimal,
    /// Sum of bags/consumables values across linked splits.
    #[schema(value_type = String, example = "50000.00")]
    pub bags_value: Decimal,
    /// Sum of completed net payouts.
    #[schema(value_type = String, example = "1025000.00")]
    pub completed_net_value: Decimal,
    /// Number of participant rows across linked splits.
    pub participant_entries: i64,
}

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
    /// Whether this event is a priority call-to-arms announcement.
    pub call_to_arms: bool,
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
    /// The participant's Discord user ID, if their account is linked. Lets a caller (the bot, in
    /// particular) tell "this is me" apart from every other participant without a numeric
    /// `user_id` neither side already has in hand.
    pub discord_id: Option<String>,
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
    /// Kills scored by the configured guild.
    pub guild_kills: i64,
    /// Deaths suffered by the configured guild.
    pub guild_deaths: i64,
    /// Kill fame scored by the configured guild.
    pub guild_kill_fame: i64,
    /// Whether the configured guild won this battle.
    pub is_win: bool,
    /// Main opponent guild ID by kill fame, if known.
    pub opponent_guild_id: Option<String>,
    /// Main opponent guild name by kill fame, if known.
    pub opponent_guild_name: Option<String>,
    /// Main opponent player count, if known.
    pub opponent_players_count: Option<i32>,
    /// Main opponent kills, if known.
    pub opponent_kills: Option<i64>,
    /// Main opponent deaths, if known.
    pub opponent_deaths: Option<i64>,
    /// Main opponent kill fame, if known.
    pub opponent_kill_fame: Option<i64>,
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
    /// Aggregated event outcome and fight performance.
    pub stats: BattlePerformanceStats,
    /// Market-based equipment loss estimates aggregated from persisted battle snapshots.
    pub estimated_losses: BattleLossEstimate,
    /// Loot splits connected to this event.
    pub splits: Vec<crate::modules::splits::models::SplitSummary>,
    /// Aggregated split economy statistics.
    pub split_stats: EventSplitStats,
}

/// Request body used by officers to define the exact battles linked to an event.
///
/// Replacing the full list supports the valid `0+ battles` model: an empty array explicitly means
/// the event currently has no battle evidence attached, while one or more IDs become the battle set
/// used by analytics.
///
/// # Example
/// ```rust
/// # use backend::modules::events::models::UpdateEventBattlesRequest;
/// let request = UpdateEventBattlesRequest {
///     battle_ids: vec!["123456789".to_string()],
/// };
/// assert_eq!(request.battle_ids.len(), 1);
/// ```
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({ "battle_ids": ["123456789", "123456790"] }))]
pub struct UpdateEventBattlesRequest {
    /// AlbionBB battle IDs to attach. Empty list removes every linked battle from the event.
    pub battle_ids: Vec<String>,
}

/// Request body to create a new event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "title": "ZvZ Castle Fight",
    "description": "Weekly Castle Fight. Be on time!",
    "call_to_arms": false,
    "comp_id": 1,
    "event_date_utc": "2026-07-20T20:00:00Z"
}))]
pub struct CreateEventRequest {
    /// The title of the event.
    pub title: String,
    /// An optional description of the event.
    pub description: Option<String>,
    /// Whether this event is a priority call-to-arms announcement (default: false).
    #[serde(default)]
    pub call_to_arms: bool,
    /// The base composition ID to use.
    pub comp_id: i64,
    /// The start date and time of the event (UTC, e.g. RFC3339).
    pub event_date_utc: String,
    /// Also create an empty loot split already linked to this event.
    ///
    /// Saves the officer from creating the split by hand after the fight and
    /// remembering to attach it. The split starts at zero with no participants;
    /// its roster fills from the event's sign-ups when it is next updated, so
    /// creating it up front costs nothing if the fight never happens.
    #[serde(default)]
    pub create_split: bool,
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
    /// Whether this event should be treated as a call-to-arms announcement.
    pub call_to_arms: Option<bool>,
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

/// Request body used by event creators / officers with `events.manage` to
/// forcibly set the build assignment of an arbitrary guild member.
///
/// Mirrors [`ParticipateEventRequest`] but is intended for the
/// `PUT /api/events/{id}/participants/{user_id}` route, so the target user is
/// picked from the URL instead of being inferred from the session.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "primary_build_id": 5,
    "secondary_build_id": 7
}))]
pub struct SetParticipantRequest {
    /// The primary build ID to assign (must have available slots in active comp).
    pub primary_build_id: i64,
    /// The optional backup/secondary build ID to assign.
    pub secondary_build_id: Option<i64>,
}
