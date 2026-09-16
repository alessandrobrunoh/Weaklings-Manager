//! Publish a guild artifact snapshot into the alliance tenant schema.
//!
//! Share is not a clone into other member guilds: the copy lives in the alliance tenant and
//! shows up on that tenant's existing list endpoints (`GET /api/builds`).

pub mod models;
pub mod router;
mod service;

pub use router::router;
