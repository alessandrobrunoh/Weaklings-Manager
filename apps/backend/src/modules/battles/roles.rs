//! Weapon → role classification.
//!
//! Battle snapshots carry no role information: `players_json` is only
//! `{name, guild, kills, deaths, fame, item_power}`, and the kill feed gives us
//! an equipment item id and nothing more. Every role in Intel is therefore
//! *derived* from the main-hand weapon, in two tiers:
//!
//! 1. **Curated** — the guild's own `build_items` rows (`slot = 'weapon'`)
//!    joined to `builds.role`. This is authoritative: it reflects how this
//!    guild actually plays each weapon, and it tracks the meta for free as
//!    officers maintain their builds.
//! 2. **Heuristic** — a static keyword table over the Albion item id, used only
//!    for weapons the guild has never built. It is a best effort and is
//!    reported as such via [`RoleConfidence`], so the UI can be honest about
//!    which numbers are inferred.
//!
//! The main-hand weapon itself comes from the kill feed ([`weapons_by_player`]);
//! players it never shows get [`ROLE_UNOBSERVED`].

use std::collections::{BTreeMap, HashMap};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde_json::Value;

use crate::errors::AppError;
use crate::modules::battles::models::BattleKillEvent;
use crate::modules::comps::entities::{build, build_item};
use crate::modules::comps::status::{BuildRole, BuildSlot};

/// Which tier resolved a role, so callers can surface confidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleConfidence {
    /// Matched one of the guild's own curated builds.
    Curated,
    /// Fell back to the static keyword table.
    Heuristic,
}

/// Keyword table for the heuristic tier, evaluated in order.
///
/// Order matters: the first substring hit wins, so more specific families must
/// precede broader ones. Anything unmatched is treated as DPS, which is both
/// the largest family and the least misleading default.
const HEURISTICS: &[(&str, BuildRole)] = &[
    // Battle mounts are a prefix match after tier stripping.
    ("MOUNT_", BuildRole::BattleMount),
    // Healers.
    ("HOLYSTAFF", BuildRole::Healer),
    ("DIVINESTAFF", BuildRole::Healer),
    ("NATURESTAFF", BuildRole::Healer),
    ("WILDSTAFF", BuildRole::Healer),
    ("IRONROOT", BuildRole::Healer),
    ("LIFETOUCH", BuildRole::Healer),
    // Tanks.
    ("QUARTERSTAFF", BuildRole::Tank),
    ("COMBATSTAFF", BuildRole::Tank),
    ("ROCKSTAFF", BuildRole::Tank),
    ("IRONGAUNTLETS", BuildRole::Tank),
    ("DUALSICKLE", BuildRole::Tank),
    ("RAM_KEEPER", BuildRole::Tank),
    ("MACE", BuildRole::Tank),
    ("HAMMER", BuildRole::Tank),
    // Support.
    ("ARCANESTAFF", BuildRole::Support),
    ("ENIGMATIC", BuildRole::Support),
    ("FROSTSTAFF", BuildRole::Support),
    ("GLACIALSTAFF", BuildRole::Support),
    ("ICECRYSTAL", BuildRole::Support),
    ("ICEGAUNTLETS", BuildRole::Support),
    ("CURSEDSTAFF", BuildRole::Support),
    ("SKULLORB", BuildRole::Support),
    // Brawlers.
    ("DUALAXE", BuildRole::Brawler),
    ("DUALSWORD", BuildRole::Brawler),
    ("BEARPAWS", BuildRole::Brawler),
];

/// Normalizes an equipment identifier so curated and kill-feed ids compare equal.
///
/// Kill events carry fully qualified, enchanted ids (`T8_2H_HOLYSTAFF_MORGANA@3`)
/// while `build_items.openalbion_item_name` stores the tier-less base
/// identifier (`2H_HOLYSTAFF_MORGANA`). Stripping the enchantment suffix and the
/// tier prefix makes a T4 build match a T8 kill, which is what we want: tier is
/// a gear-quality decision, not a role decision.
///
/// # Example
/// ```ignore
/// assert_eq!(normalize_item_id("T8_2H_HOLYSTAFF_MORGANA@3"), "2H_HOLYSTAFF_MORGANA");
/// ```
#[must_use]
pub fn normalize_item_id(item_id: &str) -> String {
    let upper = item_id.trim().to_ascii_uppercase();
    let base = upper.split('@').next().unwrap_or("").to_string();
    strip_tier_prefix(&base)
}

/// Removes a leading `T<digits>_` tier marker, if present.
fn strip_tier_prefix(value: &str) -> String {
    let Some(rest) = value.strip_prefix('T') else {
        return value.to_string();
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return value.to_string();
    }
    match rest[digits.len()..].strip_prefix('_') {
        Some(tail) => tail.to_string(),
        None => value.to_string(),
    }
}

