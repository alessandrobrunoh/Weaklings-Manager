//! Albion combat mathematics.
//!
//! One place for every number the guild's tooling derives from game data: what Item Power a build
//! has at a given specialization level, how that turns into stats, which member fits which seat of a
//! composition, and — later — what a scripted engagement does.
//!
//! The layering is deliberate. `dataset` and `data_types` hold bundled facts; `pattern` and `ip`
//! are pure functions over them with no database and no async; anything that needs Postgres lives
//! above, in the service. That keeps the arithmetic unit-testable against fixtures captured from
//! the live game, which is the only thing that can prove these numbers right.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod comp_routes;
pub mod fit;
pub mod ip;
pub mod models;
pub mod router;
pub mod scenario;
pub mod schemas;
pub mod seats;
pub mod service;
pub mod sim;
pub mod spell;
pub mod user_weapons;

pub use router::router;
