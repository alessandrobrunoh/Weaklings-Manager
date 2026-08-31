//! Request/response DTOs and view models for the regear module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over the
//! API and their `OpenAPI` schemas.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;

use crate::modules::comps::status::BuildSlot;

use super::entities::RegearDeathModel;
use super::status::RegearStatus;

/// Accepts boolean query params from both JSON booleans and URL strings.
///
/// Angular's `HttpParams` serializes booleans as `"true"`/`"false"`, while serde's default bool
/// deserializer expects a native boolean token. Keeping the coercion local to this field prevents
/// router-level query parsing from rejecting valid browser requests.
fn deserialize_optional_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalBoolVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalBoolVisitor {
        type Value = Option<bool>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a boolean or a string boolean")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(Some(value))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            match value.trim().to_ascii_lowercase().as_str() {
                "" => Ok(None),
                "true" | "1" | "yes" => Ok(Some(true)),
                "false" | "0" | "no" => Ok(Some(false)),
                other => Err(E::custom(format!("invalid boolean value: {other}"))),
            }
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(self)
        }
    }

    deserializer.deserialize_option(OptionalBoolVisitor)
}

/// One slot's pricing inside a regear breakdown. Stored as JSON in
/// `regear_deaths.auto_estimate_breakdown_json` and `final_breakdown_json`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BreakdownRow {
    /// Canonical equipment slot (e.g. `weapon`, `head`).
    pub slot: BuildSlot,
    /// Albion Online item id (e.g. `T8_MAIN_NATURESTAFF_KEEPER`).
    #[schema(example = "T8_MAIN_NATURESTAFF_KEEPER")]
    pub item_id: String,
    /// Item quality (1..=5). Defaults to 1 when the kill feed does not specify one.
    #[schema(example = 1)]
    pub quality: u8,
    /// Cheapest sell price found for this slot, in silver. `0` when no listing was available.
    #[schema(value_type = String, example = "980000")]
    pub unit_price: Decimal,
    /// Stack size lost (almost always `1` for gear; can be > 1 for consumables).
    #[schema(example = 1)]
    pub quantity: i32,
    /// Whether this slot contributes to the regear total. Officers can toggle it off.
    pub included: bool,
}

impl BreakdownRow {
    /// This row's contribution to the regear total (`unit_price * quantity` if included, else 0).
    #[must_use]
    pub fn contribution(&self) -> Decimal {
        if self.included {
            self.unit_price * Decimal::from(self.quantity)
        } else {
            Decimal::ZERO
        }
    }
}

/// A regear death row, as seen by a client.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct DeathView {
    /// The unique identifier of the death row.
    #[schema(example = 1)]
    pub id: i64,
    /// The CTA event id.
    pub event_id: i64,
    /// The event title (joined for display).
    pub event_title: String,
    /// The `event_battles` row id.
    pub event_battle_id: i64,
    /// AlbionBB battle id (for the `/battles/{id}` link).
    pub albionbb_battle_id: String,
    /// AlbionBB kill-event id.
    pub albion_kill_event_id: String,
    /// RFC3339 timestamp of the death.
    pub killed_at: String,
    /// Linked user id of the victim, or `None` if unlinked.
    pub user_id: Option<i64>,
    /// Albion in-game name of the victim.
    pub player_name: String,
    /// The build the victim signed up with for the event, if any.
    pub primary_build_id: Option<i64>,
    /// Name of the signed-up build, when available.
    pub primary_build_name: Option<String>,
    /// Frozen kill-feed `Equipment` JSON for the victim.
    pub loadout_json: serde_json::Value,
    /// Σ of cheapest-sell prices for included slots at extraction time.
    #[schema(value_type = String, example = "1840000")]
    pub auto_estimate_total: Decimal,
    /// The breakdown rows snapshotted at extraction time.
    pub auto_estimate_breakdown: Vec<BreakdownRow>,
    /// Workflow status.
    pub status: RegearStatus,
    /// When the user requested regear, if they have.
    pub requested_at: Option<String>,
    /// When an officer decided, if decided.
    pub decided_at: Option<String>,
    /// Officer who decided, by user id.
    pub decided_by_user_id: Option<i64>,
    /// Officer's accepted amount (after slot edits).
    #[schema(value_type = String, example = "1840000")]
    pub final_amount: Option<Decimal>,
    /// Officer's edited breakdown, if decided.
    pub final_breakdown: Option<Vec<BreakdownRow>>,
    /// Free-form officer note (mandatory on reject).
    pub officer_note: Option<String>,
    /// Bank transaction id credited on accept, for audit.
    pub bank_transaction_id: Option<i64>,
    /// Extraction time.
    pub created_at: String,
    /// Last mutation time.
    pub updated_at: String,
}

impl DeathView {
    /// Builds a view from a `SeaORM` model row plus the join-loaded display fields.
    ///
    /// `auto_estimate_breakdown` and `final_breakdown` are parsed leniently: malformed JSON
    /// degrades to an empty vec rather than failing the whole read, so a corrupt row never breaks
    /// the listing endpoint.
    #[allow(clippy::too_many_arguments)]
    pub fn from_model(
        model: RegearDeathModel,
        event_title: String,
        primary_build_name: Option<String>,
        status: RegearStatus,
    ) -> Self {
        let auto_estimate_breakdown =
            serde_json::from_str(&model.auto_estimate_breakdown_json).unwrap_or_default();
        let loadout_json = serde_json::from_str(&model.loadout_json).unwrap_or_default();
        let final_breakdown = model
            .final_breakdown_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok());

