//! Item Power: what the game would show for a given loadout and a given player.
//!
//! Pure arithmetic over the bundled dataset — no database, no async, no I/O — so it can be pinned
//! by fixtures captured from the live game. That pinning is the point: three of the four inputs
//! are exact game data, and the fourth is a modelling choice this module states out loud.
//!
//! ```text
//! item Item Power = base(tier, enchantment)      exact, from items.json
//!                 + quality bonus                exact, from gamedata.json
//!                 + Σ (node level × rule bonus)  exact coefficients, summed by a stated rule
//! ```
//!
//! # The two things that are modelled rather than read
//!
//! **Overlapping Destiny Board rules are summed.** A specialization node carries two rules that
//! both match its own weapon: `+2.0` per level against `T?_2H_POLEHAMMER` and `+0.2` per level
//! against `T?_2H_POLEHAMMER*`, which the polehammer also matches. Treating them as independent
//! bonuses that add is the literal reading of the data — if the family rule were meant to exclude
//! the item itself, its pattern would say so. A Polehammer specialization at level 100 therefore
//! contributes 220 Item Power to a Polehammer and 20 to any other hammer.
//!
//! **The character's Item Power is the mean of six slots**, with a two-handed weapon counted twice
//! because it occupies the off-hand as well, and an empty slot contributing zero without shrinking
//! the divisor. Bags, mounts, food and potions are excluded. This rule is *not* in the dumps; it is
//! the community reading, and it is what fixtures 1 and 6 exist to confirm.
//!
//! Both choices are marked `// CALIBRATION:` at the point they are applied.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::dataset::{combat_item, combat_rules, spec_node};
use super::pattern;
use crate::modules::comps::status::BuildSlot;

/// The six slots whose Item Power the character sheet averages.
///
/// Bags, mounts, food and potions are deliberately absent: they carry no Item Power in the dataset
/// and no reading of the character sheet includes them.
pub const IP_SLOTS: [BuildSlot; 6] = [
    BuildSlot::Weapon,
    BuildSlot::OffHand,
    BuildSlot::Head,
    BuildSlot::Armor,
    BuildSlot::Shoes,
    BuildSlot::Cape,
];

/// One item as the calculator needs it: what it is, and how it was made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquippedItem {
    /// Which of the six counted slots it occupies.
    pub slot: BuildSlot,
    /// Tier-stripped base identifier, e.g. `2H_POLEHAMMER`.
    pub base: String,
    /// Tier 4 through 8.
    pub tier: u8,
    /// Enchantment 0 through 4.
    pub enchantment: u8,
    /// Quality 1 (Normal) through 5 (Masterpiece).
    pub quality: i16,
}

/// A player's Destiny Board levels, keyed by node id rather than by item.
///
/// The `user_specializations` table keys rows by item base (`weapon:2H_BOW`), which is a storage
/// detail of the users module; this module speaks Destiny Board nodes, so the translation happens
/// once, at the boundary, in [`SpecLevels::from_rows`].
#[derive(Debug, Clone, Default)]
pub struct SpecLevels {
    levels: BTreeMap<String, i32>,
}

/// How a stored specialization row is keyed.
///
/// `weapon:` and `armor:` rows name an *item*, which is resolved to its Destiny Board node.
/// `mastery:` rows name a node directly — those are the family levels that are not collected yet,
/// and whose absence makes every figure a lower bound.
const MASTERY_PREFIX: &str = "mastery:";