/// Resolves weapon item ids to roles, preferring the guild's curated builds.
#[derive(Debug, Clone, Default)]
pub struct RoleClassifier {
    /// Normalized weapon identifier → role, from `build_items` ⋈ `builds`.
    curated: HashMap<String, BuildRole>,
}

impl RoleClassifier {
    /// Loads the curated tier from the guild's own builds.
    ///
    /// Two queries, no N+1: all weapon-slot build items, then the builds they
    /// belong to. Both tables are small (bounded by how many builds officers
    /// have authored), so this is loaded once per scouting or report run and
    /// then consulted in memory.
    ///
    /// A build whose `role` string does not parse is skipped rather than
    /// failing the run — a bad row should not take Intel offline.
    pub async fn load(db: &DatabaseConnection) -> Result<Self, AppError> {
        let items = build_item::Entity::find()
            .filter(build_item::Column::Slot.eq(BuildSlot::Weapon.to_string()))
            .all(db)
            .await?;
        if items.is_empty() {
            return Ok(Self::default());
        }

        let build_ids: Vec<i64> = {
            let mut ids: Vec<i64> = items.iter().map(|item| item.build_id).collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        };
        let roles_by_build: HashMap<i64, BuildRole> = build::Entity::find()
            .filter(build::Column::Id.is_in(build_ids))
            .all(db)
            .await?
            .into_iter()
            .filter_map(|row| {
                row.role
                    .parse::<BuildRole>()
                    .ok()
                    .map(|role| (row.id, role))
            })
            .collect();

        let mut curated = HashMap::new();
        for item in items {
            let Some(role) = roles_by_build.get(&item.build_id).copied() else {
                continue;
            };
            curated.insert(normalize_item_id(&item.openalbion_item_name), role);
        }
        Ok(Self { curated })
    }

    /// Builds a classifier from an explicit map. Used by tests.
    #[cfg(test)]
    #[must_use]
    pub fn from_curated(curated: HashMap<String, BuildRole>) -> Self {
        Self { curated }
    }

    /// Classifies a main-hand weapon id, reporting which tier answered.
    #[must_use]
    pub fn classify(&self, item_id: &str) -> (BuildRole, RoleConfidence) {
        let normalized = normalize_item_id(item_id);
        if let Some(role) = self.curated.get(&normalized).copied() {
            return (role, RoleConfidence::Curated);
        }
        (Self::heuristic(&normalized), RoleConfidence::Heuristic)
    }

    /// Static keyword fallback. Unmatched weapons are DPS.
    #[must_use]
    fn heuristic(normalized: &str) -> BuildRole {
        for (needle, role) in HEURISTICS {
            if normalized.contains(needle) {
                return *role;
            }
        }
        BuildRole::Dps
    }
}

/// Role bucket for an enemy the kill feed never showed us.
///
/// Deliberately not a [`crate::modules::comps::status::BuildRole`]: it is the
/// absence of a role, not a seventh one. `intel::similarity` builds its role vector
/// from `ROLE_KEYS`, so this key is ignored there, while `CompProfile::size`
/// still counts the player and keeps the size penalty honest.
pub const ROLE_UNOBSERVED: &str = "unobserved";

