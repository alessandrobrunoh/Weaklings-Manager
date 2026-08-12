//! Slot bitmask helpers for the regear workflow.
//!
//! The admin-tunable `enabled_slots_mask` is a bitmask over the canonical `BuildSlot` enum.
//! AlbionBB kill-feed equipment keys are camelCase (`MainHand`, `OffHand`, `Armor`, …) and must
//! be mapped to the canonical slot before the mask can be consulted.

use crate::modules::comps::status::BuildSlot;

/// Bit position for each `BuildSlot`. Matches the declaration order in `comps::status::BuildSlot`
/// (weapon, off_hand, head, armor, shoes, cape, bag, potion, food, mount).
///
/// These are part of the data contract: changing the order would silently shift every admin's
/// configured mask. Never renumber existing variants.
pub fn slot_bit(slot: BuildSlot) -> u32 {
    match slot {
        BuildSlot::Weapon => 1 << 0,
        BuildSlot::OffHand => 1 << 1,
        BuildSlot::Head => 1 << 2,
        BuildSlot::Armor => 1 << 3,
        BuildSlot::Shoes => 1 << 4,
        BuildSlot::Cape => 1 << 5,
        BuildSlot::Bag => 1 << 6,
        BuildSlot::Potion => 1 << 7,
        BuildSlot::Food => 1 << 8,
        BuildSlot::Mount => 1 << 9,
    }
}

/// Default mask: every slot enabled.
#[must_use]
pub fn default_mask() -> i32 {
    let mut mask = 0u32;
    for slot in [
        BuildSlot::Weapon,
        BuildSlot::OffHand,
        BuildSlot::Head,
        BuildSlot::Armor,
        BuildSlot::Shoes,
        BuildSlot::Cape,
        BuildSlot::Bag,
        BuildSlot::Potion,
        BuildSlot::Food,
        BuildSlot::Mount,
    ] {
        mask |= slot_bit(slot);
    }
    mask as i32
}

/// Returns `true` if the given slot is enabled in the mask.
#[must_use]
pub fn is_slot_enabled(mask: i32, slot: BuildSlot) -> bool {
    ((mask as u32) & slot_bit(slot)) != 0
}

/// Maps AlbionBB equipment JSON keys (camelCase) to the canonical `BuildSlot`.
///
/// AlbionBB uses a fixed set of keys on the `Equipment` object; unknown keys map to `None` and
/// the caller should skip the corresponding item rather than fail the whole pricing pass.
#[must_use]
pub fn slot_from_albionbb_key(key: &str) -> Option<BuildSlot> {
    match key {
        "MainHand" | "main_hand" | "mainhand" => Some(BuildSlot::Weapon),
        "OffHand" | "off_hand" | "offhand" => Some(BuildSlot::OffHand),
        "Head" | "head" => Some(BuildSlot::Head),
        "Armor" | "Body" | "armor" | "body" => Some(BuildSlot::Armor),
        "Shoes" | "shoes" => Some(BuildSlot::Shoes),
        "Cape" | "cape" => Some(BuildSlot::Cape),
        "Bag" | "bag" => Some(BuildSlot::Bag),
        "Potion" | "potion" => Some(BuildSlot::Potion),
        "Food" | "food" => Some(BuildSlot::Food),
        "Mount" | "mount" => Some(BuildSlot::Mount),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mask_includes_every_slot() {
        let mask = default_mask();
        for slot in [
            BuildSlot::Weapon,
            BuildSlot::OffHand,
            BuildSlot::Head,
            BuildSlot::Armor,
            BuildSlot::Shoes,
            BuildSlot::Cape,
            BuildSlot::Bag,
            BuildSlot::Potion,
            BuildSlot::Food,
            BuildSlot::Mount,
        ] {
            assert!(is_slot_enabled(mask, slot), "{slot:?} should be enabled");
        }
    }

    #[test]
    fn zero_mask_disables_everything() {
        for slot in [BuildSlot::Weapon, BuildSlot::Mount, BuildSlot::Food] {
            assert!(!is_slot_enabled(0, slot));
        }
    }

    #[test]
    fn camelcase_keys_map_to_canonical_slots() {
        assert_eq!(slot_from_albionbb_key("MainHand"), Some(BuildSlot::Weapon));
        assert_eq!(slot_from_albionbb_key("Armor"), Some(BuildSlot::Armor));
        assert_eq!(slot_from_albionbb_key("Unknown"), None);
    }
}