impl SpecLevels {
    /// Builds a level map from `(node_key, level)` rows as `user_specializations` stores them.
    ///
    /// Rows naming an item the dataset does not know, or an item with no combat specialization —
    /// capes, bags, gathering gear — are dropped rather than failing: they grant no Item Power, so
    /// there is nothing to lose and nothing to report.
    #[must_use]
    pub fn from_rows<'a>(rows: impl IntoIterator<Item = (&'a str, i32)>) -> Self {
        let mut levels = BTreeMap::new();
        for (node_key, level) in rows {
            let Some(node) = resolve_node_key(node_key) else {
                continue;
            };
            // A player can reach the same node through two item rows; the highest wins, matching
            // how `events::service` already reconciles duplicate specialization keys.
            levels
                .entry(node)
                .and_modify(|current: &mut i32| *current = (*current).max(level))
                .or_insert(level);
        }
        Self { levels }
    }

    /// Every node in the game at the given level — the absolute ceiling, not "this build's own".
    ///
    /// Because a family's "+0.2 per level" rule is repeated identically on every sibling node in
    /// that family (see the module docs), this deliberately does **not** equal "max just the
    /// weapon's own specialization plus its mastery": a player who also maxed every sibling hammer
    /// spec contributes that family bonus once per sibling, so the true ceiling is higher than any
    /// single specialization path could reach on its own. That is a real, if extreme, reading of
    /// the Destiny Board — someone who has genuinely mastered the entire game — and it is why
    /// `readiness` should be read as "distance from maxing everything", not "distance from maxing
    /// this one build".
    #[must_use]
    pub fn all_at(level: i32) -> Self {
        Self {
            levels: combat_rules()
                .spec_nodes
                .keys()
                .map(|node| (node.clone(), level))
                .collect(),
        }
    }

    /// The level held in one node, or zero.
    #[must_use]
    pub fn level(&self, node: &str) -> i32 {
        self.levels.get(node).copied().unwrap_or_default()
    }

    /// Whether any family mastery level is known.
    ///
    /// False means the Destiny Board rows only cover leaf specializations, so every Item Power
    /// figure derived from them is a lower bound rather than the number the game would show.
    #[must_use]
    pub fn mastery_levels_known(&self) -> bool {
        self.levels
            .keys()
            .any(|node| spec_node(node).is_some_and(|entry| entry.kind == "mastery"))
    }

    /// A copy with one node set to `level`, for asking what raising it would be worth.
    #[must_use]
    pub fn with_level(&self, node: &str, level: i32) -> Self {
        let mut levels = self.levels.clone();
        levels.insert(node.to_string(), level);
        Self { levels }
    }
}

impl EquippedItem {
    /// The Destiny Board node this item specialises under, if it has one.
    #[must_use]
    pub fn spec_node_id(&self) -> Option<String> {
        combat_item(&self.base)?.spec_node.clone()
    }
}

/// Turns a stored `node_key` into a Destiny Board node id.
fn resolve_node_key(node_key: &str) -> Option<String> {
    if let Some(node) = node_key.strip_prefix(MASTERY_PREFIX) {
        return spec_node(node).map(|_| node.to_string());
    }
    let base = node_key.split_once(':').map_or(node_key, |(_, rest)| rest);
    combat_item(base)?.spec_node.clone()
}

/// One Destiny Board node's contribution to a single item's Item Power.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SpecContribution {
    /// The node id, e.g. `COMBAT_HAMMERS_POLE`.
    pub node: String,
    /// `spec` for a leaf specialization, `mastery` for the family node.
    pub kind: String,
    /// The player's level in that node.
    pub level: i32,
    /// Item Power the node grants this item at that level.
    pub item_power: f64,
}

/// Item Power for one equipped item, itemised so every point can be traced to its source.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ItemIpBreakdown {
    /// The slot this item occupies.
    pub slot: BuildSlot,
    /// Tier-stripped base identifier.
    pub base: String,
    /// Tier 4 through 8.
    pub tier: u8,
    /// Enchantment 0 through 4.
    pub enchantment: u8,
    /// Quality 1 through 5.
    pub quality: i16,
    /// Item Power from tier and enchantment alone.
    pub base_item_power: f64,
    /// Item Power from quality.
    pub quality_bonus: f64,
    /// Item Power from the Destiny Board, summed over [`ItemIpBreakdown::contributions`].
    pub spec_bonus: f64,
    /// The three above, added.
    pub total: f64,
    /// The item's own specialization node, or `None` for capes and bags — which have no combat
    /// specialization at all, so a zero here is a fact rather than a gap.
    pub spec_node: Option<String>,
    /// Every node that contributed, in descending order of what it granted.
    pub contributions: Vec<SpecContribution>,
    /// True when the base identifier is absent from the dataset, so the figure is zero for lack
    /// of data rather than because the item is worth nothing.
    pub unknown_item: bool,
}

