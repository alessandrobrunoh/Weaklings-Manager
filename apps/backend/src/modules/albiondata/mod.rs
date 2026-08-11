//! Albion Online Data integration module.
//!
//! Owns direct access to Albion Online Data market prices and Sandbox's item render service so
//! loadout features can use stable item identifiers without relying on `OpenAlbion` for prices or
//! images.

pub mod client;
pub mod router;
pub mod service;

pub use router::router;
