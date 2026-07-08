//! `OpenAlbion` integration module.
//!
//! Provides a reusable client for the public OpenAlbion API (<https://openalbion.com/>), a
//! community-maintained reference database for Albion Online items (weapons, armors,
//! accessories, spells, etc.). Used to power the item catalog exposed to the frontend's
//! comp-builder page.

pub mod client;
pub mod router;
pub mod service;

pub use router::router;