/// Item Power across a whole loadout.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CharacterIpBreakdown {
    /// One entry per equipped item, in [`IP_SLOTS`] order.
    pub items: Vec<ItemIpBreakdown>,
    /// The mean over the six counted slots — the figure the character sheet shows.
    pub average: f64,
    /// The sum the mean is taken from, with a two-handed weapon counted twice.
    pub total: f64,
    /// Counted slots the loadout leaves empty. Each still divides into the mean.
    pub empty_slots: Vec<BuildSlot>,
    /// Whether the main hand occupies the off-hand as well.
    pub two_handed: bool,
    /// False when no family mastery level is known, which makes every figure a lower bound.
    pub mastery_levels_known: bool,
}

/// Item Power granted to `item` by every Destiny Board node the player has levels in.
///
/// Rules are filtered by tier gate first and pattern second, and every matching rule on every node
/// contributes — see the module docs for why overlapping rules are summed.
#[must_use]
pub fn spec_contributions(item: &EquippedItem, specs: &SpecLevels) -> Vec<SpecContribution> {
    let unique_name = pattern::unique_name(item.tier, &item.base);
    let mut contributions: Vec<SpecContribution> = Vec::new();

    for (node_id, level) in &specs.levels {
        if *level <= 0 {
            continue;
        }
        let Some(node) = spec_node(node_id) else {
            continue;
        };
        let granted: f64 = node
            .bonuses
            .iter()
            .filter(|rule| (rule.min_tier..=rule.max_tier).contains(&item.tier))
            .filter(|rule| {
                rule.patterns
                    .iter()
                    .any(|glob| pattern::matches(glob, &unique_name))
            })
            // CALIBRATION: overlapping rules on the same node are summed, not maxed. Fixtures 3
            // and 4 are what confirm this against the live game.
            .map(|rule| f64::from(*level) * rule.bonus)
            .sum();

        if granted > 0.0 {
            contributions.push(SpecContribution {
                node: node_id.clone(),
                kind: node.kind.clone(),
                level: *level,
                item_power: granted,
            });
        }
    }

    contributions.sort_by(|a, b| {
        b.item_power
            .partial_cmp(&a.item_power)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.node.cmp(&b.node))
    });
    contributions
}

/// Item Power for one equipped item.
#[must_use]
// Item Power tops out in the low thousands; the i64-to-f64 and usize-to-f64 casts below cannot
// lose precision at that scale.
#[allow(clippy::cast_precision_loss)]
pub fn item_ip(item: &EquippedItem, specs: &SpecLevels) -> ItemIpBreakdown {
    let rules = combat_rules();
    let record = combat_item(&item.base);

    let base_item_power = record
        .and_then(|entry| entry.item_power_at(item.tier, item.enchantment))
        .map_or(0.0, |value| value as f64);
    let quality_bonus = if record.is_some() {
        rules.quality_bonus(item.quality)
    } else {
        0.0
    };
    let contributions = if record.is_some() {
        spec_contributions(item, specs)
    } else {
        Vec::new()
    };
    let spec_bonus: f64 = contributions.iter().map(|entry| entry.item_power).sum();

    ItemIpBreakdown {
        slot: item.slot,
        base: item.base.clone(),
        tier: item.tier,
        enchantment: item.enchantment,
        quality: item.quality,
        base_item_power,
        quality_bonus,
        spec_bonus,
        total: base_item_power + quality_bonus + spec_bonus,
        spec_node: record.and_then(|entry| entry.spec_node.clone()),
        contributions,
        unknown_item: record.is_none(),
    }
}

