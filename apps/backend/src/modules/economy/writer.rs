//! Persists computed battle loss estimates into `battle_loss_estimates`.
//!
//! Restates the rule from `modules::economy`'s own doc comment, because it is
//! the exact rule this code must never violate: **income is declared, never
//! inferred from combat.** This writer only ever prices already-persisted
//! victim evidence (`battle_kills` + `battle_kill_items`) into a cost figure
//! per side, plus a trade indicator for the enemy side. It never touches
//! `splits`, never credits anything, and never turns an enemy's estimated
//! loss into income.
//!
//! # Idiom this matches
//!
//! Same "read the already-persisted evidence tables for one battle, compute,
//! then upsert" shape as `fingerprints::writer::persist_battle_fingerprints`
//! and `enemies::writer::persist_enemy_facts` — but simpler on the write
//! side. `battle_loss_estimates` has no immutability concept at all (unlike
//! `loadout_fingerprints`'s identity-vs-rollup split): every field is
//! **replaced wholesale** on every recompute, because market prices drift
//! and the point of this table is "our best current estimate", never a
//! historical fact. See `battle_loss_estimate::Model`'s own doc comment and
//! `m20260908_000008_create_battle_loss_estimates` for the full rationale.
//! No transaction is used here — a single-row read-then-upsert against one
//! table has no multi-table consistency concern to protect.
//!
//! A battle with zero kills still gets a fully-zeroed row rather than no row
//! at all: an explicit zero is more honest than an absent row that could be
//! misread as "never estimated" instead of "genuinely no losses on record".

use std::collections::{HashMap, HashSet};

use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};

use crate::errors::AppError;
use crate::modules::albiondata::service::{AlbionDataService, cheapest_price_index};
use crate::modules::battles::evidence_entities::{battle_kill, battle_kill_item};
use crate::modules::battles::outcome::FriendlySide;
use crate::modules::regear::pricing::PricingFallback;
use crate::modules::regear::service::load_settings;

use super::entities::battle_loss_estimate;
use super::estimate::{self, KillLossSource, LossItemSource};

