//! Modules root.
//!
//! Exposes and aggregates all functional modules (users, auth, etc.) in the backend.

pub mod actions;
pub mod admin;
pub mod albion;
pub mod albionbb;
pub mod albiondata;
pub mod alliance_share;
pub mod applications;
pub mod attention;
pub mod audit;
pub mod auth;
pub mod bank;
pub mod battles;
pub mod capabilities;
pub mod combat;
pub mod comps;
pub mod discord_api;
pub mod economy;
pub mod enemies;
pub mod events;
pub mod fight_analytics;
pub mod fights;
pub mod fingerprints;
pub mod giveaways;
pub mod health;
pub mod intel;
pub mod members;
pub mod notifications;
pub mod openalbion;
pub mod platform;
pub mod progression;
pub mod regear;
pub mod siphoned;
pub mod splits;
pub mod sync;
pub mod tickets;
pub mod trials;
pub mod users;
pub mod utils;
pub mod vods;
pub mod warns;

use axum::Router;

/// Aggregates the routers of all modules in the application.
///
/// This serves as the main router registry for the modular structure.
pub fn router() -> Router {
    Router::new()
        .nest("/health", health::router())
        .nest("/users", crate::modules::users::router())
        .nest("/members", crate::modules::members::router())
        .nest("/auth", crate::modules::auth::router())
        .nest("/bank", crate::modules::bank::router())
        .nest("/splits", crate::modules::splits::router())
        .nest("/albion", crate::modules::albion::router())
        .nest("/albionbb", crate::modules::albionbb::router())
        .nest("/applications", crate::modules::applications::router())
        .nest("/tickets", crate::modules::tickets::router())
        .nest("/albiondata", crate::modules::albiondata::router())
        .nest("/battles", crate::modules::battles::router())
        .nest("/attention", crate::modules::attention::router())
        .nest("/enemies", crate::modules::enemies::router())
        .nest("/fingerprints", crate::modules::fingerprints::router())
        .nest("/economy", crate::modules::economy::router())
        .nest(
            "/fight-analytics",
            crate::modules::fight_analytics::router(),
        )
        .nest("/openalbion", crate::modules::openalbion::router())
        .nest("/combat", crate::modules::combat::router())
        .nest("/comps", crate::modules::comps::router())
        .nest("/events", crate::modules::events::router())
        .nest("/actions", crate::modules::actions::router())
        .nest("/fights", crate::modules::fights::router())
        .nest("/giveaways", crate::modules::giveaways::router())
        .nest("/siphoned", crate::modules::siphoned::router())
        .nest("/regear", crate::modules::regear::router())
        .nest("/alliance", crate::modules::alliance_share::router())
        .nest("/sync", crate::modules::sync::router::router())
        .nest("/me", crate::modules::capabilities::router())
        .nest("/admin", crate::modules::admin::router())
        .nest("/utils", utils::router())
        .nest("/audit", crate::modules::audit::router())
        .nest("/intel", crate::modules::intel::router())
        .nest("/progression", crate::modules::progression::router())
        .nest("/vods", crate::modules::vods::router())
        .nest("/warns", crate::modules::warns::router())
        .nest("/notifications", crate::modules::notifications::router())
}