/// Item Power across a loadout, as the character sheet reports it.
///
/// Items in slots outside [`IP_SLOTS`] are ignored. At most one item per slot is read; a duplicate
/// is dropped rather than double-counted, because the divisor is fixed at six.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn character_ip(items: &[EquippedItem], specs: &SpecLevels) -> CharacterIpBreakdown {
    let mut breakdowns: Vec<ItemIpBreakdown> = Vec::new();
    let mut empty_slots: Vec<BuildSlot> = Vec::new();
    let mut total = 0.0;

    let main_hand = items.iter().find(|item| item.slot == BuildSlot::Weapon);
    let two_handed = main_hand
        .and_then(|item| combat_item(&item.base))
        .is_some_and(|record| record.two_handed);

    for slot in IP_SLOTS {
        let equipped = items.iter().find(|item| item.slot == slot);
        match equipped {
            Some(item) => {
                let breakdown = item_ip(item, specs);
                total += breakdown.total;
                breakdowns.push(breakdown);
            }
            None if slot == BuildSlot::OffHand && two_handed => {
                // CALIBRATION: a two-handed weapon fills the off-hand term with its own Item
                // Power rather than leaving a zero. Fixture 1 is what confirms this.
                if let Some(weapon) = breakdowns
                    .iter()
                    .find(|entry| entry.slot == BuildSlot::Weapon)
                {
                    total += weapon.total;
                }
            }
            None => empty_slots.push(slot),
        }
    }

    let counted = IP_SLOTS.len() as f64;
    CharacterIpBreakdown {
        items: breakdowns,
        average: total / counted,
        total,
        empty_slots,
        two_handed,
        mastery_levels_known: specs.mastery_levels_known(),
    }
}

#[cfg(test)]
mod ip_tests {
    use super::{EquippedItem, IP_SLOTS, SpecLevels, character_ip, item_ip};
    use crate::modules::comps::status::BuildSlot;

    fn item(slot: BuildSlot, base: &str, tier: u8, enchantment: u8, quality: i16) -> EquippedItem {
        EquippedItem {
            slot,
            base: base.to_string(),
            tier,
            enchantment,
            quality,
        }
    }

    fn polehammer(enchantment: u8, quality: i16) -> EquippedItem {
        item(BuildSlot::Weapon, "2H_POLEHAMMER", 8, enchantment, quality)
    }

    fn levels(entries: &[(&str, i32)]) -> SpecLevels {
        SpecLevels::from_rows(entries.iter().map(|(key, level)| (*key, *level)))
    }

    #[test]
    fn a_plain_normal_item_is_worth_its_base_alone() {
        let breakdown = item_ip(&polehammer(0, 1), &SpecLevels::default());
        assert!((breakdown.base_item_power - 1100.0).abs() < f64::EPSILON);
        assert!((breakdown.quality_bonus - 0.0).abs() < f64::EPSILON);
        assert!((breakdown.spec_bonus - 0.0).abs() < f64::EPSILON);
        assert!((breakdown.total - 1100.0).abs() < f64::EPSILON);
        assert!(!breakdown.unknown_item);
    }

    #[test]
    fn enchantment_and_quality_add_the_amounts_the_game_grants() {
        // T8.2 is 1300, Excellent is +60.
        let breakdown = item_ip(&polehammer(2, 4), &SpecLevels::default());
        assert!((breakdown.base_item_power - 1300.0).abs() < f64::EPSILON);
        assert!((breakdown.quality_bonus - 60.0).abs() < f64::EPSILON);
        assert!((breakdown.total - 1360.0).abs() < f64::EPSILON);
    }

