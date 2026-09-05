//! Types for the bundled Albion combat dataset.
//!
//! Every field here mirrors a key emitted by `scripts/generate_albion_combat_data.py`. The
//! generator has already resolved the two ambiguities in the raw dumps — which progression row a
//! slot type uses, and which Destiny Board node an item belongs to — and has converted every value
//! out of the dump's all-strings encoding, so nothing in this module parses a game string or
//! guesses a mapping.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Which ao-bin-dumps commit the bundled dataset was generated from.
///
/// Echoed on every combat response so a saved result stays legible after an Albion patch shifts
/// the numbers underneath it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "source": "ao-data/ao-bin-dumps",
    "dumps_commit": "0f3b1c9d…",
    "dumps_committed_at": "2026-09-01T09:12:44Z",
    "generated_at": "2026-09-04T12:00:00+00:00",
    "generator_version": 1
}))]
pub struct DatasetVersion {
    /// The upstream repository the dumps came from.
    pub source: String,
    /// The dumps commit SHA, 40 hex characters.
    pub dumps_commit: String,
    /// When that commit was authored, RFC 3339.
    pub dumps_committed_at: String,
    /// When this dataset was generated, RFC 3339.
    pub generated_at: String,
    /// Bumped whenever the generator's output shape changes.
    pub generator_version: u32,
}

/// The combat stats an item contributes, before any Item Power scaling.
///
/// Measured across all 286 bases, these are identical for every tier of the same item: tier moves
/// Item Power and nothing else. They are therefore stored once per base, not once per tier.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ItemStats {
    /// Base ability power, the multiplier spell damage scales from.
    #[serde(default)]
    pub ability_power: Option<f64>,
    /// Auto-attack damage.
    #[serde(default)]
    pub attack_damage: Option<f64>,
    /// Auto-attacks per second.
    #[serde(default)]
    pub attack_speed: Option<f64>,
    /// Auto-attack reach in metres.
    #[serde(default)]
    pub attack_range: Option<f64>,
    /// Flat hit points added on top of the character's base 1200.
    #[serde(default)]
    pub hitpoints_max: Option<f64>,
    /// Flat energy added on top of the character's base 120.
    #[serde(default)]
    pub energy_max: Option<f64>,
    /// Physical armour, relative to the progression row's `armor_base`.
    #[serde(default)]
    pub physical_armor: Option<f64>,
    /// Magic resistance, relative to the progression row's `armor_base`.
    #[serde(default)]
    pub magic_resistance: Option<f64>,
    /// Crowd-control resistance, relative to the progression row's `ccr_base`.
    #[serde(default)]
    pub cc_resistance: Option<f64>,
    /// Flat movement speed contribution.
    #[serde(default)]
    pub move_speed: Option<f64>,
    /// Percentage-style modifiers, keyed by their dump name (`healbonus`, `threatbonus`, …).
    #[serde(default)]
    pub bonuses: BTreeMap<String, f64>,
}

/// One equippable base identifier, e.g. `2H_POLEHAMMER` or `ARMOR_PLATE_SET1`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CombatItem {
    /// Catalog branch: `weapon`, `armor` or `accessory`.
    #[serde(rename = "type")]
    pub item_type: String,
    /// The in-game slot, e.g. `mainhand`, `offhand`, `armor`, `head`, `shoes`, `cape`.
    #[serde(default)]
    pub slot_type: Option<String>,
    /// Whether equipping this occupies the off-hand as well.
    #[serde(default)]
    pub two_handed: bool,
    /// Key into [`CombatRules::item_power_progression`], already resolved by the generator.
    #[serde(default)]
    pub progression: Option<String>,
    /// The Destiny Board specialization node, or `None` for capes, bags and gathering gear —
    /// which genuinely have no combat specialization, and so gain no Item Power from mastery.
    #[serde(default)]
    pub spec_node: Option<String>,
    /// How many active ability slots the item offers.
    #[serde(default)]
    pub active_slots: u8,
    /// How many passive ability slots the item offers.
    #[serde(default)]
    pub passive_slots: u8,
    /// Stats shared by every tier of this base.
    pub stats: ItemStats,
    /// Item Power per tier, each entry indexed by enchantment level 0 through 4.
    pub item_power: BTreeMap<String, Vec<i64>>,
    /// The item's own mastery modifier per tier — 0 at T4 rising to 0.2 at T8.
    ///
    /// Kept for the calibration work: it is the one plausible explanation for a tier-dependent
    /// discount on the Destiny Board bonus, and the fixtures in `ip.rs` are what will settle
    /// whether it applies. Nothing consumes it yet.
    #[serde(default)]
    pub mastery_modifier: BTreeMap<String, f64>,
    /// Focus-fire protection penetration per tier. Zero throughout the current patch.
    #[serde(default)]
    pub ffp_penetration: BTreeMap<String, f64>,
}

