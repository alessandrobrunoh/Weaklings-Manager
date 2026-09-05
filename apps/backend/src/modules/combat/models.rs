//! Request and response types for the combat module.

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::data_types::DatasetVersion;
use super::ip::CharacterIpBreakdown;
use crate::modules::comps::status::BuildSlot;

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

/// Every equippable base identifier that has a family mastery node, and which node it is.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[schema(example = json!({ "dataset_version": {}, "groups": { "2H_POLEHAMMER": "COMBAT_HAMMERS" } }))]
pub struct MasteryGroupsView {
    /// Provenance stamp, so a client can tell when the mapping last changed.
    pub dataset_version: DatasetVersion,
    /// `base_identifier -> mastery_node_id`.
    pub groups: std::collections::BTreeMap<String, String>,
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

/// Where the Destiny Board levels behind an Item Power figure come from.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpecSource {
    /// Whatever the member has actually trained. Requires a `user_id`.
    #[default]
    Current,
    /// Every node at 100 — the ceiling, for "what would this be worth fully specialised".
    Max,
    /// Every node at one flat level, for comparing builds rather than people.
    Fixed,
}

/// Ad-hoc Item Power request: a loadout plus whose specialization to score it with.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "items": [{ "slot": "weapon", "identifier": "T8_2H_POLEHAMMER", "enchantment": 2, "quality": 4 }],
    "spec": "max"
}))]
pub struct ItemPowerRequest {
    /// The equipped items. Slots outside the counted six are ignored.
    pub items: Vec<LoadoutItemRequest>,
    /// Which specialization levels to apply. Defaults to `current`.
    #[serde(default)]
    pub spec: SpecSource,
    /// The member whose levels to read, required when `spec` is `current`.
    #[serde(default)]
    pub user_id: Option<i64>,
    /// The flat level to apply, required when `spec` is `fixed`.
    #[serde(default)]
    pub level: Option<i32>,
}

/// Query parameters for the Item Power of a stored build.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct BuildItemPowerParams {
    /// Score the build with this member's Destiny Board levels.
    #[serde(default)]
    pub user_id: Option<i64>,
    /// Which levels to apply: `current`, `max` or `fixed`. Defaults to `current`.
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
    /// The same loadout with every Destiny Board node at 100 — what the member is working toward.
    pub at_max_spec: f64,
    /// How far along that road they are, `0.0` through `1.0`.
    ///
    /// Comparable across builds in a way raw Item Power is not: a plate tank always out-numbers a
    /// cloth healer without that saying anything about how ready either of them is.
    pub readiness: f64,
    /// Provenance of the numbers.
    pub dataset_version: DatasetVersion,
}

/// One member's Item Power on a given build.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberItemPowerView {
    /// Internal user id.
    pub user_id: i64,
    /// Display name, resolved the same way the rest of the app resolves it.
    pub username: String,
    /// Item Power with the levels this member has actually trained.
    pub item_power: f64,
    /// Item Power the same member would have with every node at 100.
    pub at_max_spec: f64,
    /// `item_power / at_max_spec`, `0.0` through `1.0`.
    pub readiness: f64,
    /// Nodes this build needs where the member is furthest from the ceiling, worst first.
    pub blocking_nodes: Vec<BlockingNode>,
    /// False when no family mastery level is recorded, making the figure a lower bound.
    pub mastery_levels_known: bool,
}

/// A Destiny Board node holding a member back on a build.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BlockingNode {
    /// The node id, e.g. `COMBAT_HAMMERS_POLE`.
    pub node: String,
    /// The member's level in it.
    pub level: i32,
    /// The level it can reach.
    pub max_level: i32,
    /// Item Power the member would gain by taking it to the ceiling.
    pub item_power_gap: f64,
}

/// Every member scored against one build, best first.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BuildRosterFitView {
    /// The build that was scored.
    pub build_id: i64,
    /// Its name, for a caller rendering this on its own.
    pub build_name: String,
    /// Item Power of the build with every node at 100 — the shared ceiling.
    pub at_max_spec: f64,
    /// One row per member with any recorded specialization, sorted by Item Power descending.
    pub members: Vec<MemberItemPowerView>,
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