/// Reads the main-hand item id out of one side of a raw kill event.
///
/// The upstream payload is preserved verbatim in `BattleKillEvent::raw`, and
/// its casing is inconsistent between endpoints, hence the paired lookups.
/// This deliberately extracts only the weapon: the full-equipment walkers in
/// `regear::pricing` and `battles::service` exist to price every slot, which is
/// a different job with a different output type.
#[must_use]
pub fn main_hand_of(raw: &Value, side: &str) -> Option<String> {
    let lower = side.to_ascii_lowercase();
    let participant = raw.get(side).or_else(|| raw.get(&lower))?;
    let equipment = participant
        .get("Equipment")
        .or_else(|| participant.get("equipment"))?;
    let main_hand = equipment
        .get("MainHand")
        .or_else(|| equipment.get("mainHand"))
        .or_else(|| equipment.get("main_hand"))?;
    let item_id = main_hand
        .get("Type")
        .or_else(|| main_hand.get("type"))
        .and_then(Value::as_str)?;
    let trimmed = item_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Builds a `name -> main-hand item id` index from a battle's kill feed.
///
/// Both sides of every kill are harvested, since a player who died in one
/// exchange may have killed in another. Later observations overwrite earlier
/// ones, which is harmless: a player who swapped weapons mid-fight is recorded
/// as whatever they were last seen holding.
#[must_use]
pub fn weapons_by_player(kills: &[BattleKillEvent]) -> BTreeMap<String, String> {
    let mut weapons = BTreeMap::new();
    for kill in kills {
        if let Some(item) = main_hand_of(&kill.raw, "Killer") {
            weapons.insert(kill.killer.name.clone(), item);
        }
        if let Some(item) = main_hand_of(&kill.raw, "Victim") {
            weapons.insert(kill.victim.name.clone(), item);
        }
    }
    weapons
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_tier_and_enchantment() {
        assert_eq!(
            normalize_item_id("T8_2H_HOLYSTAFF_MORGANA@3"),
            "2H_HOLYSTAFF_MORGANA"
        );
        assert_eq!(normalize_item_id("T4_2H_BOW"), "2H_BOW");
        assert_eq!(normalize_item_id("2H_BOW"), "2H_BOW");
        assert_eq!(normalize_item_id("  t8_main_mace@1  "), "MAIN_MACE");
    }

    /// A curated build id and a kill-feed id for the same weapon family must
    /// normalize to the same key, otherwise the curated tier never hits.
    #[test]
    fn curated_ids_and_killfeed_ids_normalize_alike() {
        assert_eq!(
            normalize_item_id("2H_HOLYSTAFF_MORGANA"),
            normalize_item_id("T8_2H_HOLYSTAFF_MORGANA@3")
        );
    }

    #[test]
    fn strip_tier_prefix_leaves_non_tier_names_alone() {
        assert_eq!(strip_tier_prefix("TOWERSHIELD"), "TOWERSHIELD");
        assert_eq!(strip_tier_prefix("T_ODD"), "T_ODD");
        assert_eq!(strip_tier_prefix("T8_BAG"), "BAG");
    }

    #[test]
    fn curated_tier_wins_over_heuristic() {
        // The heuristic would call a holy staff a healer; the guild says tank.
        let curated = HashMap::from([("2H_HOLYSTAFF".to_string(), BuildRole::Tank)]);
        let classifier = RoleClassifier::from_curated(curated);
        assert_eq!(
            classifier.classify("T8_2H_HOLYSTAFF@2"),
            (BuildRole::Tank, RoleConfidence::Curated)
        );
    }

    #[test]
    fn heuristic_covers_the_main_families() {
        let c = RoleClassifier::default();
        let cases = [
            ("T8_MAIN_HOLYSTAFF", BuildRole::Healer),
            ("T8_2H_NATURESTAFF", BuildRole::Healer),
            ("T8_2H_MACE", BuildRole::Tank),
            ("T8_2H_QUARTERSTAFF", BuildRole::Tank),
            ("T8_2H_RAM_KEEPER", BuildRole::Tank),
            ("T8_2H_CURSEDSTAFF_MORGANA", BuildRole::Support),
            ("T8_2H_ICECRYSTAL", BuildRole::Support),
            ("T8_2H_ARCANESTAFF", BuildRole::Support),
            ("T8_2H_DUALAXE_KEEPER", BuildRole::Brawler),
            ("T8_2H_DUALSWORD", BuildRole::Brawler),
            ("T5_MOUNT_COUGAR_KEEPER", BuildRole::BattleMount),
        ];
        for (item, expected) in cases {
            let (role, confidence) = c.classify(item);
            assert_eq!(role, expected, "wrong role for {item}");
            assert_eq!(confidence, RoleConfidence::Heuristic);
        }
    }

    #[test]
    fn unknown_weapons_default_to_dps() {
        let c = RoleClassifier::default();
        assert_eq!(c.classify("T8_2H_BOW").0, BuildRole::Dps);
        assert_eq!(c.classify("T8_MAIN_DAGGER").0, BuildRole::Dps);
        assert_eq!(c.classify("SOMETHING_NEW").0, BuildRole::Dps);
    }

    #[test]
    fn extracts_main_hand_from_either_casing() {
        let upper = json!({"Victim": {"Equipment": {"MainHand": {"Type": "T8_2H_BOW"}}}});
        assert_eq!(main_hand_of(&upper, "Victim").as_deref(), Some("T8_2H_BOW"));
        let lower = json!({"victim": {"equipment": {"mainHand": {"type": "T8_2H_BOW"}}}});
        assert_eq!(main_hand_of(&lower, "Victim").as_deref(), Some("T8_2H_BOW"));
    }

    #[test]
    fn missing_or_blank_weapon_yields_none() {
        assert_eq!(main_hand_of(&json!({}), "Victim"), None);
        let blank = json!({"Victim": {"Equipment": {"MainHand": {"Type": "  "}}}});
        assert_eq!(main_hand_of(&blank, "Victim"), None);
    }
}
