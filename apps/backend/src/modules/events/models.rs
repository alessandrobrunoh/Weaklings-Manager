//! Request/response DTOs and view models for the events module.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::modules::battles::models::BattleLossEstimate;
use crate::modules::comps::status::BuildRole;

/// Filters for listing events.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct EventFilters {
    /// Filter by event title (case-insensitive partial match).
    pub search: Option<String>,
    /// Filter by start date (inclusive).
    pub date_from: Option<String>,
    /// Filter by end date (inclusive).
    pub date_to: Option<String>,
    /// Filter by session status (`scheduled`, `live`, `stopped`, `auto_stopped`, `cancelled`).
    pub status: Option<String>,
    /// Sort column. Allowed: `start_time_utc`/`event_date_utc` (default), `mass_time_utc`, `title`, `created_at`, `status`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `asc` for the date column.
    pub order: Option<String>,
    /// When `true`, only archived events. When omitted or `false`, only active events.
    pub archived: Option<bool>,
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
/// Battle numbers attributed to the players who actually ran one build version.
///
/// These are per-player figures pulled out of the stored battle snapshots, not event totals, so two
/// builds in the same fight get different numbers.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[schema(example = json!({
    "events": 12,
    "battles": 31,
    "matched_players": 96,
    "wins": 19,
    "losses": 12,
    "kills": 214,
    "deaths": 88,
    "kill_fame": 41_200_000,
    "death_fame": 9_100_000
}))]
pub struct BuildBattleStats {
    /// Events this build version was signed up for that produced at least one battle.
    pub events: i64,
    /// Battles across those events.
    pub battles: i64,
    /// Signed-up players found by name in a battle snapshot. The sample size behind every other
    /// number here.
    pub matched_players: i64,
    /// Battles the guild won, of those the build appeared in.
    pub wins: i64,
    /// Battles the guild lost, of those the build appeared in.
    pub losses: i64,
    /// Kills by the players running this build.
    pub kills: i64,
    /// Deaths of the players running this build.
    pub deaths: i64,
    /// Kill fame earned by the players running this build.
    pub kill_fame: i64,
    /// Death fame given away by the players running this build.
    pub death_fame: i64,
}

/// How one build version has performed, with the coverage caveats stated rather than hidden.
///
/// `stats` is `None` — not a row of zeros — when the version has no battle data, so "never used"
/// stays distinguishable from "used and lost every time".
#[derive(Debug, Clone, Serialize, ToSchema)]
#[schema(example = json!({
    "build_id": 12,
    "build_name": "Pole Hammer",
    "version": 2,
    "signups_as_primary": 84,
    "signups_as_secondary": 12,
    "players_without_an_albion_link": 7,
    "stats": null
}))]
pub struct BuildPerformanceView {
    /// The build version these numbers describe.
    pub build_id: i64,
    /// The build's name, shared by every version in its group.
    pub build_name: String,
    /// Version number within the `(name, category)` group.
    pub version: i32,
    /// Sign-ups that named this build as the primary.
    pub signups_as_primary: i64,
    /// Sign-ups that named this build as the secondary.
    pub signups_as_secondary: i64,
    /// Signed-up players with no linked Albion account. They cannot be found in a battle snapshot,
    /// so they are excluded from `stats` — surfaced here so a thin sample is visibly thin.
    pub players_without_an_albion_link: i64,
    /// `None` when no battle data exists for this version.
    pub stats: Option<BuildBattleStats>,
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
    /// Discord role IDs mentioned by this event's announcement, in stable order.
    pub discord_role_ids: Vec<String>,
    /// Whether this event enables automatic and manual regear processing.
    pub regear: bool,
    /// The base composition ID associated with the event.
    #[schema(example = 10)]
    pub comp_id: i64,
    /// The name of the base composition.
    pub comp_name: String,
    /// Optional signup threshold that advances through comp expansions without blocking signups.
    pub player_cap: Option<i64>,
    /// The ID of the user who created this event.
    #[schema(example = 1)]
    pub created_by: i64,
    /// The username of the user who created this event.
    pub created_by_username: String,
    /// Compatibility alias for `start_time_utc`.
    pub event_date_utc: String,
    /// The mass announcement time in UTC.
    pub mass_time_utc: String,
    /// The automatic event start time in UTC.
    pub start_time_utc: String,
    /// The timestamp when the event was created.
    pub created_at: String,
    /// The timestamp when the event was last updated.
    pub updated_at: String,
    /// Session status: `scheduled` | `live` | `stopped` | `auto_stopped` | `cancelled`.
    pub status: String,
    /// When the session went live (RFC3339), if ever.
    pub started_at: Option<String>,
    /// When the session was stopped (RFC3339), if ever.
    pub stopped_at: Option<String>,
    /// Hard deadline (RFC3339) after which the session auto-stops.
    pub auto_stop_deadline: Option<String>,
    /// Discord voice channel created for this live event, if any.
    pub discord_voice_channel_id: Option<String>,
    /// Linker status: `pending` | `in_progress` | `completed` | `failed`.
    pub link_status: String,
    /// Number of AlbionBB fetch attempts performed by the linker.
    pub link_attempts: i64,
    /// Last error message recorded by the linker, if any.
    pub link_last_error: Option<String>,
    /// When battle linking was definitively concluded (RFC3339), if ever.
    pub link_battles_completed_at: Option<String>,
    /// When this event was archived. `None` means it is listed as active.
    pub archived_at: Option<String>,
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
    /// The primary build ID chosen by the participant, or `None` for the unlimited `Fill` role.
    #[schema(example = 5)]
    pub primary_build_id: Option<i64>,
    /// The name of the primary build, or `Fill` for the virtual assignment.
    pub primary_build_name: String,
    /// The optional secondary build ID.
    #[schema(example = 7)]
    pub secondary_build_id: Option<i64>,
    /// The name of the secondary build (if any).
    pub secondary_build_name: Option<String>,
    /// Combat specialization levels keyed by `weapon:<id>` or `armor:<id>`.
    pub specializations: std::collections::HashMap<String, i32>,
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

/// One canonical real-world fight, composed of one or more AlbionBB battle segments.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventFightView {
    /// Canonical Fight database ID.
    pub id: i64,
    /// When the first segment began (RFC3339).
    pub started_at: String,
    /// When the latest known segment ended, if supplied by AlbionBB.
    pub ended_at: Option<String>,
    /// `seeded`, `automatic`, or later `manual` grouping provenance.
    pub grouping_method: String,
    /// Evidence score used by automatic grouping.
    pub grouping_confidence: f64,
    /// Whether this grouping needs officer review.
    pub needs_review: bool,
    /// Technical AlbionBB battle IDs that make up this Fight, in sequence.
    pub battle_ids: Vec<String>,
}

