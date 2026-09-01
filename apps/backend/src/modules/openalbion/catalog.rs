//! Data models for the local Albion equipment catalog.
//!
//! These types preserve the historical response contracts used by the frontend. The data itself
//! is bundled in `catalog.json` and is never fetched from a third-party service.

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use utoipa::ToSchema;

/// An item category (e.g. "Swords", "Bows"), optionally nested under a parent category type.
/// `subcategories` recurses to arbitrary depth (marked `no_recursion` in the OpenAPI schema only
/// to avoid an infinite schema definition — the actual JSON payload nests normally).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 1,
    "name": "Swords",
    "type": "weapon",
    "subcategories": [ { "id": 11, "name": "One-Handed Swords", "type": "weapon", "subcategories": [] } ]
}))]
pub struct OpenAlbionCategory {
    #[schema(example = 1)]
    pub id: i64,
    #[schema(example = "Swords")]
    pub name: String,
    /// Top-level branch this category belongs to, e.g. `"weapon"`, `"armor"`, `"accessory"`,
    /// `"consumable"`. Present on top-level categories; typically absent on nested subcategories.
    #[serde(rename = "type", default)]
    #[schema(example = "weapon")]
    pub category_type: Option<String>,
    /// Nested subcategories, if any (e.g. "Swords" -> "One-Handed Swords" / "Dual Swords" /
    /// "Claymores"). Empty for leaf categories.
    #[serde(default)]
    #[schema(no_recursion)]
    pub subcategories: Vec<OpenAlbionCategory>,
}

/// A single weapon entry as returned by `GET /openalbion/weapons`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 42,
    "name": "Broadsword",
    "tier": "4",
    "item_power": 900,
    "icon": "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png"
}))]
pub struct OpenAlbionWeapon {
    /// Pass this to `GET /openalbion/weapons/{id}/stats`.
    #[schema(example = 42)]
    pub id: i64,
    #[schema(example = "Broadsword")]
    pub name: String,
    /// Base tier as a string, e.g. `"4"` or `"4.1"` for tier 4 with 1 enchantment baked into the
    /// item name.
    #[serde(default)]
    #[schema(example = "4")]
    pub tier: Option<String>,
    #[serde(default)]
    #[schema(example = 900)]
    pub item_power: Option<i64>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png")]
    pub icon: Option<String>,
}

/// A single named stat value (e.g. "Physical damage" -> 125) on a weapon quality tier. `value`
/// is untyped JSON because OpenAlbion mixes numbers and strings across different stat names.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({ "name": "Physical damage", "value": 125 }))]
pub struct OpenAlbionStatEntry {
    #[schema(example = "Physical damage")]
    pub name: String,
    #[schema(value_type = Object, example = json!(125))]
    pub value: serde_json::Value,
}

/// Stats for a single quality tier (Normal, Good, Outstanding, Excellent, Masterpiece) of a
/// weapon at a given enchantment level, as returned nested inside `OpenAlbionWeaponStats`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OpenAlbionWeaponQualityStat {
    #[schema(example = 1)]
    pub id: i64,
    /// One of `"Normal"`, `"Good"`, `"Outstanding"`, `"Excellent"`, `"Masterpiece"`.
    #[serde(default)]
    #[schema(example = "Masterpiece")]
    pub quality: Option<String>,
    /// Enchantment level (0-4), matching the parent `OpenAlbionWeaponStats.enchantment`.
    #[serde(default)]
    #[schema(example = 3)]
    pub enchantment: Option<i64>,
    pub weapon: OpenAlbionWeapon,
    #[serde(default)]
    pub stats: Vec<OpenAlbionStatEntry>,
}

/// Full stats payload for one weapon at one enchantment level, as returned (as an array, one
/// entry per enchantment level 0-4) by `GET /openalbion/weapons/{id}/stats`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OpenAlbionWeaponStats {
    #[serde(default)]
    #[schema(example = 3)]
    pub enchantment: Option<i64>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD@3.png")]
    pub icon: Option<String>,
    #[serde(default)]
    pub stats: Vec<OpenAlbionWeaponQualityStat>,
}

/// Type of OpenAlbion item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpenAlbionItemType {
    /// Weapon item.
    Weapon,
    /// Armor item.
    Armor,
    /// Accessory item.
    Accessory,
    /// Consumable item.
    Consumable,
}

impl FromStr for OpenAlbionItemType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "weapon" => Ok(Self::Weapon),
            "armor" => Ok(Self::Armor),
            "accessory" => Ok(Self::Accessory),
            "consumable" => Ok(Self::Consumable),
            other => Err(format!("unknown OpenAlbion item type: {other}")),
        }
    }
}

