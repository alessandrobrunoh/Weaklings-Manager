//! `AlbionBB` integration module.
//!
//! Provides a reusable client for the public AlbionBB battle-history API
//! (<https://api.albionbb.com/>), a community-maintained Albion Online battle
//! database. The client is generic (any guild/player/server) and is consumed
//! by the [`crate::modules::battles`] module, which reshapes it for the
//! configured Weaklings guild.

pub mod client;
pub mod router;
pub mod service;

pub use router::router;
