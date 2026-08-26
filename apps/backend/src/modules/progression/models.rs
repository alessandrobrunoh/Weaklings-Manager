//! Request/response DTOs for the progression module.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::XpSource;

/// Public view of a season.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SeasonView {
    /// Season id.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// Inclusive start, RFC 3339.
    pub starts_at: String,
    /// Inclusive end, RFC 3339.
    pub ends_at: String,
    /// Whether this is the guild's current season flag.
    pub is_active: bool,
}

/// The caller's (or a target user's) season XP snapshot.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProgressionMeView {
    /// Active season covering `now`, if any.
    pub season: Option<SeasonView>,
    /// Current level in that season (1 when there is no account row).
    pub level: i32,
    /// Season XP.
    pub xp: i64,
    /// XP still needed for the next level (`0` at cap or with no season).
    pub xp_to_next: i64,
    /// Cumulative threshold of the next level (`0` at cap).
    pub next_level_at: i64,
    /// 1-based rank in the season by XP, `None` if no season.
    pub rank: Option<i64>,
    /// Live XP multiplier.
    #[schema(value_type = String, example = "1.0")]
    pub multiplier: Decimal,
    /// Sum of XP across every season this user has an account in.
    pub lifetime_xp: i64,
}

/// Input to [`super::service::ProgressionService::award`].
#[derive(Debug, Clone)]
pub struct AwardSpec {
    /// Who receives the XP.
    pub user_id: i64,
    /// Why.
    pub source: XpSource,
    /// Override the configured rate. `None` looks up the source's admin rate.
    pub base_amount: Option<i64>,
    /// Unique per season; repeats are no-ops.
    pub idempotency_key: String,
    /// Officer who forced the award, if any.
    pub actor_user_id: Option<i64>,
}

/// Result of an award attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwardOutcome {
    /// A new ledger row was written (applied XP may still be 0 because of remainder).
    Applied {
        /// Integer XP added to the account.
        applied: i64,
        /// Level after this award.
        level: i32,
        /// Season XP after this award.
        xp: i64,
    },
    /// Same `idempotency_key` was already recorded this season.
    Duplicate,
    /// No season is both flagged active and covering `now`.
    NoActiveSeason,
    /// The source's configured rate is 0 (or a non-positive override).
    SkippedRate,
}

/// One row of the admin curve preview table.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LevelThresholdView {
    /// Level number (2+; level 1 is always 0 XP).
    pub level: i32,
    /// Cumulative XP required to reach this level.
    pub xp: i64,
}

/// Guild-wide progression knobs plus a short curve preview.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProgressionSettingsView {
    /// `threshold(n) = round(xp_base * (n-1)^xp_exponent)`.
    pub xp_base: i32,
    /// Curve exponent.
    #[schema(value_type = String, example = "1.5")]
    pub xp_exponent: Decimal,
    /// Highest reachable level.
    pub max_level: i32,
    /// XP per eligible Discord message.
    pub xp_message: i32,
    /// XP for creating an event.
    pub xp_event_create: i32,
    /// XP for joining an event.
    pub xp_event_join: i32,
    /// XP for still being on the roster at event stop.
    pub xp_event_complete: i32,
    /// XP for a claimed VOD.
    pub xp_vod: i32,
    /// Minimum seconds between message awards for one user.
    pub message_cooldown_secs: i32,
    /// Minimum message length for message XP.
    pub message_min_chars: i32,
    /// Active-warn count that opens an admin escalation.
    pub warn_threshold: i32,
    /// Discord forum channel id for VOD threads.
    pub vod_forum_channel_id: Option<String>,
    /// Channel ids that never grant message XP.
    pub message_channel_deny_list: Vec<String>,
    /// First 20 (or `max_level`) thresholds for the admin preview table.
    pub level_preview: Vec<LevelThresholdView>,
}