/// A unified item entry that can represent any of the 4 OpenAlbion item types.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": 42,
    "name": "Broadsword",
    "tier": "4",
    "item_power": 900,
    "type": "weapon",
    "identifier": "T4_MAIN_SWORD",
    "icon": "https://render.albiononline.com/v1/item/T4_MAIN_SWORD.png?quality=1&size=64",
    "info": "Additional consumable info"
}))]
pub struct OpenAlbionItem {
    /// Pass this to detail endpoints (if any exist for the item type).
    #[schema(example = 42)]
    pub id: i64,
    #[schema(example = "Broadsword")]
    pub name: String,
    /// Base tier as a string, e.g. `"4"` or `"4.1"` for tier 4 with 1 enchantment.
    #[serde(default)]
    #[schema(example = "4")]
    pub tier: Option<String>,
    #[serde(default)]
    #[schema(example = 900)]
    pub item_power: Option<i64>,
    /// Item branch (`weapon`, `armor`, `accessory`, or `consumable`) used by build slots.
    #[serde(rename = "type", default)]
    #[schema(example = "weapon")]
    pub item_type: Option<String>,
    /// Item identifier unique string (present on armor, accessory, consumable).
    #[serde(default)]
    #[schema(example = "T4_MAIN_SWORD")]
    pub identifier: Option<String>,
    #[serde(default)]
    #[schema(example = "https://cdn.openalbion.com/icons/T4_MAIN_SWORD.png")]
    pub icon: Option<String>,
    /// Additional info string (present on consumables).
    #[serde(default)]
    #[schema(example = "Additional consumable info")]
    pub info: Option<String>,
}

/// Optional filters accepted by `/weapons`, `/armors`, `/accessories`, `/consumables`.
#[derive(Debug, Clone, Default)]
pub struct OpenAlbionWeaponFilters {
    pub category_id: Option<i64>,
    pub subcategory_id: Option<i64>,
    pub tier: Option<i64>,
}

/// One selectable ability on an equipped item.
///
/// `cooldown` and `energy` come straight from the game dump and are strings there — kept as strings
/// so a value the dump expresses oddly is shown rather than silently dropped by a failed parse.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "id": "HEROICSTRIKE2",
    "name": "Heroic Strike",
    "cooldown": "3",
    "energy": "2"
}))]
pub struct OpenAlbionAbility {
    /// Albion's internal spell id. Also the key for the icon:
    /// `https://render.albiononline.com/v1/spell/{id}.png`.
    #[schema(example = "HEROICSTRIKE2")]
    pub id: String,
    /// The player-facing spell name.
    #[schema(example = "Heroic Strike")]
    pub name: String,
    /// Recast delay in seconds, when the spell declares one.
    #[serde(default)]
    pub cooldown: Option<String>,
    /// Energy cost, when the spell declares one.
    #[serde(default)]
    pub energy: Option<String>,
}

/// Every ability an item family offers, grouped by the slot that can hold it.
///
/// Keyed in the bundled dataset by the tier-stripped base identifier (`MAIN_SWORD`), because all
/// eight tiers of one item offer the same spells.
///
/// `active` and `passive` map a slot index (as a string, `"1"`, `"2"`, `"3"`) to the choices that
/// slot accepts. Active slot 1/2/3 are the player's Q/W/E on a weapon; armor pieces have a single
/// active slot bound to D (head), R (chest) or F (shoes). An item with zero slots of a kind — an
/// off-hand, a cape — carries an empty map, and the UI shows no picker for it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!({
    "label": "Broadsword",
    "slot_type": "mainhand",
    "two_handed": false,
    "active_slots": 3,
    "passive_slots": 1,
    "active": { "1": [ { "id": "HEROICSTRIKE2", "name": "Heroic Strike" } ] },
    "passive": { "1": [ { "id": "PASSIVE_BLEEDCHANCE", "name": "Deep Cuts" } ] }
}))]
pub struct OpenAlbionItemAbilities {
    /// The item family's player-facing name, matching the catalog.
    #[schema(example = "Broadsword")]
    pub label: String,
    /// Albion's slot type for the item, e.g. `"mainhand"`, `"armor"`, `"head"`.
    #[serde(default)]
    pub slot_type: Option<String>,
    /// Whether the weapon occupies the off-hand as well.
    #[serde(default)]
    pub two_handed: bool,
    /// How many active abilities the item can slot.
    #[schema(example = 3)]
    pub active_slots: i32,
    /// How many passive abilities the item can slot.
    #[schema(example = 1)]
    pub passive_slots: i32,
    /// Active choices per slot index.
    #[serde(default)]
    pub active: std::collections::BTreeMap<String, Vec<OpenAlbionAbility>>,
    /// Passive choices per slot index.
    #[serde(default)]
    pub passive: std::collections::BTreeMap<String, Vec<OpenAlbionAbility>>,
}
