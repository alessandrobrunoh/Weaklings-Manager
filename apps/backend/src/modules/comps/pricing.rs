//! Live market pricing for builds and comps, via the Albion Online Data Project.
//!
//! Mirrors the pattern already proven by `regear::pricing` (resolve item ids → batch-query
//! Albion Online Data → pick the cheapest listing per item → sum), but sourced from a build's
//! canonical `build_items` rows instead of a kill-feed's frozen equipment JSON — a build's price
//! doesn't depend on what any particular member happened to die in.
//!
//! Lives in `comps`, not `combat`: `combat` is Item Power / Destiny Board math (pure
//! combat-mechanics calculators), which has no conceptual overlap with market economics. Pricing
//! belongs with the comps entities it prices.

use sea_orm::prelude::Decimal;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use std::collections::HashMap;
use std::str::FromStr;

use crate::errors::AppError;
use crate::modules::albiondata::service::{AlbionDataService, cheapest_price_index};
use crate::modules::openalbion::service::aodp_identifier_for_stored_item;
use crate::modules::regear::entities::RegearSettingModel;
use crate::modules::regear::pricing::PricingFallback;

use super::entities::{build, build_item, comp_build};
use super::models::{BuildPriceView, CompBuildPriceRow, CompPriceView, ItemPriceRow};
use super::status::{BuildLoadout, BuildSlot};

