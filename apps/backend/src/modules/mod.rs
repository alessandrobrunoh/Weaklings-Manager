//! Modules root.
//!
//! Exposes and aggregates all functional modules (users, auth, etc.) in the backend.

pub mod admin;
pub mod albion;
pub mod albionbb;
pub mod albiondata;
pub mod auth;
pub mod bank;
pub mod battles;
pub mod comps;
pub mod events;
pub mod health;
pub mod openalbion;
pub mod siphoned;
pub mod splits;
pub mod users;
pub mod utils;
pub mod audit;

use axum::Router;

/// Aggregates the routers of all modules in the application.
///
/// This serves as the main router registry for the modular structure.
pub fn router() -> Router {
    Router::new()
        .nest("/health", health::router())
        .nest("/users", users::router())
        .nest("/auth", auth::router())
        .nest("/bank", bank::router())
        .nest("/splits", splits::router())
        .nest("/albion", albion::router())
        .nest("/albionbb", albionbb::router())
        .nest("/albiondata", albiondata::router())
        .nest("/battles", battles::router())
        .nest("/openalbion", openalbion::router())
        .nest("/comps", comps::router())
        .nest("/events", events::router())
        .nest("/siphoned", siphoned::router())
        .nest("/admin", admin::router())
        .nest("/utils", utils::router())
        .nest("/audit", audit::router())
}
