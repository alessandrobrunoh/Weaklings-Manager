//! Albion combat mathematics.
//!
//! One place for every number the guild's tooling derives from game data: what Item Power a member
//! would have on a build, how that turns into stats, which member fits which seat of a
//! composition, and — later — what a scripted engagement does.
//!
//! The layering is deliberate. `dataset` and `data_types` hold bundled facts; `pattern` and `ip`
//! are pure functions over them with no database and no async; anything that needs Postgres lives
//! above, in the service. That keeps the arithmetic unit-testable against fixtures captured from
//! the live game, which is the only thing that can prove these numbers right.

pub mod data_types;
pub mod dataset;
pub mod fit;
pub mod ip;
pub mod models;
pub mod pattern;
pub mod readiness;
pub mod router;
pub mod service;
pub mod sim;
pub mod spell;

pub use router::router;
