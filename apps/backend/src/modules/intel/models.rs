//! Request and response types for the intel module.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::modules::intel::matchups::{MatchupCoverage, MatchupRow};
use crate::modules::intel::scout::ScoutedPlayer;

/// Summary of a scouted enemy composition, for list views.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScoutedCompSummary {
    /// Scout id.
    pub id: i64,
    /// Display name.
    pub name: String,
    /// Opponent guild id, when known.
    pub opponent_guild_id: Option<String>,
    /// Opponent guild name.
    pub opponent_guild_name: String,
    /// Opponent alliance name, when known.
    pub opponent_alliance_name: Option<String>,
    /// Engagement bracket: `gank`, `small_scale` or `zvz`.
    pub category: String,
    /// Enemy players observed.
    pub player_count: i32,
    /// How many of them contributed a main-hand weapon.
    ///
    /// Lower than `player_count` whenever the kill feed covered only part of
    /// the enemy force. Present it alongside any similarity score so readers
    /// know how much of the comp the score actually saw.
    pub weapon_sample_size: i32,
    /// Whether every observed player contributed a weapon.
    pub full_weapon_coverage: bool,
    /// Mean item power.
    pub avg_ip: f64,
    /// Role histogram.
    pub roles: BTreeMap<String, i64>,
    /// Weapon histogram.
    pub weapons: BTreeMap<String, i64>,
    /// Battles this scout was observed in.
    pub source_battle_count: i32,
    /// `losses * 2 + player_count`.
    pub threat_score: i32,
    /// Whether the scout is archived.
    pub is_archived: bool,
    /// Officer notes.
    pub notes: Option<String>,
    /// Earliest observation, RFC 3339.
    pub first_seen_at: String,
    /// Most recent observation, RFC 3339.
    pub saved_at: String,
}

/// Full dossier for one scouted composition.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScoutedCompDetail {
    /// The summary fields.
    #[serde(flatten)]
    pub summary: ScoutedCompSummary,
    /// The observed enemy roster.
    pub players: Vec<ScoutedPlayer>,
    /// Battle ids this scout was built from.
    pub source_battle_ids: Vec<i64>,
    /// Canonical dedupe key.
    pub fingerprint: String,
    /// Win/loss record of our comps against this scout.
    pub matchups: Vec<MatchupRow>,
    /// How much of the underlying battle data could be attributed to a comp.
    pub matchup_coverage: MatchupCoverage,
    /// The comp with the best proven record against this scout, if any.
    ///
    /// `None` means we have never fought this opponent with a comp we can
    /// identify — the threat board should say "untested", not "no counter".
    pub recommended_counter: Option<CounterSuggestion>,
}

/// One scored comparison against another composition.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SimilarityHit {
    /// The compared entity's id.
    pub id: i64,
    /// The compared entity's name.
    pub name: String,
    /// Blended similarity, 0-100.
    pub score: i32,
    /// Whether both sides had full weapon coverage.
    ///
    /// When false the weapon half of the score was computed from a sample, so
    /// the number understates how alike the comps may actually be.
    pub full_weapon_coverage: bool,
}

/// A recommended counter to a scouted composition.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CounterSuggestion {
    /// Our comp id.
    pub comp_id: i64,
    /// Our comp name.
    pub comp_name: String,
    /// How closely our comp resembles the scout, 0-100.
    pub similarity: i32,
    /// Battles fought with this comp against this scout.
    pub battles: i64,
    /// Battles won.
    pub wins: i64,
    /// Battles lost.
    pub losses: i64,
    /// Win percentage, 0-100. Zero when untested.
    pub win_rate: f64,
    /// Whether we have actually fought this pairing.
    pub tested: bool,
}

/// The result of scouting a battle, before or after persistence.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScoutOutcome {
    /// Scout id, absent for a dry run.
    pub scouted_comp_id: Option<i64>,
    /// Suggested or stored name.
    pub name: String,
    /// Opponent guild name.
    pub opponent_guild_name: String,
    /// Engagement bracket.
    pub category: String,
    /// Enemy players observed.
    pub player_count: i64,
    /// How many contributed a weapon.
    pub weapon_sample_size: i64,
    /// Whether this merged into an existing scout rather than creating one.
    pub merged: bool,
    /// Whether the battle was already linked to this scout.
    pub already_linked: bool,
}

/// Filters for `GET /api/intel/scouts`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema, IntoParams)]
pub struct ScoutFilters {
    /// Free-text match on scout name or opponent guild name.
    pub q: Option<String>,
    /// Restrict to one engagement bracket.
    pub category: Option<String>,
    /// Restrict to one opponent guild id.
    pub guild_id: Option<String>,
    /// Include archived scouts. Defaults to false.
    #[serde(
        default,
        deserialize_with = "crate::serde_helpers::optional_bool_from_string_or_bool"
    )]
    pub include_archived: Option<bool>,
    /// Sort key: `saved_at` (default), `threat`, or `battles`.
    pub sort: Option<String>,
}

/// Body of `PATCH /api/intel/scouts/{id}`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateScoutRequest {
    /// New display name.
    pub name: Option<String>,
    /// New officer notes.
    pub notes: Option<String>,
    /// New engagement bracket.
    pub category: Option<String>,
    /// Archive or restore the scout.
    pub is_archived: Option<bool>,
}

/// Body of `POST /api/intel/scouts/{id}/merge`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct MergeScoutRequest {
    /// The scout to fold into this one. It is deleted on success.
    pub source_scout_id: i64,
}
