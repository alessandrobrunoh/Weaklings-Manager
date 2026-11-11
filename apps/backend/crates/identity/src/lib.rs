//! Auth, users, tenants, platform administration, Discord API, members, notifications and Albion
//! identity: the hub every feature depends on.

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
pub mod albion_scope;
pub mod audit;
pub mod auth;
pub mod capabilities;
pub mod discord_api;
pub mod members;
pub mod notifications;
pub mod platform;
pub mod tenant;
pub mod users;
