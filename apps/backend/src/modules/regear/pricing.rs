//! Pricing helpers for the regear workflow.
//!
//! Builds a [`BreakdownRow`] per item in a victim's kill-feed `Equipment` by:
//! 1. Walking the JSON to find every `{ "Type": "T8_..." }` entry (handles nested objects/arrays).
//! 2. Batching the item ids against the Albion Online Data API.
//! 3. Picking the cheapest sell price per item, restricted to the configured city (with optional
//!    cross-city fallback).
//! 4. Filtering by the admin `enabled_slots_mask` so disabled slots are present but excluded.

use std::collections::HashMap;

use sea_orm::prelude::Decimal;
use serde_json::Value;

use crate::errors::AppError;
use crate::modules::albiondata::client::AlbionDataMarketPrice;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::comps::status::BuildSlot;

use super::entities::RegearSettingModel;
use super::models::BreakdownRow;
use super::slots::{is_slot_enabled, slot_from_albionbb_key};

/// The fallback strategy for choosing a price when the configured city has no listing.
#[derive(Debug, Clone, Copy)]
pub enum PricingFallback {
    /// Use the cheapest listing across all cities (default).
    CheapestAny,
    /// Only honor listings in the configured city; otherwise the slot is priced at 0.
    Strict,
}

impl PricingFallback {
    /// Parses the strategy string stored in `regear_settings.pricing_fallback_strategy`.
    #[must_use]
    pub fn from_str(strategy: &str) -> Self {
        match strategy {
            "strict" => Self::Strict,
            _ => Self::CheapestAny,
        }
    }
}

/// One item found while walking the equipment JSON. The slot is resolved from the parent key
/// (e.g. the value at `Equipment.MainHand` is tagged with `BuildSlot::Weapon`).
#[derive(Debug, Clone)]
struct ExtractedItem {
    slot: BuildSlot,
    item_id: String,
    quantity: i32,
}

/// Walks a victim's kill-feed `Equipment` JSON and returns one [`BreakdownRow`] per priced item.
///
/// Items whose slot the admin disabled via `enabled_slots_mask` are still returned (so the UI can
/// show them greyed out) but their `included` flag is `false` and they contribute 0 to the total.
///
/// # Errors
///
/// Returns [`AppError::UpstreamService`] if Albion Online Data is unreachable.
pub async fn build_breakdown(
    albiondata: &AlbionDataService,
    equipment_json: &Value,
    settings: &RegearSettingModel,
    server: Option<&str>,
) -> Result<(Vec<BreakdownRow>, Decimal), AppError> {
    let items = collect_equipment_items(equipment_json);
    if items.is_empty() {
        return Ok((Vec::new(), Decimal::ZERO));
    }

    // De-duplicate item ids so we don't query Albion Data twice for the same weapon.
    let mut unique_ids: Vec<String> = items
        .iter()
        .map(|item| item.item_id.clone())
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

    let price_index = build_price_index(&prices, &fallback_prices);

    let mut total = Decimal::ZERO;
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let unit_price = price_index.get(&item.item_id).copied().unwrap_or(0);
        let included = is_slot_enabled(settings.enabled_slots_mask, item.slot);
        let row = BreakdownRow {
            slot: item.slot,
            item_id: item.item_id.clone(),
            quality: 1,
            unit_price: Decimal::from(unit_price),
            quantity: item.quantity,
            included,
        };
        if included {
            total += row.contribution();
        }
        rows.push(row);
    }
    Ok((rows, total))
}

/// Walks the equipment object, finding every `{ "Type": "..." }` payload and tagging it with the
/// canonical slot derived from the parent key (e.g. `MainHand` → `Weapon`).
///
/// This mirrors the parsing logic in `battles::service::collect_equipment_items`, but also resolves
/// the parent slot — which `battles::service` does not need because it only sums silver loss.
fn collect_equipment_items(equipment: &Value) -> Vec<ExtractedItem> {
    let Some(slots_map) = equipment.as_object() else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for (slot_key, value) in slots_map {
        let Some(slot) = slot_from_albionbb_key(slot_key) else {
            continue;
        };
        walk_value(value, slot, &mut items);
    }
    items
}

/// Recursively walks a JSON value looking for `{ "Type": "..." }` payloads.
fn walk_value(value: &Value, slot: BuildSlot, items: &mut Vec<ExtractedItem>) {
    if let Some(item_id) = value
        .as_object()
        .and_then(|obj| obj.get("Type").or_else(|| obj.get("type")))
        .and_then(Value::as_str)
    {
        let quantity = value
            .as_object()
            .and_then(|obj| obj.get("Count").or_else(|| obj.get("count")))
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1) as i32;
        items.push(ExtractedItem {
            slot,
            item_id: item_id.to_string(),
            quantity,
        });
        return;
    }
    if let Some(array) = value.as_array() {
        for nested in array {
            walk_value(nested, slot, items);
        }
        return;
    }
    if let Some(object) = value.as_object() {
        for nested in object.values() {
            walk_value(nested, slot, items);
        }
    }
}

/// Picks the cheapest positive sell price per item id.
///
/// When the configured-city index has a price, it wins (matches admin intent). Otherwise, if the
/// fallback strategy is `cheapest_any`, we consult the cross-city index.
fn build_price_index(
    configured_city: &[AlbionDataMarketPrice],
    fallback: &[AlbionDataMarketPrice],
) -> HashMap<String, i64> {
    let mut index = HashMap::new();
    let insert_cheapest = |prices: &[AlbionDataMarketPrice], index: &mut HashMap<String, i64>| {
        for price in prices {
            let candidate = [price.sell_price_min, price.sell_price_max]
                .into_iter()
                .filter(|p| *p > 0)
                .min()
                .unwrap_or(0);
            if candidate > 0 {
                index
                    .entry(price.item_id.clone())
                    .and_modify(|existing| {
                        if candidate < *existing {
                            *existing = candidate;
                        }
                    })
                    .or_insert(candidate);
            }
        }
    };
    insert_cheapest(fallback, &mut index);
    insert_cheapest(configured_city, &mut index);
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collects_items_with_slot_tags() {
        let equipment = json!({
            "MainHand": { "Type": "T8_MAIN_NATURESTAFF_KEEPER", "Count": 1 },
            "Head": { "Type": "T8_HEAD_LEATHER_SET1", "Count": 1 },
            "Inventory": [
                { "Type": "T7_BAG", "Count": 1 }
            ]
        });
        let items = collect_equipment_items(&equipment);
        // Inventory is not a recognized slot key, so its items are skipped.
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.slot == BuildSlot::Weapon));
        assert!(items.iter().any(|i| i.slot == BuildSlot::Head));
    }

    #[test]
    fn unknown_slots_are_skipped() {
        let equipment = json!({
            "UnknownSlot": { "Type": "T8_BAG", "Count": 1 }
        });
        assert!(collect_equipment_items(&equipment).is_empty());
    }

    #[test]
    fn fallback_strategy_parses_leniently() {
        assert!(matches!(
            PricingFallback::from_str("cheapest_any"),
            PricingFallback::CheapestAny
        ));
        assert!(matches!(
            PricingFallback::from_str("strict"),
            PricingFallback::Strict
        ));
        // Unknown strings default to the permissive strategy.
        assert!(matches!(
            PricingFallback::from_str("garbage"),
            PricingFallback::CheapestAny
        ));
    }
}
