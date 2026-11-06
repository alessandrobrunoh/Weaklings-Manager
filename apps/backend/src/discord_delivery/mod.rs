//! Backend-driven Discord delivery (DO-S1): the effect catalogue, the tenant outbox with
//! leases, and the bindings that record where an entity lives on Discord.
//!
//! This slice is inert. Nothing emits effects, serves routes or runs a worker yet: the
//! lifecycle choke point (DO-3a), the bot API (DO-2), the scheduler (DO-4) and the legacy
//! import (DO-6) build on these pieces.

pub mod bindings;
pub mod kinds;
pub mod outbox;
#[cfg(test)]
mod tests;