        Self {
            id: model.id,
            event_id: model.event_id,
            event_title,
            event_battle_id: model.event_battle_id,
            albionbb_battle_id: model.albionbb_battle_id,
            albion_kill_event_id: model.albion_kill_event_id,
            killed_at: model.killed_at.to_rfc3339(),
            user_id: model.user_id,
            player_name: model.player_name,
            primary_build_id: model.primary_build_id,
            primary_build_name,
            loadout_json,
            auto_estimate_total: model.auto_estimate_total,
            auto_estimate_breakdown,
            status,
            requested_at: model.requested_at.map(|dt| dt.to_rfc3339()),
            decided_at: model.decided_at.map(|dt| dt.to_rfc3339()),
            decided_by_user_id: model.decided_by_user_id,
            final_amount: model.final_amount,
            final_breakdown,
            officer_note: model.officer_note,
            bank_transaction_id: model.bank_transaction_id,
            created_at: model.created_at.to_rfc3339(),
            updated_at: model.updated_at.to_rfc3339(),
        }
    }
}

/// Guild-wide regear settings, as seen by the client.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RegearSettingsView {
    /// Max regears a user can request per CTA event.
    pub max_regears_per_event: i32,
    /// Max regears approved per user in a rolling 30-day window.
    pub max_regears_per_month: i32,
    /// Bitmask over `BuildSlot` deciding which slots are reimbursable.
    pub enabled_slots_mask: i32,
    /// Albion city whose market prices are used for estimates.
    pub pricing_location: String,
    /// `cheapest_any` (fallback across cities) or `strict`.
    pub pricing_fallback_strategy: String,
}

impl RegearSettingsView {
    /// Builds a view from the singleton model row.
    #[must_use]
    pub fn from_model(model: super::entities::RegearSettingModel) -> Self {
        Self {
            max_regears_per_event: model.max_regears_per_event,
            max_regears_per_month: model.max_regears_per_month,
            enabled_slots_mask: model.enabled_slots_mask,
            pricing_location: model.pricing_location,
            pricing_fallback_strategy: model.pricing_fallback_strategy,
        }
    }
}

/// Request body for `PUT /settings`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateRegearSettingsRequest {
    /// New value for `max_regears_per_event`. Must be >= 0.
    pub max_regears_per_event: Option<i32>,
    /// New value for `max_regears_per_month`. Must be >= 0.
    pub max_regears_per_month: Option<i32>,
    /// New bitmask for `enabled_slots_mask`.
    pub enabled_slots_mask: Option<i32>,
    /// New `pricing_location`.
    pub pricing_location: Option<String>,
    /// New `pricing_fallback_strategy` (`cheapest_any` or `strict`).
    pub pricing_fallback_strategy: Option<String>,
}

/// Request body for officer accept. If the body is omitted, the auto-estimate is used as-is.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AcceptRegearRequest {
    /// The total silver to credit. Must equal Σ of `unit_price * quantity` for included rows.
    #[schema(value_type = String, example = "1840000")]
    pub final_amount: Decimal,
    /// The full breakdown (officer may edit `unit_price` and `included` per slot).
    pub breakdown: Vec<BreakdownRow>,
    /// Optional officer note.
    pub note: Option<String>,
}

/// Request body for officer reject. The note is mandatory.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RejectRegearRequest {
    /// Why the request was rejected. 1..=500 chars.
    pub note: String,
}

/// Filters for listing deaths.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct DeathFilters {
    /// Filter by event id.
    pub event_id: Option<i64>,
    /// Filter by status.
    pub status: Option<RegearStatus>,
    /// Filter by user id (officers only for ids other than the caller's).
    pub user_id: Option<i64>,
    /// If `true`, return all deaths guild-wide (requires `regear.adjudicate`).
    #[serde(default, deserialize_with = "deserialize_optional_bool")]
    pub global: Option<bool>,
    /// Filter by bank transaction id (used by the bank UI to render regear credits).
    pub bank_transaction_id: Option<i64>,
    /// Case-insensitive substring match on `player_name`.
    pub search: Option<String>,
    /// Sort column. Allowed: `killed_at` (default), `status`, `player_name`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
    /// If `true` and `status` is omitted, only terminal (`approved` / `rejected`) deaths.
    #[serde(default, deserialize_with = "deserialize_optional_bool")]
    pub history: Option<bool>,
}

/// Per-user budget usage returned by `GET /me/summary`.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RegearBudgetSummary {
    /// Number of deaths the caller has requested or had approved for the most recent CTA event.
    pub per_event_used: i32,
    /// Configured per-event cap.
    pub per_event_max: i32,
    /// Number of approvals for the caller in the last 30 days.
    pub per_month_used: i32,
    /// Configured per-month cap.
    pub per_month_max: i32,
}

/// Result of an extraction run.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct ExtractionReport {
    /// Event id the extraction ran for.
    pub event_id: i64,
    /// Number of `event_battles` rows scanned.
    pub battles_scanned: i64,
    /// Number of new death rows inserted.
    pub deaths_inserted: i64,
    /// Number of pre-existing death rows skipped (idempotency).
    pub deaths_skipped: i64,
}
