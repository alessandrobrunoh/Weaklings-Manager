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
