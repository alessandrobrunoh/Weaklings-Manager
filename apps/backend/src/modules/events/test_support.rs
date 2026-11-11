//! Events route-matrix harness: the shared sync harness plus the extensions only the
//! events router reads.

use sea_orm::DatabaseConnection;

/// [`crate::modules::sync::test_support::matrix_app`] plus the `RosterHub` and
/// `AlbionBbService` extensions the events handlers extract.
pub(crate) fn matrix_app(
    routes: axum::Router,
    db: &DatabaseConnection,
    tenant_id: &str,
    tenant_kind: &str,
) -> axum::Router {
    use crate::modules::albionbb::service::AlbionBbService;
    use crate::modules::events::roster_hub::RosterHub;
    use axum::Extension;

    crate::modules::sync::test_support::matrix_app(routes, db, tenant_id, tenant_kind)
        .layer(Extension(RosterHub::default()))
        .layer(Extension(AlbionBbService::default()))
}
