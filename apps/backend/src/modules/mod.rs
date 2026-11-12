//! Modules root.
//!
//! Exposes and aggregates all functional modules (users, auth, etc.) in the backend.

pub mod health;
pub mod utils;

use axum::Router;

/// Aggregates the routers of all modules in the application.
///
/// This serves as the main router registry for the modular structure.
pub fn router() -> Router {
    Router::new()
        .nest("/health", health::router())
        .nest(
            "/users",
            backend_identity::users::router().merge(backend_combat::user_weapons::router()),
        )
        .nest("/members", backend_identity::members::router())
        .nest("/auth", backend_identity::auth::router())
        .nest("/bank", backend_bank::router())
        .nest("/splits", backend_splits::router())
        .nest("/albion", backend_identity::albion::router())
        .nest("/albionbb", backend_albion_data::albionbb::router())
        .nest("/applications", backend_community::applications::router())
        .nest("/tickets", backend_community::tickets::router())
        .nest("/albiondata", backend_albion_data::albiondata::router())
        .nest("/battles", backend_battles::battles::router())
        .nest("/attention", backend_fights::attention::router())
        .nest("/enemies", backend_battles::enemies::router())
        .nest("/fingerprints", backend_battles::fingerprints::router())
        .nest("/economy", backend_battles::economy::router())
        .nest(
            "/fight-analytics",
            backend_battles::fight_analytics::router(),
        )
        .nest("/openalbion", backend_albion_data::openalbion::router())
        .nest("/combat", backend_combat::router())
        .nest(
            "/comps",
            backend_comps::router()
                .merge(backend_combat::comp_routes::comp_routes())
                .merge(backend_events::events::comp_routes::comp_routes()),
        )
        // `nest_service`, not `nest`: the events router is a fallback service (the link proxy runs
        // before routing), and axum 0.8 drops a nested router's fallback, answering 404 for
        // every `/api/events` path. `nest_service` strips the prefix and hands it the request.
        .nest_service("/events", backend_events::events::router())
        .nest("/actions", backend_events::actions::router())
        .nest("/fights", backend_fights::fights::router())
        .nest("/giveaways", backend_rewards::giveaways::router())
        .nest("/siphoned", backend_rewards::siphoned::router())
        .nest("/regear", backend_regear::router())
        .nest("/alliance", backend_events::alliance_share::router())
        .nest("/sync", backend_runtime::sync::router::router())
        .nest("/me", backend_identity::capabilities::router())
        .nest("/admin", backend_identity::admin::router())
        .nest("/utils", utils::router())
        .nest("/audit", backend_identity::audit::router())
        .nest("/intel", backend_intel::router())
        .nest("/progression", backend_progression::router())
        .nest("/vods", backend_community::vods::router())
        .nest("/warns", backend_community::warns::router())
        .nest("/notifications", backend_identity::notifications::router())
}

#[cfg(test)]
mod tests;
