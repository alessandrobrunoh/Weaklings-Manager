//! Every `SeaORM` entity and status enum of the tenant schema.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod admin;
pub mod albion;
pub mod applications;
pub mod attention;
pub mod audit;
pub mod auth;
pub mod bank;
pub mod battles;
pub mod battles_evidence;
pub mod combat;
pub mod comps;
pub mod economy;
pub mod enemies;
pub mod events;
pub mod fight_analytics;
pub mod fingerprints;
pub mod giveaways;
pub mod intel;
pub mod notifications;
pub mod progression;
pub mod regear;
pub mod siphoned;
pub mod siphoned_quote;
pub mod splits;
pub mod status;
pub mod tickets;
pub mod trials;
pub mod users;
pub mod vods;
pub mod warns;
