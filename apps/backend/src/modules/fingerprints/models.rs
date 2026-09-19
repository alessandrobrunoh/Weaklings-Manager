//! Request/response DTOs for the equipment fingerprint read API.
//!
//! `loadout_fingerprints` carries no observation-count rollup (see
//! `entities.rs`'s module doc), so every rollup field here (`observations`,
//! `friendly_observations`, `enemy_observations`) is computed by
//! `service.rs` at read time from `battle_loadout_observations`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Observation tallies shared by every view that surfaces a fingerprint's
/// (or a build's) usage, computed from `battle_loadout_observations`.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct FingerprintRollup {
    /// Total `battle_loadout_observations` rows, both sides combined.
    pub observations: i64,
    /// Rows with `is_friendly = true`.
    pub friendly_observations: i64,
    /// Rows with `is_friendly = false`.
    pub enemy_observations: i64,
}

/// One row of `GET /api/fingerprints`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FingerprintSummary {
    /// Surrogate primary key.
    pub id: i64,
    /// Canonical `"slot:base_item_id"` string this identity was built from.
    pub fingerprint: String,
    /// `"full"` (complete death equipment) or `"weapon_only"` (main-hand only).
    pub mode: String,
    /// The normalized base weapon item id.
    pub main_hand_base_item_id: String,
    /// Combat role classified from the weapon, when known.
    pub primary_role: Option<String>,
    /// The internal build matched at creation time, when any.
    pub matched_build_id: Option<i64>,
    /// That build's name, joined from `comps::builds`, when `matched_build_id` is `Some`
    /// and the build still exists (it may have been deleted since the match was made).
    pub matched_build_name: Option<String>,
    /// Which of the matched build's loadouts matched: `"main"` or `"swap"`.
    pub matched_build_loadout: Option<String>,
    /// `"matched"`, `"ambiguous"`, or `"unmatched"`.
    pub match_status: String,
    /// RFC 3339. When this fingerprint was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this fingerprint was most recently observed.
    pub last_seen_at: String,
    /// Observation tallies for this fingerprint, computed from `battle_loadout_observations`.
    #[serde(flatten)]
    pub rollup: FingerprintRollup,
}

/// One row of a [`FingerprintDetail`]'s observation history.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FingerprintObservationEntry {
    /// Canonical `AlbionBB` battle id.
    pub battle_id: i64,
    /// Opaque identity key of the player observed wearing this fingerprint.
    pub player_key: String,
    /// Whether this observation was of one of our own players (`true`) or an enemy (`false`).
    pub is_friendly: bool,
    /// RFC 3339. The battle's own time.
    pub occurred_at: String,
}

/// Full detail view for `GET /api/fingerprints/{id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FingerprintDetail {
    /// Surrogate primary key.
    pub id: i64,
    /// Canonical `"slot:base_item_id"` string this identity was built from.
    pub fingerprint: String,
    /// `"full"` (complete death equipment) or `"weapon_only"` (main-hand only).
    pub mode: String,
    /// The normalized base weapon item id.
    pub main_hand_base_item_id: String,
    /// Combat role classified from the weapon, when known.
    pub primary_role: Option<String>,
    /// The internal build matched at creation time, when any.
    pub matched_build_id: Option<i64>,
    /// That build's name, joined from `comps::builds`, when `matched_build_id` is `Some`
    /// and the build still exists (it may have been deleted since the match was made).
    pub matched_build_name: Option<String>,
    /// Which of the matched build's loadouts matched: `"main"` or `"swap"`.
    pub matched_build_loadout: Option<String>,
    /// `"matched"`, `"ambiguous"`, or `"unmatched"`.
    pub match_status: String,
    /// RFC 3339. When this fingerprint was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this fingerprint was most recently observed.
    pub last_seen_at: String,
    /// The full slot -> base item id map this fingerprint was derived from, parsed
    /// from `slots_json`.
    pub slots: BTreeMap<String, String>,
    /// Observation tallies across the whole history below.
    #[serde(flatten)]
    pub rollup: FingerprintRollup,
    /// Full observation history for this fingerprint, newest first.
    pub observations: Vec<FingerprintObservationEntry>,
}

/// A build's observed usage, for `GET /api/fingerprints/builds/{build_id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BuildObservationSummary {
    /// The internal build id this summary is for.
    pub build_id: i64,
    /// That build's name.
    pub build_name: String,
    /// Number of distinct `loadout_fingerprints` rows matched to this build.
    pub fingerprints_matched: i64,
    /// Observation tallies aggregated across every fingerprint matched to this build.
    #[serde(flatten)]
    pub rollup: FingerprintRollup,
    /// Every fingerprint id matched to this build.
    pub matched_fingerprint_ids: Vec<i64>,
}

/// One row of `GET /api/fingerprints/meta`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MetaEntry {
    /// The fingerprint this meta entry is for.
    pub fingerprint_id: i64,
    /// Canonical `"slot:base_item_id"` string this identity was built from.
    pub fingerprint: String,
    /// The normalized base weapon item id.
    pub main_hand_base_item_id: String,
    /// Combat role classified from the weapon, when known.
    pub primary_role: Option<String>,
    /// The matched build's name, when this fingerprint matched one and it still exists.
    pub matched_build_name: Option<String>,
    /// Observation count scoped to whichever `side` was requested.
    pub observations: i64,
    /// RFC 3339. When this fingerprint was most recently observed (either side).
    pub last_seen_at: String,
}

/// Query parameters for `GET /api/fingerprints`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct ListFingerprintsQuery {
    /// 1-indexed page number. Defaults to 1.
    pub page: Option<u64>,
    /// Page size. Defaults to 10.
    pub limit: Option<u64>,
    /// Restrict to fingerprints with this exact `mode` (`"full"` or `"weapon_only"`).
    pub mode: Option<String>,
    /// Restrict to fingerprints with this exact `primary_role`.
    pub role: Option<String>,
    /// Restrict to fingerprints with this exact `match_status`.
    pub match_status: Option<String>,
    /// Sort column: `last_seen_at` (default) or `main_hand_base_item_id`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
}

/// Query parameters for `GET /api/fingerprints/meta`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct MetaQuery {
    /// `"friendly"` or `"enemy"`. Defaults to `"enemy"` — the primary "what's the
    /// enemy meta" use case. Anything else is a validation error.
    pub side: Option<String>,
    /// Maximum number of entries to return. Defaults to 20, capped at 100.
    pub limit: Option<u64>,
}

impl MetaQuery {
    /// Normalized page limit: defaults to 20, capped at 100.
    #[must_use]
    pub fn limit(&self) -> u64 {
        self.limit.unwrap_or(20).clamp(1, 100)
    }
}
