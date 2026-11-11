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
//!
//! Price lookups are not quality-aware: the market query passes no quality filter, so a build
//! item is priced at the cheapest listing of its tier and enchantment across every quality. The
//! figure is a lower bound for an Excellent or Masterpiece piece.
//!
//! A market failure is an error, never a price: the lookups propagate it so the router answers
//! with an error and caches nothing, instead of showing (and caching) a zero-silver build.

use sea_orm::prelude::Decimal;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use std::collections::HashMap;
use std::future::Future;
use std::str::FromStr;

use crate::errors::AppError;
use crate::modules::albiondata::client::AlbionDataMarketPrice;
use crate::modules::albiondata::service::{AlbionDataService, cheapest_price_index};
use crate::modules::openalbion::service::aodp_identifier_for_stored_item;
use crate::modules::regear::entities::RegearSettingModel;
use crate::modules::regear::pricing::PricingFallback;

use super::models::{BuildPriceView, CompBuildPriceRow, CompPriceView, ItemPriceRow};
use super::price_cache::PriceCache;
use crate::modules::comps::entities::{build, build_item, comp_build};
use crate::modules::comps::status::{BuildLoadout, BuildSlot};

/// Where market prices come from. Production uses [`AlbionDataService`]; tests substitute a stub
/// so the failure paths can be exercised without a network.
pub trait PriceSource: Sync {
    /// Fetches current market listings for a comma-separated item list.
    fn prices(
        &self,
        server: Option<&str>,
        items: &str,
        locations: Option<&str>,
    ) -> impl Future<Output = Result<Vec<AlbionDataMarketPrice>, AppError>> + Send;
}

impl PriceSource for AlbionDataService {
    fn prices(
        &self,
        server: Option<&str>,
        items: &str,
        locations: Option<&str>,
    ) -> impl Future<Output = Result<Vec<AlbionDataMarketPrice>, AppError>> + Send {
        AlbionDataService::prices(self, server, items, locations, None)
    }
}