/// Partial update of [`ProgressionSettingsView`]. Absent fields are left unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct UpdateProgressionSettingsRequest {
    /// New curve base. Must be > 0.
    pub xp_base: Option<i32>,
    /// New curve exponent. Must be ≥ 1.
    pub xp_exponent: Option<f64>,
    /// New cap. Must be ≥ 1.
    pub max_level: Option<i32>,
    /// Message XP rate. Must be ≥ 0.
    pub xp_message: Option<i32>,
    /// Event-create XP rate. Must be ≥ 0.
    pub xp_event_create: Option<i32>,
    /// Event-join XP rate. Must be ≥ 0.
    pub xp_event_join: Option<i32>,
    /// Event-complete XP rate. Must be ≥ 0.
    pub xp_event_complete: Option<i32>,
    /// VOD XP rate. Must be ≥ 0.
    pub xp_vod: Option<i32>,
    /// Message cooldown in seconds. Must be ≥ 0.
    pub message_cooldown_secs: Option<i32>,
    /// Minimum message length. Must be ≥ 0.
    pub message_min_chars: Option<i32>,
    /// Warn escalation threshold. Must be ≥ 1.
    pub warn_threshold: Option<i32>,
    /// Forum channel id. Empty string clears.
    pub vod_forum_channel_id: Option<String>,
    /// Replacement deny-list of channel ids.
    pub message_channel_deny_list: Option<Vec<String>>,
}

/// Body to open a new season.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateSeasonRequest {
    /// Display name.
    pub name: String,
    /// Inclusive start, RFC 3339.
    pub starts_at: String,
    /// Inclusive end, RFC 3339.
    pub ends_at: String,
    /// If true, this season becomes the only active one.
    pub activate: Option<bool>,
}

/// Partial update of a season's name or dates (lengthen / shorten).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct UpdateSeasonRequest {
    /// New display name.
    pub name: Option<String>,
    /// New start, RFC 3339.
    pub starts_at: Option<String>,
    /// New end, RFC 3339. Moving this is how a season is lengthened or shortened.
    pub ends_at: Option<String>,
}

/// Body of `POST /api/progression/award/message` (bot-only).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AwardMessageRequest {
    /// Discord snowflake of the message author.
    pub discord_id: String,
    /// Discord message id (idempotency key `msg:{message_id}`).
    pub message_id: String,
    /// Channel the message was posted in (deny-list check).
    pub channel_id: String,
    /// Character length of the message body.
    pub length: i32,
}

/// Result of a message XP attempt. Unlinked users are a silent no-op, not 401.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AwardMessageView {
    /// Whether a new ledger row was written.
    pub awarded: bool,
    /// Why the award was skipped, when `awarded` is false.
    pub reason: Option<String>,
}

/// One leaderboard row.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LeaderboardEntryView {
    /// 1-based rank in the season (XP desc, `user_id` asc).
    pub rank: i64,
    /// Member id.
    pub user_id: i64,
    /// Display name (Albion character if linked, else Discord username).
    pub username: String,
    /// Season XP.
    pub xp: i64,
    /// Denormalized level.
    pub level: i32,
}

/// One XP ledger row.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct XpLedgerEntryView {
    /// Row id.
    pub id: i64,
    /// Recipient.
    pub user_id: i64,
    /// Season of the award.
    pub season_id: i64,
    /// Source tag.
    pub source: String,
    /// Rate before the multiplier.
    pub base_amount: i64,
    /// After multiplier (may be negative for admin adjusts).
    pub applied_amount: i64,
    /// Multiplier snapshotted at write time.
    #[schema(value_type = String, example = "1.0")]
    pub multiplier_at_time: Decimal,
    /// Unique-per-season key.
    pub idempotency_key: String,
    /// Officer who forced an admin adjust, if any.
    pub actor_user_id: Option<i64>,
    /// Write time, RFC 3339.
    pub created_at: String,
}

/// Body of `POST /api/progression/users/{id}/adjust`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AdjustProgressionRequest {
    /// Replace season XP with this value (clamped ≥ 0).
    pub set_xp: Option<i64>,
    /// Add (or subtract) this many XP; result is clamped ≥ 0.
    pub add_xp: Option<i64>,
    /// Set XP to `threshold(level)` then recompute level.
    pub set_level: Option<i32>,
    /// Replace the live multiplier (clamped `[0, 5]`).
    pub set_multiplier: Option<f64>,
    /// RFC 3339 expiry for the multiplier. Cleared when omitted with `set_multiplier`.
    pub multiplier_expires_at: Option<String>,
    /// Required non-empty reason (audit + ledger).
    pub reason: String,
}
