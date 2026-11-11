//! Events route-matrix harness: the shared sync harness plus the extensions only the
//! events router reads.

use sea_orm::DatabaseConnection;

/// [`backend_runtime::sync::test_support::matrix_app`] plus the `RosterHub` and
/// `AlbionBbService` extensions the events handlers extract.
pub fn matrix_app(
    routes: axum::Router,
    db: &DatabaseConnection,
    tenant_id: &str,
    tenant_kind: &str,
) -> axum::Router {
    use crate::events::roster_hub::RosterHub;
    use axum::Extension;
    use backend_albion_data::albionbb::service::AlbionBbService;

    backend_runtime::sync::test_support::matrix_app(routes, db, tenant_id, tenant_kind)
        .layer(Extension(RosterHub::default()))
        .layer(Extension(AlbionBbService::default()))
}

/// `items` for a `CreateBuildRequest` in tests: a Broadsword in the main loadout, so the build
/// satisfies the main-hand weapon rule that every non-mount build must meet.
pub fn main_weapon_items() -> Option<Vec<backend_comps::models::CreateBuildItemRequest>> {
    let broadsword =
        backend_albion_data::openalbion::service::catalog_item_by_identifier("T8_MAIN_SWORD")
            .expect("T8_MAIN_SWORD is in the bundled catalog");
    Some(vec![backend_comps::models::CreateBuildItemRequest {
        slot: backend_entities::status::comps::BuildSlot::Weapon,
        openalbion_item_type: "weapon".to_owned(),
        openalbion_item_id: broadsword.id,
        openalbion_item_name: broadsword.name.clone(),
        openalbion_item_icon: None,
        spells: None,
        openalbion_item_tier: None,
        openalbion_item_quality: None,
        openalbion_item_enchantment: None,
    }])
}
