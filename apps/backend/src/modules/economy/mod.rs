//! The economic bridge between combat evidence and money.
//!
//! Everything here obeys one non-negotiable rule: **income is declared, never
//! inferred from combat.** An officer creates a split; that split's
//! `net_value` is the only source of guild income. Nothing in this module
//! ever turns an estimated enemy loss into a credit — an enemy's estimated
//! loss is a *trade indicator* (were we winning the silver exchange?), never
//! a revenue line.
//!
//! Two distinct views follow from that rule:
//! - Per battle/fight: cost and trade only (`battle_loss_estimates`) — our
//!   estimated loss, their estimated loss, nothing "earned".
//! - Per event: the real P&L, built entirely from already-declared,
//!   already-real ledger facts (`splits.net_value`, `regear_deaths.final_amount`)
//!   — no estimate is ever added on the income side.
//!
//! See `m20260908_000008_create_battle_loss_estimates` for the schema
//! rationale.

pub mod entities;
pub mod estimate;
pub mod models;
pub mod router;
pub mod service;
pub mod writer;

pub use router::router;