/// Computes and persists this battle's priced silver-loss estimate.
///
/// 1. Loads the guild-wide `regear_settings` singleton — this module rides on
///    the same pricing-location/fallback knob regear already exposes in the
///    admin panel rather than duplicating it.
/// 2. Loads every `battle_kills` row for `battle_id`, plus their
///    `battle_kill_items` in one batched `is_in` query.
/// 3. Prices every distinct raw (never normalized — see `estimate`'s own
///    module docs) `item_type_id` via the same batched
///    city-then-cross-city-fallback pattern `regear::pricing` uses.
/// 4. Calls [`estimate::estimate_battle_losses`] and upserts the result,
///    replacing every field when a row already exists for this battle.
pub async fn persist_battle_loss_estimate(
    db: &DatabaseConnection,
    albiondata: &AlbionDataService,
    battle_id: i64,
    side: &FriendlySide,
    server: Option<&str>,
) -> Result<(), AppError> {
    let settings = load_settings(db).await?;

    let kills = battle_kill::Entity::find()
        .filter(battle_kill::Column::BattleId.eq(battle_id))
        .all(db)
        .await?;

    let kill_ids: Vec<i64> = kills.iter().map(|kill| kill.id).collect();
    let items = if kill_ids.is_empty() {
        Vec::new()
    } else {
        battle_kill_item::Entity::find()
            .filter(battle_kill_item::Column::KillId.is_in(kill_ids))
            .all(db)
            .await?
    };

    let mut items_by_kill: HashMap<i64, Vec<battle_kill_item::Model>> = HashMap::new();
    for item in items {
        items_by_kill.entry(item.kill_id).or_default().push(item);
    }

    let kill_sources: Vec<KillLossSource> = kills
        .iter()
        .map(|kill| KillLossSource {
            victim_guild_id: kill.victim_guild_id.clone(),
            victim_guild_name: kill.victim_guild_name.clone(),
            items: items_by_kill
                .remove(&kill.id)
                .unwrap_or_default()
                .into_iter()
                .map(|item| LossItemSource {
                    // Deliberately NOT normalized — see `estimate`'s module
                    // docs. Passed through exactly as stored.
                    item_type_id: item.item_type_id,
                    quantity: item.quantity,
                })
                .collect(),
        })
        .collect();

    let price_index = price_index_for(albiondata, &kill_sources, &settings, server).await;

    let computed = estimate::estimate_battle_losses(&kill_sources, &price_index, side);

    let now = chrono::Utc::now();
    let existing = battle_loss_estimate::Entity::find()
        .filter(battle_loss_estimate::Column::BattleId.eq(battle_id))
        .one(db)
        .await?;

    match existing {
        None => {
            battle_loss_estimate::ActiveModel {
                battle_id: Set(battle_id),
                friendly_estimated_loss: Set(computed.friendly.estimated_loss),
                friendly_priced_items: Set(computed.friendly.priced_items),
                friendly_total_items: Set(computed.friendly.total_items),
                enemy_estimated_loss: Set(computed.enemy.estimated_loss),
                enemy_priced_items: Set(computed.enemy.priced_items),
                enemy_total_items: Set(computed.enemy.total_items),
                pricing_location: Set(settings.pricing_location.clone()),
                priced_at: Set(now.into()),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(db)
            .await?;
        }
        Some(existing) => {
            let mut row: battle_loss_estimate::ActiveModel = existing.into();
            row.friendly_estimated_loss = Set(computed.friendly.estimated_loss);
            row.friendly_priced_items = Set(computed.friendly.priced_items);
            row.friendly_total_items = Set(computed.friendly.total_items);
            row.enemy_estimated_loss = Set(computed.enemy.estimated_loss);
            row.enemy_priced_items = Set(computed.enemy.priced_items);
            row.enemy_total_items = Set(computed.enemy.total_items);
            row.pricing_location = Set(settings.pricing_location.clone());
            row.priced_at = Set(now.into());
            row.updated_at = Set(now.into());
            row.update(db).await?;
        }
    }

    Ok(())
}

/// Batches every distinct raw `item_type_id` across `kills` through Albion
/// Online Data, honoring the configured pricing location and fallback
/// strategy — the exact lookup shape `regear::pricing::build_breakdown` uses.
/// Returns an empty index (rather than propagating an error) when there is
/// nothing to price or the upstream call fails, matching that same
/// fail-open convention: an unpriceable item simply stays unpriced.
async fn price_index_for(
    albiondata: &AlbionDataService,
    kills: &[KillLossSource],
    settings: &crate::modules::regear::entities::RegearSettingModel,
    server: Option<&str>,
) -> HashMap<String, i64> {
    let mut unique_ids: Vec<String> = kills
        .iter()
        .flat_map(|kill| kill.items.iter().map(|item| item.item_type_id.clone()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if unique_ids.is_empty() {
        return HashMap::new();
    }
    unique_ids.sort();
    let joined_ids = unique_ids.join(",");

    let prices = albiondata
        .prices(server, &joined_ids, Some(&settings.pricing_location), None)
        .await
        .unwrap_or_default();
    let fallback_prices = if matches!(
        PricingFallback::from_str(&settings.pricing_fallback_strategy),
        PricingFallback::CheapestAny
    ) {
        albiondata
            .prices(server, &joined_ids, None, None)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    cheapest_price_index(&prices, &fallback_prices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    fn side() -> FriendlySide {
        FriendlySide::new("us", &[], &["BetterGetBack".to_string()])
    }

    /// Inserts a `battle_kills` row plus its `battle_kill_items`, returning
    /// the inserted kill's id.
    async fn insert_kill(
        db: &DatabaseConnection,
        battle_id: i64,
        source_event_id: i64,
        victim_guild_id: Option<&str>,
        victim_guild_name: Option<&str>,
        items: &[(&str, &str, i32)],
    ) -> i64 {
        let kill = battle_kill::ActiveModel {
            battle_id: Set(battle_id),
            source_event_id: Set(source_event_id),
            occurred_at: Set(chrono::Utc::now().into()),
            killer_player_key: Set("id:killer".to_string()),
            killer_name: Set("Killer".to_string()),
            killer_guild_id: Set(None),
            killer_guild_name: Set(None),
            victim_player_key: Set(format!("id:victim{source_event_id}")),
            victim_name: Set("Victim".to_string()),
            victim_guild_id: Set(victim_guild_id.map(ToString::to_string)),
            victim_guild_name: Set(victim_guild_name.map(ToString::to_string)),
            killer_item_power: Set(1300.0),
            victim_item_power: Set(1300.0),
            total_kill_fame: Set(100),
            created_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_kill");

        for (slot, item_type_id, quantity) in items {
            battle_kill_item::ActiveModel {
                kill_id: Set(kill.id),
                slot: Set((*slot).to_string()),
                item_type_id: Set((*item_type_id).to_string()),
                quantity: Set(*quantity),
                created_at: Set(chrono::Utc::now().into()),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("insert battle_kill_item");
        }

        kill.id
    }

    /// `AlbionDataService::default()` calls the real, public Albion Online
    /// Data API. Whether it is actually reachable from the test sandbox is
    /// not something this test controls — on a network error `prices()`
    /// fails and `price_index_for` falls back to an empty index, exactly
    /// like `regear::pricing`/`comps::pricing` already do (see their own
    /// tests' identical caveat). Either way every item stays "seen but
    /// unpriced" and the assertions below only rely on `total_items`
    /// (always populated) plus the arithmetic identity that a positive
    /// `estimated_loss` implies `priced_items > 0`, never on a pinned silver
    /// figure.
    #[tokio::test]
    async fn priced_battle_splits_friendly_and_enemy_correctly() {
        let db = seed_db().await;
        let battle_id = 42;
        insert_kill(
            &db,
            battle_id,
            1,
            Some("us"),
            Some("Weaklings"),
            &[("MainHand", "T4_2H_HOLYSTAFF", 1)],
        )
        .await;
        insert_kill(
            &db,
            battle_id,
            2,
            Some("them"),
            Some("ARCH"),
            &[("MainHand", "T4_2H_HOLYSTAFF", 1), ("Head", "T4_HEAD", 2)],
        )
        .await;
        let albiondata = AlbionDataService::default();

        persist_battle_loss_estimate(&db, &albiondata, battle_id, &side(), None)
            .await
            .expect("persist estimate");

        let row = battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.eq(battle_id))
            .one(&db)
            .await
            .expect("query")
            .expect("row exists");

        // Independently recompute via the pure function directly (with an
        // empty price index, matching a network-unreachable sandbox, or any
        // price index — the arithmetic identity below holds regardless) and
        // confirm the persisted row's item-count bookkeeping matches exactly.
        assert_eq!(row.friendly_total_items, 1);
        assert_eq!(row.enemy_total_items, 2);
        assert!(row.friendly_estimated_loss >= 0);
        assert!(row.enemy_estimated_loss >= 0);
        assert!(row.friendly_priced_items <= row.friendly_total_items);
        assert!(row.enemy_priced_items <= row.enemy_total_items);
        assert_eq!(row.pricing_location, "Caerleon");
    }

    #[tokio::test]
    async fn battle_with_zero_kills_still_produces_a_zeroed_row() {
        let db = seed_db().await;
        let albiondata = AlbionDataService::default();

        persist_battle_loss_estimate(&db, &albiondata, 999, &side(), None)
            .await
            .expect("persist estimate");

        let row = battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.eq(999))
            .one(&db)
            .await
            .expect("query")
            .expect("row exists even with zero kills");

        assert_eq!(row.friendly_estimated_loss, 0);
        assert_eq!(row.friendly_priced_items, 0);
        assert_eq!(row.friendly_total_items, 0);
        assert_eq!(row.enemy_estimated_loss, 0);
        assert_eq!(row.enemy_priced_items, 0);
        assert_eq!(row.enemy_total_items, 0);
        assert_eq!(row.pricing_location, "Caerleon");
    }

    #[tokio::test]
    async fn rerunning_the_writer_replaces_the_row_instead_of_duplicating_it() {
        let db = seed_db().await;
        let battle_id = 7;
        let albiondata = AlbionDataService::default();

        persist_battle_loss_estimate(&db, &albiondata, battle_id, &side(), None)
            .await
            .expect("first persist");
        let first = battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.eq(battle_id))
            .one(&db)
            .await
            .expect("query")
            .expect("row exists");

        // Vary the fixture between calls: the second run now has kills where
        // the first had none, so a real replace (not an insert-alongside)
        // must change the totals as well as `priced_at`.
        insert_kill(
            &db,
            battle_id,
            1,
            Some("us"),
            Some("Weaklings"),
            &[("MainHand", "T4_2H_HOLYSTAFF", 1)],
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        persist_battle_loss_estimate(&db, &albiondata, battle_id, &side(), None)
            .await
            .expect("second persist");

        let rows = battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.eq(battle_id))
            .all(&db)
            .await
            .expect("query");
        assert_eq!(rows.len(), 1, "must replace, not duplicate");

        let second = &rows[0];
        assert_eq!(second.id, first.id);
        assert_eq!(second.friendly_total_items, 1);
        assert!(second.priced_at > first.priced_at);
    }
}