impl CombatItem {
    /// Item Power for a tier and enchantment, or `None` when the item has no such tier.
    ///
    /// The enchantment is clamped to 0..=4; an item that cannot be enchanted repeats its base
    /// value across the whole ladder, so the lookup never needs a special case.
    #[must_use]
    pub fn item_power_at(&self, tier: u8, enchantment: u8) -> Option<i64> {
        let ladder = self.item_power.get(&tier.to_string())?;
        ladder
            .get(usize::from(enchantment.min(4)))
            .or_else(|| ladder.last())
            .copied()
    }
}

/// One `ItemPowerProgression` row: how Item Power turns into stats for a class of slot.
///
/// Each coefficient is applied as `base * coefficient.powf(item_power / 100.0)`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProgressionRow {
    /// Reference armour value the item's own armour is measured against.
    #[serde(rename = "armorbase")]
    pub armor_base: f64,
    /// Reference crowd-control-resistance value.
    #[serde(rename = "ccrbase")]
    pub ccr_base: f64,
    /// Auto-attack damage growth per 100 Item Power.
    #[serde(rename = "attackdamageprogression")]
    pub attack_damage: f64,
    /// Ability power growth per 100 Item Power.
    #[serde(rename = "abilitypowerprogression")]
    pub ability_power: f64,
    /// Crowd-control power growth per 100 Item Power.
    #[serde(rename = "ccpowerprogression")]
    pub cc_power: f64,
    /// Hit point growth per 100 Item Power.
    #[serde(rename = "hitpointsprogression")]
    pub hitpoints: f64,
    /// Energy growth per 100 Item Power.
    #[serde(rename = "energyprogression")]
    pub energy: f64,
    /// Armour and magic-resistance growth per 100 Item Power.
    #[serde(rename = "armorprogression")]
    pub armor: f64,
    /// Crowd-control-resistance growth per 100 Item Power.
    #[serde(rename = "crowdcontrolresistanceprogression")]
    pub cc_resistance: f64,
    /// Flat per-slot multipliers on the item's own bonus fields — a two-handed weapon's
    /// `threatbonus` of 1.16, an off-hand's `attackspeedbonus` of 1.16, and 1.0 for the rest.
    #[serde(default)]
    pub multipliers: BTreeMap<String, f64>,
    /// Per-slot switches: whether this slot type grants magic cast-time and cooldown reduction.
    #[serde(default)]
    pub flags: BTreeMap<String, bool>,
}

/// How much each equipment slot contributes to a pooled character stat.
///
/// `ItemPowerProgression` carries four of these alongside its growth rows. The hit-point table
/// reads head 0.25, armor 0.5, shoes 0.25 — summing to exactly one character's worth across the
/// three armour pieces — while armour and crowd-control resistance come from the chest alone and
/// energy is spread over head, chest, shoes, cape and some off-hands.
///
/// Captured, not yet interpreted: whether the character sheet's single Item Power figure is a
/// display average over slots or whether each stat is pooled per slot through these weights is
/// exactly what the calibration fixtures have to settle. Keys are slot types (`head`, `armor`,
/// `shoes`, `cape`, `mainhand`) and off-hand families (`shield`, `orb`, `totem`, …).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StatShares {
    /// Share of physical armour and magic resistance, by slot.
    pub armor: BTreeMap<String, f64>,
    /// Share of crowd-control resistance, by slot.
    pub ccr: BTreeMap<String, f64>,
    /// Share of maximum hit points, by slot.
    pub hitpoints: BTreeMap<String, f64>,
    /// Share of maximum energy, by slot.
    pub energy: BTreeMap<String, f64>,
}

/// One `itemwearbonus` rule on a Destiny Board node.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BonusRule {
    /// Item Power granted per level of the node.
    pub bonus: f64,
    /// Lowest tier the rule applies to, inclusive.
    pub min_tier: u8,
    /// Highest tier the rule applies to, inclusive.
    pub max_tier: u8,
    /// Item-name globs the rule grants to, matched by [`super::pattern::matches`].
    pub patterns: Vec<String>,
}

/// A Destiny Board node that grants Item Power.
///
/// A specialization node carries both of its rules itself: the large bonus against its own item
/// and the small one against its whole family. Resolving a player's Item Power therefore needs
/// only the nodes they have levels in, with no tree walk.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SpecNode {
    /// `spec` for a leaf specialization, `mastery` for the family node above it.
    pub kind: String,
    /// The mastery node this specialization hangs off. Absent on mastery nodes themselves.
    #[serde(default)]
    pub parent: Option<String>,
    /// Highest level the node can reach — 100 for every combat node.
    pub max_level: i32,
    /// The Item Power rules this node grants.
    pub bonuses: Vec<BonusRule>,
}