    #[test]
    fn masterpiece_is_worth_a_hundred() {
        let breakdown = item_ip(&polehammer(0, 5), &SpecLevels::default());
        assert!((breakdown.total - 1200.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_specialization_grants_its_own_weapon_both_of_its_rules() {
        // Level 100 on the Polehammer node: +2.0 per level from the own-item rule and +0.2 from
        // the family rule, which the polehammer also matches.
        let breakdown = item_ip(&polehammer(0, 1), &levels(&[("weapon:2H_POLEHAMMER", 100)]));
        assert!(
            (breakdown.spec_bonus - 220.0).abs() < 1e-9,
            "expected 220, got {}",
            breakdown.spec_bonus
        );
        assert_eq!(breakdown.contributions.len(), 1);
        assert_eq!(breakdown.contributions[0].node, "COMBAT_HAMMERS_POLE");
        assert_eq!(breakdown.contributions[0].kind, "spec");
    }

    #[test]
    fn a_sibling_specialization_grants_only_the_family_rule() {
        // The Great Hammer node's family rule covers polehammers; its own-item rule does not.
        let breakdown = item_ip(&polehammer(0, 1), &levels(&[("weapon:2H_HAMMER", 100)]));
        assert!(
            (breakdown.spec_bonus - 20.0).abs() < 1e-9,
            "expected 20, got {}",
            breakdown.spec_bonus
        );
    }

    #[test]
    fn a_mastery_level_grants_the_family_rule_on_top() {
        let breakdown = item_ip(
            &polehammer(0, 1),
            &levels(&[
                ("weapon:2H_POLEHAMMER", 100),
                ("mastery:COMBAT_HAMMERS", 100),
            ]),
        );
        assert!(
            (breakdown.spec_bonus - 240.0).abs() < 1e-9,
            "expected 220 + 20, got {}",
            breakdown.spec_bonus
        );
        assert_eq!(breakdown.contributions.len(), 2);
    }

    #[test]
    fn an_unrelated_specialization_grants_nothing() {
        let breakdown = item_ip(&polehammer(0, 1), &levels(&[("weapon:2H_BOW", 100)]));
        assert!((breakdown.spec_bonus - 0.0).abs() < f64::EPSILON);
        assert!(breakdown.contributions.is_empty());
    }

    #[test]
    fn a_level_zero_node_contributes_nothing() {
        let breakdown = item_ip(&polehammer(0, 1), &levels(&[("weapon:2H_POLEHAMMER", 0)]));
        assert!(breakdown.contributions.is_empty());
    }

    #[test]
    fn a_cape_has_no_specialization_and_says_so() {
        let cape = item(BuildSlot::Cape, "CAPE", 8, 2, 4);
        let breakdown = item_ip(&cape, &SpecLevels::all_at(100));
        assert!(breakdown.spec_node.is_none());
        assert!((breakdown.spec_bonus - 0.0).abs() < f64::EPSILON);
        assert!(!breakdown.unknown_item, "the cape itself is in the catalog");
        assert!(breakdown.base_item_power > 0.0);
    }

    #[test]
    fn an_item_the_dataset_does_not_know_is_flagged_rather_than_scored() {
        let ghost = item(BuildSlot::Weapon, "2H_NOT_A_REAL_WEAPON", 8, 2, 4);
        let breakdown = item_ip(&ghost, &SpecLevels::all_at(100));
        assert!(breakdown.unknown_item);
        assert!((breakdown.total - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_two_handed_weapon_counts_for_the_off_hand_too() {
        let specs = SpecLevels::default();
        let full = character_ip(&[polehammer(0, 1)], &specs);
        assert!(full.two_handed);
        // 1100 twice over six slots.
        assert!((full.total - 2200.0).abs() < f64::EPSILON);
        assert!((full.average - 2200.0 / 6.0).abs() < 1e-9);
        // The off-hand is filled by the weapon, so it is not reported empty.
        assert!(!full.empty_slots.contains(&BuildSlot::OffHand));
        assert_eq!(full.empty_slots.len(), 4);
    }

    #[test]
    fn a_one_handed_weapon_leaves_the_off_hand_empty_until_one_is_equipped() {
        let specs = SpecLevels::default();
        let one_handed = item(BuildSlot::Weapon, "MAIN_SWORD", 8, 0, 1);
        let breakdown = character_ip(&[one_handed], &specs);
        assert!(!breakdown.two_handed);
        assert!((breakdown.total - 1100.0).abs() < f64::EPSILON);
        assert!(breakdown.empty_slots.contains(&BuildSlot::OffHand));
        assert_eq!(breakdown.empty_slots.len(), 5);
    }

    #[test]
    fn an_empty_slot_still_divides_into_the_mean() {
        let specs = SpecLevels::default();
        let head = item(BuildSlot::Head, "HEAD_PLATE_SET1", 8, 0, 1);
        let breakdown = character_ip(&[head], &specs);
        assert!((breakdown.average - 1100.0 / 6.0).abs() < 1e-9);
        assert_eq!(breakdown.empty_slots.len(), 5);
    }

    #[test]
    fn a_full_loadout_counts_exactly_six_slots() {
        let specs = SpecLevels::default();
        let loadout = [
            polehammer(0, 1),
            item(BuildSlot::Head, "HEAD_PLATE_SET1", 8, 0, 1),
            item(BuildSlot::Armor, "ARMOR_PLATE_SET1", 8, 0, 1),
            item(BuildSlot::Shoes, "SHOES_PLATE_SET1", 8, 0, 1),
            item(BuildSlot::Cape, "CAPE", 8, 0, 1),
        ];
        let breakdown = character_ip(&loadout, &specs);
        assert!(
            breakdown.empty_slots.is_empty(),
            "the two-hander fills the off-hand"
        );
        assert_eq!(breakdown.items.len(), 5);
        assert!((breakdown.average - breakdown.total / 6.0).abs() < 1e-9);
    }

    #[test]
    fn slots_outside_the_counted_six_are_ignored() {
        let specs = SpecLevels::default();
        let with_bag = [polehammer(0, 1), item(BuildSlot::Bag, "BAG", 8, 0, 1)];
        let without = character_ip(&[polehammer(0, 1)], &specs);
        let with = character_ip(&with_bag, &specs);
        assert!((with.total - without.total).abs() < f64::EPSILON);
    }

    #[test]
    fn mastery_levels_are_reported_as_unknown_until_a_mastery_row_exists() {
        assert!(
            !character_ip(
                &[polehammer(0, 1)],
                &levels(&[("weapon:2H_POLEHAMMER", 100)])
            )
            .mastery_levels_known
        );
        assert!(
            character_ip(
                &[polehammer(0, 1)],
                &levels(&[("mastery:COMBAT_HAMMERS", 100)])
            )
            .mastery_levels_known
        );
    }

    #[test]
    fn the_ceiling_uses_every_node_the_dataset_knows() {
        let ceiling = SpecLevels::all_at(100);
        assert!(ceiling.mastery_levels_known());
        assert_eq!(ceiling.level("COMBAT_HAMMERS_POLE"), 100);
        assert_eq!(ceiling.level("NOT_A_NODE"), 0);
    }

    #[test]
    fn a_row_naming_an_unknown_item_is_dropped_rather_than_failing() {
        let specs = levels(&[
            ("weapon:NOT_A_REAL_ITEM", 100),
            ("weapon:2H_POLEHAMMER", 50),
        ]);
        assert_eq!(specs.level("COMBAT_HAMMERS_POLE"), 50);
    }

    #[test]
    fn the_highest_level_wins_when_two_rows_reach_the_same_node() {
        let specs = levels(&[("weapon:2H_POLEHAMMER", 40), ("2H_POLEHAMMER", 90)]);
        assert_eq!(specs.level("COMBAT_HAMMERS_POLE"), 90);
    }

    #[test]
    fn the_counted_slots_are_the_six_the_character_sheet_shows() {
        assert_eq!(IP_SLOTS.len(), 6);
        assert!(!IP_SLOTS.contains(&BuildSlot::Bag));
        assert!(!IP_SLOTS.contains(&BuildSlot::Mount));
        assert!(!IP_SLOTS.contains(&BuildSlot::Potion));
        assert!(!IP_SLOTS.contains(&BuildSlot::Food));
    }
}
