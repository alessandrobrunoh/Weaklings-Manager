//! Request and response types for the combat module.

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::ip::CharacterIpBreakdown;
use backend_entities::status::comps::BuildSlot;
use backend_gamedata::data_types::DatasetVersion;

/// What the bundled dataset contains, and where it came from.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[schema(example = json!({
    "dataset_version": { "source": "ao-data/ao-bin-dumps", "dumps_commit": "0f3b1c9d…" },
    "items": 286,
    "spells": 1380,
    "destiny_nodes": 267
}))]
pub struct CombatDatasetView {
    /// Provenance stamp echoed on every combat response.
    pub dataset_version: DatasetVersion,
    /// Equippable base identifiers the dataset covers.
    pub items: usize,
    /// Spells reachable from those items.
    pub spells: usize,
    /// Destiny Board nodes that grant Item Power.
    pub destiny_nodes: usize,
}

/// One item in an ad-hoc loadout, as a caller describes it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "slot": "weapon",
    "identifier": "T8_2H_POLEHAMMER",
    "enchantment": 2,
    "quality": 4
}))]
pub struct LoadoutItemRequest {
    /// Which equipment slot the item occupies.
    pub slot: BuildSlot,
    /// Any form of the Albion identifier: `T8_2H_POLEHAMMER`, `2H_POLEHAMMER@2` or the bare base.
    pub identifier: String,
    /// Tier 4 through 8. Taken from `identifier` when omitted, defaulting to 8.
    #[serde(default)]
    pub tier: Option<u8>,
    /// Enchantment 0 through 4. Defaults to plain.
    #[serde(default)]
    pub enchantment: Option<u8>,
    /// Quality 1 through 5. Defaults to Excellent, the guild's standard grade.
    #[serde(default)]
    pub quality: Option<i16>,
}

/// Which hypothetical Destiny Board levels an Item Power figure is computed with.
///
/// Members' own levels are not stored, so the calculator always works with an assumed level.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpecSource {
    /// Every node at 100 — the ceiling, for "what would this be worth fully specialised".
    #[default]
    Max,
    /// Every node at one flat level, for comparing builds rather than people.
    Fixed,
}

/// Ad-hoc Item Power request: a loadout plus the hypothetical specialization to score it with.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "items": [{ "slot": "weapon", "identifier": "T8_2H_POLEHAMMER", "enchantment": 2, "quality": 4 }],
    "spec": "max"
}))]
pub struct ItemPowerRequest {
    /// The equipped items. Slots outside the counted six are ignored.
    pub items: Vec<LoadoutItemRequest>,
    /// Which specialization levels to apply. Defaults to `max`.
    #[serde(default)]
    pub spec: SpecSource,
    /// The flat level to apply, required when `spec` is `fixed`.
    #[serde(default)]
    pub level: Option<i32>,
}

/// Query parameters for the Item Power of a stored build.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct BuildItemPowerParams {
    /// Which levels to apply: `max` or `fixed`. Defaults to `max`.
    #[serde(default)]
    pub spec: Option<SpecSource>,
    /// The flat level for `spec=fixed`.
    #[serde(default)]
    pub level: Option<i32>,
    /// Which loadout to score: `main` or `swap`. Defaults to `main`.
    #[serde(default)]
    pub loadout: Option<String>,
}

/// An Item Power figure, with the loadout it was computed from and the ceiling it is measured
/// against.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ItemPowerView {
    /// The itemised figure.
    pub breakdown: CharacterIpBreakdown,
    /// The same loadout with every Destiny Board node at 100 — the ceiling.
    pub at_max_spec: f64,
    /// `breakdown.average / at_max_spec`, `0.0` through `1.0`: how close the assumed levels are to
    /// the ceiling.
    ///
    /// Comparable across builds in a way raw Item Power is not: a plate tank always out-numbers a
    /// cloth healer without that saying anything about how far either is from its ceiling.
    pub readiness: f64,
    /// Provenance of the numbers.
    pub dataset_version: DatasetVersion,
}

/// A burst window to resolve: the casts, and the side counts the zerg debuff needs.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "casts": [{ "caster_label": "Polehammer #1", "spell_id": "HAMMERWHIRLWIND2", "cast_at": 0.0,
                "target_count": 5, "concurrent_attackers": 0, "attacker_style": "melee",
                "prior_cc_stacks": 0 }],
    "sides": { "ally_count": 20, "enemy_count": 20 }
}))]
pub struct SimulateRequest {
    /// Every cast in the burst, in the order the caller wants them reported back.
    pub casts: Vec<super::sim::DeclaredCast>,
    /// Force sizes for the zerg debuff. Omitted counts default to `0`, i.e. no debuff.
    #[serde(default)]
    pub sides: super::sim::SideCounts,
}

/// A resolved burst, with the dataset it was computed against.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SimulateView {
    #[serde(flatten)]
    pub result: super::sim::BurstResult,
    /// Provenance of the numbers — and of the honesty ledger: which effects were and were not
    /// modelled at the time this was run.
    pub dataset_version: DatasetVersion,
}

/// A saved test's unit groups and timeline — the shape stored, verbatim, in `definition_json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ScenarioDefinition {
    pub groups: Vec<super::scenario::UnitGroup>,
    pub casts: Vec<super::scenario::DeclaredCast>,
}

/// Request body to create a combat test scenario.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateScenarioRequest {
    pub name: String,
    #[serde(default)]
    pub definition: ScenarioDefinition,
}

/// Request body to edit a scenario version in place.
///
/// A scenario is a scratch document an officer iterates on constantly — unlike a build or a comp,
/// every group and timeline tweak does not need its own version. [`Self::name`] renames every
/// version in the group at once, matching how a build/comp rename already works; use
/// `POST .../versions` when the point is to keep the current state around for comparison.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateScenarioRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub definition: Option<ScenarioDefinition>,
}

/// A scenario version, without its definition — for list views.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScenarioSummary {
    pub id: i64,
    pub name: String,
    pub version: i32,
    pub created_by: i64,
    pub created_by_username: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    /// How many times this version has been run.
    pub run_count: i64,
}

/// A single version reference, for [`ScenarioDetail::versions`].
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScenarioVersionRef {
    pub id: i64,
    pub version: i32,
}

/// The full scenario version, with its definition.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScenarioDetail {
    #[serde(flatten)]
    pub summary: ScenarioSummary,
    pub definition: ScenarioDefinition,
    /// Every version sharing this scenario's name, oldest first.
    pub versions: Vec<ScenarioVersionRef>,
}

/// One pinned run of a scenario version, for list views.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RunSummary {
    pub id: i64,
    pub scenario_id: i64,
    pub engine_version: i32,
    pub dataset_commit: String,
    pub ran_by: i64,
    pub ran_by_username: String,
    pub ran_at: String,
}

/// A pinned run, with its full resolved result.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RunDetail {
    #[serde(flatten)]
    pub summary: RunSummary,
    pub result: super::scenario::ScenarioResult,
}