/// The base character, before any equipment.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CharacterDefaults {
    /// Base hit points: 1200.
    #[serde(rename = "hitpointsmax")]
    pub hitpoints_max: f64,
    /// Base energy: 120.
    #[serde(rename = "energymax")]
    pub energy_max: f64,
    /// Base movement speed.
    #[serde(rename = "movespeed")]
    pub move_speed: f64,
    /// Base hit point regeneration per second.
    #[serde(rename = "hitpointsregeneration")]
    pub hitpoints_regeneration: f64,
    /// Base energy regeneration per second.
    #[serde(rename = "energyregeneration")]
    pub energy_regeneration: f64,
}

/// How far an area spell's per-target bonus can escalate.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AoeEscalation {
    /// Target count at which escalation starts counting.
    #[serde(rename = "defaulttargetcountthresholdmin")]
    pub threshold_min: i32,
    /// Target count beyond which escalation stops growing — 7.
    #[serde(rename = "defaulttargetcountthresholdmax")]
    pub threshold_max: i32,
}

/// One row of the focus-fire table: the damage reduction at a given number of attackers.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FocusFireRow {
    /// Applies from this many simultaneous attackers upward.
    #[serde(rename = "numbergreaterorequal")]
    pub at_least: i32,
    /// Fraction of melee damage removed.
    #[serde(rename = "meleemodifier")]
    pub melee: f64,
    /// Fraction of ranged damage removed.
    #[serde(rename = "rangedmodifier")]
    pub ranged: f64,
    /// Fraction of mounted damage removed.
    #[serde(rename = "mountedmodifier")]
    pub mounted: f64,
}

/// The focus-fire protection a target gains while several players attack it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FocusFire {
    /// How far back attacker counting looks, in seconds.
    #[serde(rename = "lookbackseconds")]
    pub lookback_seconds: f64,
    /// How long the protection lasts once applied, in seconds.
    #[serde(rename = "effectdurationinsec")]
    pub effect_duration_seconds: f64,
    /// Rows in ascending attacker count.
    pub attackers: Vec<FocusFireRow>,
}

/// One row of the zerg debuff table.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ZergDebuffRow {
    /// Applies from this many allies upward.
    #[serde(rename = "numbergreaterorequal")]
    pub at_least: i32,
    /// Multiplier applied to outgoing damage.
    #[serde(rename = "damagemodifier")]
    pub damage: f64,
    /// Multiplier applied to crowd-control duration.
    #[serde(rename = "ccdurationmodifier")]
    pub cc_duration: f64,
}

/// The penalty a force takes for outnumbering, from 21 allies upward.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ZergDebuff {
    /// Rows in ascending ally count.
    pub allies: Vec<ZergDebuffRow>,
}

/// Diminishing returns on repeated crowd control.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CcDiminishingReturns {
    /// Largest fraction of a crowd-control duration that can be removed.
    #[serde(rename = "diminishingreturnmax")]
    pub max: f64,
    /// Per-type factors and decay times, keyed by their dump name (`typefactorstun`,
    /// `decreasetimestun`, …). Left keyed rather than enumerated because the simulator in phase 4
    /// is what decides which of them it needs.
    #[serde(flatten)]
    pub factors: BTreeMap<String, f64>,
}

/// Every global table the combat engine reads.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CombatRules {
    /// Provenance of the bundled dataset.
    pub dataset_version: DatasetVersion,
    /// Item Power granted by quality, keyed `"1"`..`"5"`: 0, 20, 40, 60, 100.
    pub quality_item_power: BTreeMap<String, i64>,
    /// Progression coefficients, keyed by [`CombatItem::progression`].
    pub item_power_progression: BTreeMap<String, ProgressionRow>,
    /// Per-slot weights for the pooled character stats.
    pub stat_shares: StatShares,
    /// Every Destiny Board node that grants Item Power.
    pub spec_nodes: BTreeMap<String, SpecNode>,
    /// The base character.
    pub character_defaults: CharacterDefaults,
    /// Seconds of global cooldown between casts.
    pub global_cast_delay: f64,
    /// The area-escalation cap.
    #[serde(rename = "AoeEscalation")]
    pub aoe_escalation: AoeEscalation,
    /// The focus-fire protection table.
    #[serde(rename = "PlayerFocusFire")]
    pub focus_fire: FocusFire,
    /// The zerg debuff table.
    #[serde(rename = "ZergDebuff")]
    pub zerg_debuff: ZergDebuff,
    /// Crowd-control diminishing returns.
    #[serde(rename = "CrowdControlDiminishingReturns")]
    pub cc_diminishing_returns: CcDiminishingReturns,
}

impl CombatRules {
    /// Item Power granted by an item quality (1 Normal through 5 Masterpiece).
    ///
    /// An unknown quality contributes nothing rather than failing: quality is a display grade, and
    /// a bad one should not stop an Item Power figure from being produced.
    #[must_use]
    // Quality bonuses are 0 to 100; no i64 in this table comes close to losing mantissa bits.
    #[allow(clippy::cast_precision_loss)]
    pub fn quality_bonus(&self, quality: i16) -> f64 {
        self.quality_item_power
            .get(&quality.to_string())
            .copied()
            .map_or(0.0, |bonus| bonus as f64)
    }
}
