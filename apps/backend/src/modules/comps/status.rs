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

/// Which loadout of a build an item belongs to.
///
/// A build has one main loadout and at most one swap — the alternative weapon, off-hand or armor a
/// player carries for a specific matchup. Stored in the database as its lowercase string form (see
/// [`FromStr`]/[`fmt::Display`]), since `build_items.loadout` is a plain string rather than a
/// native DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BuildLoadout {
    /// The loadout the player starts the fight in.
    #[default]
    Main,
    /// The single alternative loadout carried for a specific matchup.
    Swap,
}

impl BuildLoadout {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Swap => "swap",
        }
    }
}

impl fmt::Display for BuildLoadout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BuildLoadout {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "main" => Ok(Self::Main),
            "swap" => Ok(Self::Swap),
            other => Err(format!("unknown build loadout: {other}")),
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

/// Albion item quality. `1` Normal through `5` Masterpiece.
///
/// Excellent (`4`) is the guild default: existing `build_items` rows and omitted request
/// fields resolve here so a loadout does not silently drop to Normal.
pub const DEFAULT_ITEM_QUALITY: i16 = 4;

/// Accepts an optional quality from a request body and rejects anything outside `1..=5`.
///
/// Omitted values become [`DEFAULT_ITEM_QUALITY`]. `0` and `6` return an error string.
///
/// # Errors
///
/// Returns a human-readable message when `value` is present but not in `1..=5`.
pub fn parse_item_quality(value: Option<i16>) -> Result<i16, String> {
    let quality = value.unwrap_or(DEFAULT_ITEM_QUALITY);
    if (1..=5).contains(&quality) {
        Ok(quality)
    } else {
        Err(format!(
            "item quality must be between 1 and 5, got {quality}"
        ))
    }
}

/// Plain, unenchanted gear — the value every pre-existing build item carries.
pub const DEFAULT_ITEM_ENCHANTMENT: i16 = 0;

/// Accepts an optional enchantment from a request body and rejects anything outside `0..=4`.
///
/// Omitted values become [`DEFAULT_ITEM_ENCHANTMENT`]. Unlike quality the floor is zero, because
/// plain gear is a real choice rather than a missing one.
///
/// # Errors
///
/// Returns a human-readable message when `value` is present but not in `0..=4`.
pub fn parse_item_enchantment(value: Option<i16>) -> Result<i16, String> {
    let enchantment = value.unwrap_or(DEFAULT_ITEM_ENCHANTMENT);
    if (0..=4).contains(&enchantment) {
        Ok(enchantment)
    } else {
        Err(format!(
            "item enchantment must be between 0 and 4, got {enchantment}"
        ))
    }
}

/// Rewrites an Albion render URL so its `quality` query matches `quality`.
///
/// Catalog icons are stored with `quality=1`. Builds persist a separate quality column, so
/// reads and writes both run through this helper and the image the client sees is the grade
/// that was actually chosen.
#[must_use]
pub fn icon_url_with_quality(icon: Option<&str>, quality: i16) -> Option<String> {
    let icon = icon?.trim();
    if icon.is_empty() {
        return None;
    }
    if let Some(idx) = icon.find("quality=") {
        let after = idx + "quality=".len();
        let digits = icon[after..].bytes().take_while(u8::is_ascii_digit).count();
        let mut rewritten = String::with_capacity(icon.len() + 1);
        rewritten.push_str(&icon[..after]);
        rewritten.push_str(&quality.to_string());
        rewritten.push_str(&icon[after + digits..]);
        Some(rewritten)
    } else if icon.contains('?') {
        Some(format!("{icon}&quality={quality}"))
    } else {
        Some(format!("{icon}?quality={quality}"))
    }
}

#[cfg(test)]
mod item_quality_tests {
    use super::{icon_url_with_quality, parse_item_enchantment, parse_item_quality};

    #[test]
    fn omitted_quality_is_excellent() {
        assert_eq!(parse_item_quality(None).unwrap(), 4);
    }

    #[test]
    fn masterpiece_is_accepted() {
        assert_eq!(parse_item_quality(Some(5)).unwrap(), 5);
    }

    #[test]
    fn omitted_enchantment_is_plain() {
        assert_eq!(parse_item_enchantment(None).unwrap(), 0);
    }

    #[test]
    fn plain_and_fully_enchanted_are_both_accepted() {
        assert_eq!(parse_item_enchantment(Some(0)).unwrap(), 0);
        assert_eq!(parse_item_enchantment(Some(4)).unwrap(), 4);
    }

    #[test]
    fn an_enchantment_outside_the_ladder_is_rejected() {
        assert!(parse_item_enchantment(Some(5)).is_err());
        assert!(parse_item_enchantment(Some(-1)).is_err());
    }

    #[test]
    fn zero_and_six_are_rejected() {
        assert!(parse_item_quality(Some(0)).is_err());
        assert!(parse_item_quality(Some(6)).is_err());
    }

    #[test]
    fn rewrites_an_existing_quality_query() {
        let url = icon_url_with_quality(
            Some("https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64"),
            5,
        );
        assert_eq!(
            url.as_deref(),
            Some("https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=5&size=64")
        );
    }

    #[test]
    fn appends_quality_when_the_url_has_no_query() {
        let url = icon_url_with_quality(
            Some("https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png"),
            4,
        );
        assert_eq!(
            url.as_deref(),
            Some("https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=4")
        );
    }
}