/// A role available on an event roster.
///
/// The first entry is always the virtual `Fill` role. It has no database ID or
/// build and represents unlimited-capacity flexible assignments.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventRosterRoleView {
    /// Persisted role ID. `None` for the virtual `Fill` role.
    #[schema(example = 42)]
    pub id: Option<i64>,
    /// Build ID assigned to this extra role. `None` for `Fill`.
    #[schema(example = 5)]
    pub build_id: Option<i64>,
    /// Display name of the role or build.
    #[schema(example = "Fill")]
    pub name: String,
    /// Whether this is the automatic unlimited-capacity Fill role.
    pub is_fill: bool,
}

/// A concrete build available for the next event signup.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventCompBuildView {
    /// Build identifier in the active comp snapshot.
    pub build_id: i64,
    /// Human-readable build name.
    pub name: String,
    /// Number of slots this build contributes to the active comp.
    pub quantity: i32,
}

/// A concrete build selectable while joining an event.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventSignupBuildView {
    /// Build identifier submitted to `POST /api/events/{id}/participate`.
    pub build_id: i64,
    /// Human-readable build name.
    pub name: String,
    /// Role category used by the Discord role-selection menu.
    pub role: BuildRole,
    /// Available slots from the prospective comp snapshot plus extra event roster slots.
    pub quantity: i32,
}

/// The server-authoritative choices presented to a member before they select a concrete build.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventSignupOptionsView {
    /// The comp tier that would be active for a new concrete signup by this member.
    pub active_comp_id: i64,
    /// Human-readable name of the prospective comp tier.
    pub active_comp_name: String,
    /// Concrete build capacity of the prospective comp tier.
    pub active_comp_capacity: i64,
    /// Whether the requesting member is already on the roster and therefore does not increment
    /// the prospective threshold merely by opening the menu.
    pub is_already_registered: bool,
    /// Concrete builds available to select, including event-specific extra roster slots.
    pub builds: Vec<EventSignupBuildView>,
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
    /// Available roster roles. `Fill` is always first and has unlimited capacity.
    pub roster_roles: Vec<EventRosterRoleView>,
    /// Every build and quantity in the active comp snapshot, including empty slots.
    pub comp_builds: Vec<EventCompBuildView>,
    /// The list of registered participants.
    pub participants: Vec<EventParticipantView>,
    /// Canonical fights linked to this event. Each contains one or more raw Battle segments.
    pub fights: Vec<EventFightView>,
    /// Raw Battle segments retained for compatibility and traceability.
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

/// A persisted event roster snapshot.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventRosterView {
    pub event_id: i64,
    pub roster_version: i64,
    pub active_comp_id: i64,
    pub seats: Vec<EventRosterSeatView>,
    pub bench: Vec<EventParticipantView>,
}

/// A canonical seat in the active composition.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct EventRosterSeatView {
    pub key: String,
    pub party_number: i32,
    pub position: i32,
    pub build_id: i64,
    pub build_name: String,
    pub build_version: i32,
    pub role: String,
    pub participant: Option<EventParticipantView>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AssignRosterSeatRequest {
    pub user_id: i64,
    pub expected_roster_version: i64,
}
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RosterVersionRequest {
    pub expected_roster_version: i64,
}
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SwapRosterSeatsRequest {
    pub source_seat_key: String,
    pub target_seat_key: String,
    pub expected_roster_version: i64,
}

