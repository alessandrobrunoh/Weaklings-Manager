//! Status and slot enums for the comps module.
//!
//! Defines the fixed-in-code (not DB-creatable) enums for build roles and equipment slots.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The role of a build within a composition.
///
/// Stored in the database as its lowercase/snake_case string form (see [`FromStr`]/
/// [`fmt::Display`]), since the `builds.role` column is a plain string rather than a native
/// DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BuildRole {
    /// A healer build.
    Healer,
    /// A support build.
    Support,
    /// A damage dealer build.
    Dps,
    /// A tank build.
    Tank,
    /// A battle mount build.
    BattleMount,
    /// A brawler build.
    Brawler,
}

impl BuildRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Healer => "healer",
            Self::Support => "support",
            Self::Dps => "dps",
            Self::Tank => "tank",
            Self::BattleMount => "battle_mount",
            Self::Brawler => "brawler",
        }
    }
}

impl fmt::Display for BuildRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BuildRole {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "healer" => Ok(Self::Healer),
            "support" => Ok(Self::Support),
            "dps" => Ok(Self::Dps),
            "tank" => Ok(Self::Tank),
            "battle_mount" => Ok(Self::BattleMount),
            "brawler" => Ok(Self::Brawler),
            other => Err(format!("unknown build role: {other}")),
        }
    }
}

/// The equipment slot of a build item.
///
/// Stored in the database as its lowercase/snake_case string form (see [`FromStr`]/
/// [`fmt::Display`]), since the `build_items.slot` column is a plain string rather than a native
/// DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BuildSlot {
    /// Weapon slot.
    Weapon,
    /// Off-hand slot.
    OffHand,
    /// Head slot.
    Head,
    /// Armor slot.
    Armor,
    /// Shoes slot.
    Shoes,
    /// Cape slot.
    Cape,
    /// Bag slot.
    Bag,
    /// Potion slot.
    Potion,
    /// Food slot.
    Food,
    /// Mount slot.
    Mount,
}

impl BuildSlot {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weapon => "weapon",
            Self::OffHand => "off_hand",
            Self::Head => "head",
            Self::Armor => "armor",
            Self::Shoes => "shoes",
            Self::Cape => "cape",
            Self::Bag => "bag",
            Self::Potion => "potion",
            Self::Food => "food",
            Self::Mount => "mount",
        }
    }
}

impl fmt::Display for BuildSlot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BuildSlot {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "weapon" => Ok(Self::Weapon),
            "off_hand" => Ok(Self::OffHand),
            "head" => Ok(Self::Head),
            "armor" => Ok(Self::Armor),
            "shoes" => Ok(Self::Shoes),
            "cape" => Ok(Self::Cape),
            "bag" => Ok(Self::Bag),
            "potion" => Ok(Self::Potion),
            "food" => Ok(Self::Food),
            "mount" => Ok(Self::Mount),
            other => Err(format!("unknown build slot: {other}")),
        }
    }
}
