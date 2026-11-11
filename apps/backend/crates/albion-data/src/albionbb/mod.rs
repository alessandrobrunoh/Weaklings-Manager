//! `AlbionBB` integration module.
//!
//! Provides a reusable client for the public `AlbionBB` battle-history API
//! (<https://api.albionbb.com/>), a community-maintained Albion Online battle
//! database. The client is generic (any guild/player/server) and is consumed
//! by the `battles` module, which reshapes it for the
//! configured Weaklings guild.

pub mod client;
pub mod router;
pub mod schemas;
pub mod service;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use router::router;
