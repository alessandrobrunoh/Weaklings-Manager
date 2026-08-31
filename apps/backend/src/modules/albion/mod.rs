//! Albion Online integration module.
//!
//! Provides a reusable client for the public Albion Online gameinfo API, guild roster
//! browsing for the operator's configured guild, and self-service Discord <-> Albion
//! player account linking.

pub mod client;
pub mod discord_nick;
pub mod entities;
pub mod router;
pub mod service;

pub use router::router;
