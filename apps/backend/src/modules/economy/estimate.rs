//! Priced silver-loss estimation for one battle, split by side.
//!
//! This module restates the rule from `modules::economy`'s own doc comment,
//! because it is the exact rule this code must never violate: **income is
//! declared, never inferred from combat.** Nothing here produces income. It
//! only prices already-persisted kill/item evidence (`battle_kills` +
//! `battle_kill_items`) into a silver-loss total, split into `friendly` and
//! `enemy` sides.
//!
//! The `enemy` total is a **trade indicator only** — it answers "were we
//! winning the silver exchange in this fight?" — and it must never be summed
//! into any revenue/income figure anywhere in this codebase. It is not our
//! money, not a credit, not a gain; it is an estimate of what the other side
//! lost, kept for comparison against `friendly` and nothing else.
//!
//! This module is pure and DB-free: it takes already-fetched evidence plus a
//! price index and returns a plain result struct. It does not touch SeaORM,
//! run migrations, or make HTTP calls, and it is not wired into any
//! service/router/ingestion path.
//!
//! # Item id lookups are never normalized
//!
//! Market price is tier/enchantment-*dependent* (a T4 and a T8 of the same
//! weapon have wildly different values), so every lookup in this module is
//! keyed on the exact, raw upstream item id string as stored verbatim in
//! `battle_kill_item.item_type_id` — the same string
//! `albiondata::service::cheapest_price_index` keys its map by. This mirrors
//! `regear::pricing`, which prices a victim's raw kill-feed equipment the same
//! way, and is the opposite of `fingerprints::compute`, which strips
//! tier/enchantment via `intel::roles::normalize_item_id` for *build
//! matching* (a different problem, where two tiers of the same weapon should
//! count as the same build). This file must never import or use
//! `normalize_item_id`.

use std::collections::HashMap;

use crate::modules::battles::outcome::FriendlySide;

/// One item stack from a victim's death equipment, as observed. `item_type_id`
/// is the RAW upstream string — never normalized (see the module docs).
#[derive(Debug, Clone)]
pub struct LossItemSource {
    pub item_type_id: String,
    pub quantity: i32,
}

/// One kill, scoped to just the victim's side and their equipment — this
/// module never needs the killer's identity.
#[derive(Debug, Clone)]
pub struct KillLossSource {
    pub victim_guild_id: Option<String>,
    pub victim_guild_name: Option<String>,
    pub items: Vec<LossItemSource>,
}

/// One side's (ours or the enemy's) priced loss total for a battle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SideLossEstimate {
    pub estimated_loss: i64,
    pub priced_items: i32,
    pub total_items: i32,
}

/// Both sides' loss estimates for one battle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BattleLossEstimate {
    pub friendly: SideLossEstimate,
    /// A trade indicator ONLY — see the module docs. Never sum this into any
    /// income/revenue figure.
    pub enemy: SideLossEstimate,
}