/// Prices one build's main loadout live from Albion Online Data.
///
/// Uses `regear_settings.pricing_location`/`pricing_fallback_strategy` — the same "where do we
/// look up market prices" knob the regear workflow already exposes in the admin panel, rather
/// than introducing a second, near-identical settings surface.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] if the build does not exist.
pub async fn price_build(
    db: &DatabaseConnection,
    albiondata: &AlbionDataService,
    build_id: i64,
    settings: &RegearSettingModel,
    server: Option<&str>,
) -> Result<BuildPriceView, AppError> {
    if build::Entity::find_by_id(build_id).one(db).await?.is_none() {
        return Err(AppError::NotFound(format!("build {build_id} not found")));
    }

    let items = build_item::Entity::find()
        .filter(build_item::Column::BuildId.eq(build_id))
        .filter(build_item::Column::Loadout.eq(BuildLoadout::Main.as_str()))
        .all(db)
        .await?;

    let resolved = resolve_identifiers(&items);
    let index = fetch_price_index(albiondata, &resolved, settings, server).await?;

    let mut price_rows = Vec::with_capacity(items.len());
    let mut total = Decimal::ZERO;
    for item in &items {
        let Ok(slot) = BuildSlot::from_str(&item.slot) else {
            continue;
        };
        let Some(identifier) = resolved.get(&item.id) else {
            continue;
        };
        let unit_price = Decimal::from(index.get(identifier).copied().unwrap_or(0));
        total += unit_price;
        price_rows.push(ItemPriceRow {
            slot,
            openalbion_item_id: item.openalbion_item_id,
            openalbion_item_name: item.openalbion_item_name.clone(),
            unit_price,
            city: settings.pricing_location.clone(),
        });
    }

    Ok(BuildPriceView {
        build_id,
        items: price_rows,
        total,
        priced_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Prices every build in a comp, live from Albion Online Data, in one combined market query.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] if the comp does not exist.
pub async fn price_comp(
    db: &DatabaseConnection,
    albiondata: &AlbionDataService,
    comp_id: i64,
    settings: &RegearSettingModel,
    server: Option<&str>,
) -> Result<CompPriceView, AppError> {
    use super::entities::comp;
    if comp::Entity::find_by_id(comp_id).one(db).await?.is_none() {
        return Err(AppError::NotFound(format!("comp {comp_id} not found")));
    }

    let comp_builds = comp_build::Entity::find()
        .filter(comp_build::Column::CompId.eq(comp_id))
        .all(db)
        .await?;
    if comp_builds.is_empty() {
        return Ok(CompPriceView {
            comp_id,
            builds: Vec::new(),
            total: Decimal::ZERO,
            priced_at: chrono::Utc::now().to_rfc3339(),
        });
    }

    let build_ids: Vec<i64> = comp_builds.iter().map(|row| row.build_id).collect();
    let all_items = build_item::Entity::find()
        .filter(build_item::Column::BuildId.is_in(build_ids.clone()))
        .filter(build_item::Column::Loadout.eq(BuildLoadout::Main.as_str()))
        .all(db)
        .await?;
    let builds = build::Entity::find()
        .filter(build::Column::Id.is_in(build_ids))
        .all(db)
        .await?;
    let build_names: HashMap<i64, String> = builds.into_iter().map(|b| (b.id, b.name)).collect();

    // One combined query across every build's items — a comp with several builds must not turn
    // into N separate AODP round trips.
    let resolved = resolve_identifiers(&all_items);
    let index = fetch_price_index(albiondata, &resolved, settings, server).await?;

    let mut items_by_build: HashMap<i64, Vec<&build_item::Model>> = HashMap::new();
    for item in &all_items {
        items_by_build.entry(item.build_id).or_default().push(item);
    }

    let mut rows = Vec::with_capacity(comp_builds.len());
    let mut total = Decimal::ZERO;
    for comp_build_row in &comp_builds {
        let unit_total: Decimal = items_by_build
            .get(&comp_build_row.build_id)
            .into_iter()
            .flatten()
            .filter_map(|item| resolved.get(&item.id))
            .map(|identifier| Decimal::from(index.get(identifier).copied().unwrap_or(0)))
            .sum();
        let subtotal = unit_total * Decimal::from(comp_build_row.quantity);
        total += subtotal;
        rows.push(CompBuildPriceRow {
            build_id: comp_build_row.build_id,
            build_name: build_names
                .get(&comp_build_row.build_id)
                .cloned()
                .unwrap_or_else(|| format!("<build {}>", comp_build_row.build_id)),
            quantity: comp_build_row.quantity,
            unit_total,
            subtotal,
        });
    }

    Ok(CompPriceView {
        comp_id,
        builds: rows,
        total,
        priced_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Resolves each item's AODP market identifier, keyed by the `build_items.id` primary key (not
/// the identifier itself, since two rows can legitimately resolve to the same identifier).
fn resolve_identifiers(items: &[build_item::Model]) -> HashMap<i64, String> {
    items
        .iter()
        .filter_map(|item| {
            aodp_identifier_for_stored_item(
                item.openalbion_item_id,
                item.openalbion_item_icon.as_deref(),
                item.openalbion_item_enchantment,
            )
            .map(|identifier| (item.id, identifier))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use crate::migration::MigratorTrait;
    use crate::modules::comps::entities::{build_category, comp, comp_category};

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection) -> i64 {
        crate::modules::users::entities::ActiveModel {
            username: Set("officer".into()),
            email: Set("officer@example.com".into()),
            role: Set("User".into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    async fn insert_build_with_item(db: &DatabaseConnection, creator: i64) -> i64 {
        let category = build_category::ActiveModel {
            name: Set("Weapons".into()),
            slug: Set("weapons".into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("category")
        .id;
        let build_id = build::ActiveModel {
            name: Set("Broadsword DPS".into()),
            role: Set("dps".into()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build")
        .id;
        build_item::ActiveModel {
            build_id: Set(build_id),
            loadout: Set("main".into()),
            slot: Set("weapon".into()),
            openalbion_item_type: Set("weapon".into()),
            openalbion_item_id: Set(1_129_082_251_177_166_736), // T8_MAIN_SWORD
            openalbion_item_name: Set("Broadsword".into()),
            openalbion_item_icon: Set(None),
            openalbion_item_tier: Set(Some("T8".into())),
            openalbion_item_quality: Set(4),
            openalbion_item_enchantment: Set(0),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build item");
        build_id
    }

    fn settings() -> RegearSettingModel {
        RegearSettingModel {
            id: 1,
            weekly_request_topup_amount: 2,
            weekly_request_cap: 4,
            bonus_request_cap: 10,
            enabled_slots_mask: 0,
            pricing_location: "Caerleon".to_string(),
            pricing_fallback_strategy: "cheapest_any".to_string(),
            updated_at: chrono::Utc::now().into(),
            updated_by_user_id: None,
        }
    }

    /// Whether Albion Online Data is actually reachable from the test sandbox is not something
    /// this test controls — if it fails open (as `regear::pricing` does on a network error), a
    /// priced build/comp still returns its item/build rows with `unit_price = 0`; if the market
    /// really is reachable, a live price comes back instead. Either way, the row shape and the
    /// arithmetic identity (`total` = Σ of the priced items) must hold, so assert only on that
    /// rather than pinning an exact silver figure.
    #[tokio::test]
    async fn price_build_returns_one_priced_row_per_build_item() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let albiondata = AlbionDataService::default();

        let price = price_build(&db, &albiondata, build_id, &settings(), None)
            .await
            .expect("price build");
        assert_eq!(price.build_id, build_id);
        assert_eq!(price.items.len(), 1);
        assert!(price.items[0].unit_price >= Decimal::ZERO);
        assert_eq!(price.total, price.items[0].unit_price);
    }

    #[tokio::test]
    async fn price_build_rejects_an_unknown_build() {
        let db = seed_db().await;
        let albiondata = AlbionDataService::default();
        let error = price_build(&db, &albiondata, 999, &settings(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn price_comp_sums_build_subtotals_by_quantity() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let category = comp_category::ActiveModel {
            name: Set("10v10".into()),
            slug: Set("10v10".into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp category")
        .id;
        let comp_id = comp::ActiveModel {
            name: Set("Test Comp".into()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp")
        .id;
        comp_build::ActiveModel {
            comp_id: Set(comp_id),
            build_id: Set(build_id),
            quantity: Set(3),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp build");

        let albiondata = AlbionDataService::default();
        let price = price_comp(&db, &albiondata, comp_id, &settings(), None)
            .await
            .expect("price comp");
        assert_eq!(price.builds.len(), 1);
        assert_eq!(price.builds[0].quantity, 3);
        // Whatever the live/fallback unit price turns out to be, the arithmetic must hold:
        // subtotal = unit_total * quantity, and the comp total is the sum of subtotals.
        assert_eq!(
            price.builds[0].subtotal,
            price.builds[0].unit_total * Decimal::from(3)
        );
        assert_eq!(price.total, price.builds[0].subtotal);
    }

    #[tokio::test]
    async fn price_comp_with_no_builds_returns_zero_total() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let category = comp_category::ActiveModel {
            name: Set("Empty".into()),
            slug: Set("empty".into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp category")
        .id;
        let comp_id = comp::ActiveModel {
            name: Set("Empty Comp".into()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp")
        .id;

        let albiondata = AlbionDataService::default();
        let price = price_comp(&db, &albiondata, comp_id, &settings(), None)
            .await
            .expect("price comp");
        assert!(price.builds.is_empty());
        assert_eq!(price.total, Decimal::ZERO);
    }
}

/// Batches every resolved identifier through Albion Online Data once, honoring the configured
/// pricing location and fallback strategy — the same lookup shape `regear::pricing` uses.
async fn fetch_price_index(
    albiondata: &AlbionDataService,
    resolved: &HashMap<i64, String>,
    settings: &RegearSettingModel,
    server: Option<&str>,
) -> Result<HashMap<String, i64>, AppError> {
    if resolved.is_empty() {
        return Ok(HashMap::new());
    }
    let mut unique_ids: Vec<String> = resolved
        .values()
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
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

    Ok(cheapest_price_index(&prices, &fallback_prices))
}