/// Prices one build's main loadout live from Albion Online Data.
///
/// Uses `regear_settings.pricing_location`/`pricing_fallback_strategy` — the same "where do we
/// look up market prices" knob the regear workflow already exposes in the admin panel, rather
/// than introducing a second, near-identical settings surface.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] if the build does not exist, and the market lookup's error when
/// Albion Online Data cannot be reached (a failed lookup is never turned into zero prices).
pub async fn price_build(
    db: &DatabaseConnection,
    albiondata: &impl PriceSource,
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
    let mut unpriced_item_count = 0_u32;
    for item in &items {
        let Ok(slot) = BuildSlot::from_str(&item.slot) else {
            unpriced_item_count += 1;
            continue;
        };
        let Some(identifier) = resolved.get(&item.id) else {
            unpriced_item_count += 1;
            continue;
        };
        let unit_price = Decimal::from(index.get(identifier).copied().unwrap_or(0));
        if unit_price.is_zero() {
            unpriced_item_count += 1;
        }
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
        unpriced_item_count,
        priced_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Prices every build in a comp, live from Albion Online Data, in one combined market query.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] if the comp does not exist, and the market lookup's error when
/// Albion Online Data cannot be reached.
pub async fn price_comp(
    db: &DatabaseConnection,
    albiondata: &impl PriceSource,
    comp_id: i64,
    settings: &RegearSettingModel,
    server: Option<&str>,
) -> Result<CompPriceView, AppError> {
    use crate::modules::comps::entities::comp;
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
            unpriced_item_count: 0,
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
    let mut unpriced_item_count = 0_u32;
    for comp_build_row in &comp_builds {
        let mut unit_total = Decimal::ZERO;
        let mut build_unpriced = 0_u32;
        for item in items_by_build
            .get(&comp_build_row.build_id)
            .into_iter()
            .flatten()
        {
            let unit_price = resolved
                .get(&item.id)
                .and_then(|identifier| index.get(identifier))
                .copied()
                .unwrap_or(0);
            if unit_price == 0 {
                build_unpriced += 1;
            }
            unit_total += Decimal::from(unit_price);
        }
        let subtotal = unit_total * Decimal::from(comp_build_row.quantity);
        total += subtotal;
        unpriced_item_count = unpriced_item_count.saturating_add(
            build_unpriced.saturating_mul(u32::try_from(comp_build_row.quantity).unwrap_or(0)),
        );
        rows.push(CompBuildPriceRow {
            build_id: comp_build_row.build_id,
            build_name: build_names
                .get(&comp_build_row.build_id)
                .cloned()
                .unwrap_or_else(|| format!("<build {}>", comp_build_row.build_id)),
            quantity: comp_build_row.quantity,
            unit_total,
            subtotal,
            unpriced_item_count: build_unpriced,
        });
    }

    Ok(CompPriceView {
        comp_id,
        builds: rows,
        total,
        unpriced_item_count,
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

/// Batches every resolved identifier through Albion Online Data once, honoring the configured
/// pricing location and fallback strategy — the same lookup shape `regear::pricing` uses.
///
/// The configured-city and fallback queries run concurrently. Either failing fails the whole
/// lookup: an outage must surface as an error, not as "no listings".
async fn fetch_price_index(
    source: &impl PriceSource,
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

    let wants_fallback = matches!(
        PricingFallback::from_str(&settings.pricing_fallback_strategy),
        PricingFallback::CheapestAny
    );
    let (prices, fallback_prices) = tokio::try_join!(
        source.prices(server, &joined_ids, Some(&settings.pricing_location)),
        async {
            if wants_fallback {
                source.prices(server, &joined_ids, None).await
            } else {
                Ok(Vec::new())
            }
        }
    )?;

    Ok(cheapest_price_index(&prices, &fallback_prices))
}

/// A build's price, served from `cache` when fresh and otherwise computed and stored.
///
/// Only a successful computation is stored: a market failure propagates and leaves the cache
/// untouched, so the next request retries the market instead of replaying a bad result.
///
/// # Errors
///
/// Same as [`price_build`].
pub async fn cached_build_price(
    cache: &PriceCache,
    tenant_id: &str,
    db: &DatabaseConnection,
    source: &impl PriceSource,
    build_id: i64,
    settings: &RegearSettingModel,
) -> Result<BuildPriceView, AppError> {
    if let Some(cached) = cache.get_build(tenant_id, &settings.pricing_location, build_id) {
        return Ok(cached);
    }
    let epoch = cache.epoch();
    let view = price_build(db, source, build_id, settings, None).await?;
    cache.put_build(epoch, tenant_id, &settings.pricing_location, build_id, &view);
    Ok(view)
}

/// A comp's price, cached exactly like [`cached_build_price`].
///
/// # Errors
///
/// Same as [`price_comp`].
pub async fn cached_comp_price(
    cache: &PriceCache,
    tenant_id: &str,
    db: &DatabaseConnection,
    source: &impl PriceSource,
    comp_id: i64,
    settings: &RegearSettingModel,
) -> Result<CompPriceView, AppError> {
    if let Some(cached) = cache.get_comp(tenant_id, &settings.pricing_location, comp_id) {
        return Ok(cached);
    }
    let epoch = cache.epoch();
    let view = price_comp(db, source, comp_id, settings, None).await?;
    cache.put_comp(epoch, tenant_id, &settings.pricing_location, comp_id, &view);
    Ok(view)
}

/// Drops the cached prices an edit to `build_id` makes stale: the build's own and those of every
/// comp that contains it. Call it after any successful change to the build's items or to the
/// comps that include it.
pub async fn evict_build_prices(
    cache: &PriceCache,
    db: &DatabaseConnection,
    tenant_id: &str,
    build_id: i64,
) {
    cache.invalidate_build(tenant_id, build_id);
    match comp_build::Entity::find()
        .filter(comp_build::Column::BuildId.eq(build_id))
        .all(db)
        .await
    {
        Ok(rows) => {
            for row in rows {
                cache.invalidate_comp(tenant_id, row.comp_id);
            }
        }
        // Cannot tell which comps contain the build: dropping all of them is always safe.
        Err(_) => cache.invalidate_all_comps(tenant_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    use crate::modules::comps::entities::{build_category, comp, comp_category};

    async fn seed_db() -> DatabaseConnection {
        crate::testkit::migrated_sqlite().await
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

    /// Scripted market: returns fixed listings, or fails every call, and counts the calls.
    struct StubSource {
        listings: Vec<AlbionDataMarketPrice>,
        fail: std::sync::atomic::AtomicBool,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl StubSource {
        fn with_listings(listings: Vec<AlbionDataMarketPrice>) -> Self {
            Self {
                listings,
                fail: std::sync::atomic::AtomicBool::new(false),
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn failing() -> Self {
            let stub = Self::with_listings(Vec::new());
            stub.fail.store(true, std::sync::atomic::Ordering::SeqCst);
            stub
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl PriceSource for StubSource {
        async fn prices(
            &self,
            _server: Option<&str>,
            _items: &str,
            _locations: Option<&str>,
        ) -> Result<Vec<AlbionDataMarketPrice>, AppError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(AppError::Internal("market unreachable".to_string()));
            }
            Ok(self.listings.clone())
        }
    }

    fn listing(item_id: &str, price: i64) -> AlbionDataMarketPrice {
        AlbionDataMarketPrice {
            item_id: item_id.to_string(),
            city: "Caerleon".to_string(),
            quality: 1,
            sell_price_min: price,
            sell_price_min_date: None,
            sell_price_max: price,
            sell_price_max_date: None,
            buy_price_min: 0,
            buy_price_min_date: None,
            buy_price_max: 0,
            buy_price_max_date: None,
        }
    }

    #[tokio::test]
    async fn price_build_returns_one_priced_row_per_build_item() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let source = StubSource::with_listings(vec![listing("T8_MAIN_SWORD", 1_000)]);

        let price = price_build(&db, &source, build_id, &settings(), None)
            .await
            .expect("price build");
        assert_eq!(price.build_id, build_id);
        assert_eq!(price.items.len(), 1);
        assert_eq!(price.items[0].unit_price, Decimal::from(1_000));
        assert_eq!(price.total, Decimal::from(1_000));
        assert_eq!(price.unpriced_item_count, 0);
    }

    #[tokio::test]
    async fn an_item_without_a_listing_is_counted_as_unpriced() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        // The market answers, but not for this item.
        let source = StubSource::with_listings(vec![listing("T4_BAG", 50)]);

        let price = price_build(&db, &source, build_id, &settings(), None)
            .await
            .expect("price build");
        assert_eq!(price.total, Decimal::ZERO);
        assert_eq!(price.unpriced_item_count, 1);
    }

    #[tokio::test]
    async fn an_item_that_cannot_be_resolved_is_counted_as_unpriced() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        // A row whose id is not in the catalog and which has no icon to recover an identifier from.
        build_item::ActiveModel {
            build_id: Set(build_id),
            loadout: Set("main".into()),
            slot: Set("head".into()),
            openalbion_item_type: Set("armor".into()),
            openalbion_item_id: Set(7),
            openalbion_item_name: Set("Mystery helm".into()),
            openalbion_item_icon: Set(None),
            openalbion_item_tier: Set(None),
            openalbion_item_quality: Set(4),
            openalbion_item_enchantment: Set(0),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("unresolvable item");
        let source = StubSource::with_listings(vec![listing("T8_MAIN_SWORD", 1_000)]);

        let price = price_build(&db, &source, build_id, &settings(), None)
            .await
            .expect("price build");
        assert_eq!(price.total, Decimal::from(1_000));
        assert_eq!(price.unpriced_item_count, 1);
    }

    #[tokio::test]
    async fn a_market_outage_is_an_error_not_a_zero_price() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;

        let error = price_build(&db, &StubSource::failing(), build_id, &settings(), None)
            .await
            .expect_err("an outage must not price the build at zero");
        assert!(matches!(error, AppError::Internal(_)), "{error:?}");
    }

    #[tokio::test]
    async fn a_failed_price_is_not_cached_and_the_retry_reaches_the_market() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let cache = PriceCache::new();
        let settings = settings();

        let outage = StubSource::failing();
        cached_build_price(&cache, "t1", &db, &outage, build_id, &settings)
            .await
            .expect_err("outage");
        assert!(
            cache
                .get_build("t1", &settings.pricing_location, build_id)
                .is_none(),
            "a failure must not be cached"
        );

        let recovered = StubSource::with_listings(vec![listing("T8_MAIN_SWORD", 1_000)]);
        let view = cached_build_price(&cache, "t1", &db, &recovered, build_id, &settings)
            .await
            .expect("recovered");
        assert_eq!(view.total, Decimal::from(1_000));
        assert_eq!(recovered.calls(), 2, "configured city plus cheapest_any fallback");

        // The success is cached: a repeat view does not touch the market.
        cached_build_price(&cache, "t1", &db, &recovered, build_id, &settings)
            .await
            .expect("cached");
        assert_eq!(recovered.calls(), 2);
    }

    #[tokio::test]
    async fn editing_a_build_evicts_its_price_and_that_of_the_comps_containing_it() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let comp_id = insert_comp_with_build(&db, creator, build_id, 2).await;
        let cache = PriceCache::new();
        let settings = settings();
        let source = StubSource::with_listings(vec![listing("T8_MAIN_SWORD", 1_000)]);

        cached_build_price(&cache, "t1", &db, &source, build_id, &settings)
            .await
            .expect("build price");
        cached_comp_price(&cache, "t1", &db, &source, comp_id, &settings)
            .await
            .expect("comp price");
        assert!(cache.get_build("t1", &settings.pricing_location, build_id).is_some());
        assert!(cache.get_comp("t1", &settings.pricing_location, comp_id).is_some());

        evict_build_prices(&cache, &db, "t1", build_id).await;

        assert!(cache.get_build("t1", &settings.pricing_location, build_id).is_none());
        assert!(cache.get_comp("t1", &settings.pricing_location, comp_id).is_none());
    }

    async fn insert_comp_with_build(
        db: &DatabaseConnection,
        creator: i64,
        build_id: i64,
        quantity: i32,
    ) -> i64 {
        let category = comp_category::ActiveModel {
            name: Set("10v10".into()),
            slug: Set("10v10".into()),
            ..Default::default()
        }
        .insert(db)
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
        .insert(db)
        .await
        .expect("comp")
        .id;
        comp_build::ActiveModel {
            comp_id: Set(comp_id),
            build_id: Set(build_id),
            quantity: Set(quantity),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("comp build");
        comp_id
    }

    #[tokio::test]
    async fn price_build_rejects_an_unknown_build() {
        let db = seed_db().await;
        let error = price_build(&db, &StubSource::failing(), 999, &settings(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn price_comp_sums_build_subtotals_by_quantity() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let comp_id = insert_comp_with_build(&db, creator, build_id, 3).await;
        let source = StubSource::with_listings(vec![listing("T8_MAIN_SWORD", 1_000)]);

        let price = price_comp(&db, &source, comp_id, &settings(), None)
            .await
            .expect("price comp");
        assert_eq!(price.builds.len(), 1);
        assert_eq!(price.builds[0].quantity, 3);
        assert_eq!(price.builds[0].unit_total, Decimal::from(1_000));
        assert_eq!(price.builds[0].subtotal, Decimal::from(3_000));
        assert_eq!(price.total, Decimal::from(3_000));
        assert_eq!(price.unpriced_item_count, 0);
    }

    #[tokio::test]
    async fn price_comp_counts_unpriced_items_once_per_copy_of_the_build() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let comp_id = insert_comp_with_build(&db, creator, build_id, 3).await;
        let source = StubSource::with_listings(Vec::new());

        let price = price_comp(&db, &source, comp_id, &settings(), None)
            .await
            .expect("price comp");
        assert_eq!(price.total, Decimal::ZERO);
        assert_eq!(price.builds[0].unpriced_item_count, 1);
        assert_eq!(price.unpriced_item_count, 3);
    }

    #[tokio::test]
    async fn a_comp_price_outage_is_an_error() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        let build_id = insert_build_with_item(&db, creator).await;
        let comp_id = insert_comp_with_build(&db, creator, build_id, 1).await;

        price_comp(&db, &StubSource::failing(), comp_id, &settings(), None)
            .await
            .expect_err("outage");
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

        let price = price_comp(&db, &StubSource::failing(), comp_id, &settings(), None)
            .await
            .expect("price comp");
        assert!(price.builds.is_empty());
        assert_eq!(price.total, Decimal::ZERO);
    }
}