/// Prices every kill's victim equipment and splits the total by side.
///
/// Every kill's victim is classified as friendly or enemy via
/// [`FriendlySide::contains`], which always returns a definite `bool` — there
/// is no third, unresolved bucket here.
///
/// For each item stack: `total_items` on the victim's side always increments
/// by one, regardless of whether a price was found. When `prices` has a
/// positive entry for the item's raw `item_type_id`, `priced_items` also
/// increments and `estimated_loss` grows by `unit_price * quantity`. When the
/// price is absent or zero, the stack is silently under-priced (contributes
/// `0`) rather than fabricated — the same convention already established by
/// `regear::pricing` and `comps::pricing`.
///
/// A non-positive `quantity` — a pathological upstream value — is treated as
/// `1` rather than allowed to zero out or negate the contribution.
#[must_use]
pub fn estimate_battle_losses(
    kills: &[KillLossSource],
    prices: &HashMap<String, i64>,
    side: &FriendlySide,
) -> BattleLossEstimate {
    let mut result = BattleLossEstimate::default();

    for kill in kills {
        let is_friendly = side.contains(
            kill.victim_guild_id.as_deref().unwrap_or_default(),
            kill.victim_guild_name.as_deref().unwrap_or_default(),
        );
        let bucket = if is_friendly {
            &mut result.friendly
        } else {
            &mut result.enemy
        };

        for item in &kill.items {
            bucket.total_items += 1;
            let Some(unit_price) = prices.get(&item.item_type_id).copied() else {
                continue;
            };
            if unit_price <= 0 {
                continue;
            }
            let quantity = i64::from(item.quantity.max(1));
            bucket.priced_items += 1;
            bucket.estimated_loss += unit_price * quantity;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side() -> FriendlySide {
        FriendlySide::new("us", &[], &["BetterGetBack".to_string()])
    }

    fn item(item_type_id: &str, quantity: i32) -> LossItemSource {
        LossItemSource {
            item_type_id: item_type_id.to_string(),
            quantity,
        }
    }

    fn kill(guild_id: &str, guild_name: &str, items: Vec<LossItemSource>) -> KillLossSource {
        KillLossSource {
            victim_guild_id: Some(guild_id.to_string()),
            victim_guild_name: Some(guild_name.to_string()),
            items,
        }
    }

    #[test]
    fn friendly_victim_items_go_to_friendly_not_enemy() {
        let kills = [kill("us", "Weaklings", vec![item("T4_2H_HOLYSTAFF", 1)])];
        let prices = HashMap::from([("T4_2H_HOLYSTAFF".to_string(), 1_000)]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.friendly.estimated_loss, 1_000);
        assert_eq!(result.friendly.total_items, 1);
        assert_eq!(result.enemy, SideLossEstimate::default());
    }

    #[test]
    fn enemy_victim_items_go_to_enemy_not_friendly() {
        let kills = [kill("them", "ARCH", vec![item("T4_2H_HOLYSTAFF", 1)])];
        let prices = HashMap::from([("T4_2H_HOLYSTAFF".to_string(), 1_000)]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 1_000);
        assert_eq!(result.enemy.total_items, 1);
        assert_eq!(result.friendly, SideLossEstimate::default());
    }

    #[test]
    fn priced_item_increments_priced_and_total_items() {
        let kills = [kill("them", "ARCH", vec![item("T4_2H_HOLYSTAFF", 2)])];
        let prices = HashMap::from([("T4_2H_HOLYSTAFF".to_string(), 500)]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 1_000);
        assert_eq!(result.enemy.priced_items, 1);
        assert_eq!(result.enemy.total_items, 1);
    }

    #[test]
    fn missing_price_still_counts_total_items_but_not_priced_items() {
        let kills = [kill("them", "ARCH", vec![item("T4_UNKNOWN_ITEM", 3)])];
        let prices = HashMap::new();
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 0);
        assert_eq!(result.enemy.priced_items, 0);
        assert_eq!(result.enemy.total_items, 1);
    }

    #[test]
    fn zero_price_is_treated_like_a_missing_price() {
        let kills = [kill("them", "ARCH", vec![item("T4_ZERO_PRICED", 5)])];
        let prices = HashMap::from([("T4_ZERO_PRICED".to_string(), 0)]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 0);
        assert_eq!(result.enemy.priced_items, 0);
        assert_eq!(result.enemy.total_items, 1);
    }

    #[test]
    fn quantity_multiplies_the_contribution() {
        let kills = [kill("them", "ARCH", vec![item("T6_BAG", 5)])];
        let prices = HashMap::from([("T6_BAG".to_string(), 1_000)]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 5_000);
    }

    /// Proves no tier-stripping happens: the same base weapon at two
    /// different tiers/enchantments must price independently, using the raw,
    /// unstripped item id as the lookup key.
    #[test]
    fn raw_unstripped_item_id_prices_each_tier_independently() {
        let kills = [
            kill("them", "ARCH", vec![item("T4_2H_HOLYSTAFF", 1)]),
            kill("them", "ARCH", vec![item("T8_2H_HOLYSTAFF_MORGANA@3", 1)]),
        ];
        let prices = HashMap::from([
            ("T4_2H_HOLYSTAFF".to_string(), 800),
            ("T8_2H_HOLYSTAFF_MORGANA@3".to_string(), 2_500_000),
        ]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 800 + 2_500_000);
        assert_eq!(result.enemy.priced_items, 2);
    }

    #[test]
    fn multiple_kills_across_both_sides_accumulate_independently() {
        let kills = [
            kill("us", "Weaklings", vec![item("A", 1), item("B", 1)]),
            kill("them", "ARCH", vec![item("C", 1)]),
            kill("us", "Weaklings", vec![item("D", 2)]),
            kill("them", "ARCH", vec![item("E", 3)]),
        ];
        let prices = HashMap::from([
            ("A".to_string(), 100),
            ("B".to_string(), 200),
            ("C".to_string(), 300),
            ("D".to_string(), 400),
            ("E".to_string(), 500),
        ]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.friendly.estimated_loss, 100 + 200 + 400 * 2);
        assert_eq!(result.friendly.total_items, 3);
        assert_eq!(result.enemy.estimated_loss, 300 + 500 * 3);
        assert_eq!(result.enemy.total_items, 2);
    }

    #[test]
    fn empty_kills_produce_a_fully_zeroed_estimate() {
        let result = estimate_battle_losses(&[], &HashMap::new(), &side());
        assert_eq!(result, BattleLossEstimate::default());
    }

    /// Defensive requirement, not a hypothetical: a pathological zero or
    /// negative `quantity` from upstream must be treated as `1`, never
    /// producing a zero/negative contribution or a panic.
    #[test]
    fn pathological_quantity_is_treated_as_one() {
        let kills = [kill(
            "them",
            "ARCH",
            vec![item("T4_ZERO_QTY", 0), item("T4_NEGATIVE_QTY", -5)],
        )];
        let prices = HashMap::from([
            ("T4_ZERO_QTY".to_string(), 1_000),
            ("T4_NEGATIVE_QTY".to_string(), 1_000),
        ]);
        let result = estimate_battle_losses(&kills, &prices, &side());

        assert_eq!(result.enemy.estimated_loss, 1_000 + 1_000);
        assert_eq!(result.enemy.priced_items, 2);
        assert_eq!(result.enemy.total_items, 2);
    }
}
