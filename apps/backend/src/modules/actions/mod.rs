//! The action engine: one rule set for web, Discord, scheduler and sync (shared-actions §3).
//!
//! * `model` holds the registry types and the wire types.
//! * `engine` evaluates, describes and executes actions; it is the only place that locks,
//!   writes `action_log` and runs post-commit work.
//! * `entities` holds the registries per entity kind (events so far).
//! * `router` holds the handlers; the events router mounts the event routes and
//!   `modules::mod` mounts `GET /api/actions/catalog`.
//!
//! Effects (Discord outbox) and sync outbox rows are not written yet; `ActionResult.effects`
//! is always empty and `sync` is absent until those slices land.

pub mod action_log;
pub mod engine;
pub mod entities;
pub mod model;
pub mod router;

#[cfg(test)]
mod tests;

pub use router::router;
