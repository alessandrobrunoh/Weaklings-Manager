//! `Battles` module — guild-scoped battle history for the Weaklings guild.
//!
//! Wraps the generic [`crate::modules::albionbb`] client and reshapes the data
//! for the frontend: lists recent battles of the configured guild, fetches full
//! battle detail (combining battle + kills in one response), and provides a
//! `/me` endpoint filtered by the calling user's linked Albion character.

pub mod entities;
pub mod models;
pub mod router;
pub mod service;

pub use router::router;