/// Request body to add an existing build as an extra roster role for an event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({ "build_id": 5 }))]
pub struct CreateEventRosterRoleRequest {
    /// Existing build to make available as an event-specific roster role.
    #[schema(example = 5)]
    pub build_id: i64,
}

/// Request body to create a new event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "title": "ZvZ Castle Fight",
    "description": "Weekly Castle Fight. Be on time!",
    "call_to_arms": false,
    "comp_id": 1,
    "mass_time_utc": "2026-07-20T19:30:00Z",
    "start_time_utc": "2026-07-20T20:00:00Z"
}))]
pub struct CreateEventRequest {
    /// The title of the event.
    pub title: String,
    /// An optional description of the event.
    pub description: Option<String>,
    /// Whether this event is a priority call-to-arms announcement (default: false).
    #[serde(default)]
    pub call_to_arms: bool,
    /// Whether this event enables automatic and manual regear processing.
    #[serde(default)]
    pub regear: bool,
    /// The base composition ID to use.
    pub comp_id: i64,
    /// Optional participant threshold that preemptively advances to the next comp expansion.
    /// It is a planning value, never a hard signup limit.
    #[serde(default)]
    pub player_cap: Option<i64>,
    /// Compatibility start date/time alias. Used when the new timestamps are omitted.
    #[serde(default)]
    pub event_date_utc: Option<String>,
    /// The mass announcement date/time (UTC, RFC3339).
    #[serde(default)]
    pub mass_time_utc: Option<String>,
    /// The automatic start date/time (UTC, RFC3339).
    #[serde(default)]
    pub start_time_utc: Option<String>,
    /// Discord role snowflakes to mention in the event announcement.
    #[serde(default)]
    pub discord_role_ids: Vec<String>,
    /// Also create an empty loot split already linked to this event.
    ///
    /// Saves the officer from creating the split by hand after the fight and
    /// remembering to attach it. The split starts at zero with no participants;
    /// its roster fills from the event's sign-ups when it is next updated, so
    /// creating it up front costs nothing if the fight never happens.
    #[serde(default)]
    pub create_split: bool,
    /// Island tab for the correlated split. Required when `create_split` is true.
    #[schema(example = 10)]
    pub island_tab_id: Option<i64>,
}

/// Discord voice channel created by the bot for a live event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetEventVoiceChannelRequest {
    /// Discord channel snowflake.
    pub channel_id: String,
}

/// Request body to update an existing event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "title": "ZvZ Castle Fight (Updated Time)",
    "mass_time_utc": "2026-07-20T20:00:00Z",
    "start_time_utc": "2026-07-20T20:30:00Z"
}))]
pub struct UpdateEventRequest {
    /// The new title of the event.
    pub title: Option<String>,
    /// The new description of the event.
    pub description: Option<String>,
    /// Whether this event should be treated as a call-to-arms announcement.
    pub call_to_arms: Option<bool>,
    /// Whether this event enables automatic and manual regear processing.
    pub regear: Option<bool>,
    /// The new base composition ID.
    pub comp_id: Option<i64>,
    /// Compatibility start date/time alias.
    pub event_date_utc: Option<String>,
    /// The new mass announcement date/time (UTC, RFC3339).
    pub mass_time_utc: Option<String>,
    /// The new automatic start date/time (UTC, RFC3339).
    pub start_time_utc: Option<String>,
}

/// Request body to participate in an event or update participation builds.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "primary_build_id": 5,
    "secondary_build_id": 7
}))]
pub struct ParticipateEventRequest {
    /// The primary build ID chosen (must have a slot in the active comp or an extra roster role),
    /// or `None` for the unlimited virtual `Fill` role.
    pub primary_build_id: Option<i64>,
    /// The optional backup/secondary build ID (must be in the active comp or extra roster roles).
    pub secondary_build_id: Option<i64>,
}

/// Request body used by event creators / officers with `events.edit` to add
/// an arbitrary guild member to an event.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "user_id": 42,
    "primary_build_id": 5,
    "secondary_build_id": 7
}))]
pub struct AddEventMemberRequest {
    /// Internal database ID of the member to add.
    pub user_id: i64,
    /// The primary build ID to assign (must have a slot in the active comp or an extra roster
    /// role), or `None` for the unlimited virtual `Fill` role.
    pub primary_build_id: Option<i64>,
    /// The optional backup/secondary build ID to assign (must be in the active comp or extra roster roles).
    pub secondary_build_id: Option<i64>,
}

/// Request body used by event creators / officers with `events.edit` to
/// forcibly set the build assignment of an arbitrary guild member.
///
/// Mirrors [`ParticipateEventRequest`] but is intended for the
/// `PUT /api/events/{id}/participants/{user_id}` compatibility route, so the
/// target user is picked from the URL instead of the session.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "primary_build_id": 5,
    "secondary_build_id": 7
}))]
pub struct SetParticipantRequest {
    /// The primary build ID to assign (must have a slot in the active comp or an extra roster
    /// role), or `None` for the unlimited virtual `Fill` role.
    pub primary_build_id: Option<i64>,
    /// The optional backup/secondary build ID to assign (must be in the active comp or extra roster roles).
    pub secondary_build_id: Option<i64>,
}
