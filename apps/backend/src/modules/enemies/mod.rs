//! Enemy identity — who we have actually fought.
//!
//! Before this module, an opponent existed only as denormalized strings on a
//! `scouted_comps` row (one scouted *composition*, not a gilda or a player).
//! There was no way to answer "which guilds have we fought", "who is this
//! player and what have they done to us", or "what build does this player
//! usually run" as a query — only by re-parsing JSON blobs by hand.
//!
//! This module builds that identity layer on top of the normalized evidence
//! `battles::evidence_entities` already provides: `enemy_guilds` and
//! `enemy_players` are the canonical, officer-correctable identity rows (L1);
//! `enemy_player_battles` is the append-only bridge to the evidence that lets
//! every rollup (battles fought, kills traded, builds observed) be computed at
//! read time instead of maintained as a fragile running counter.

pub mod aggregate;
pub mod entities;
pub mod models;
pub mod router;
pub mod service;
pub mod writer;

pub use router::router;
