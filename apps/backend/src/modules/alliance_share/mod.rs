//! Publish a guild artifact snapshot into the alliance tenant schema.
//!
//! Share is not a clone into other member guilds: the copy lives in the alliance tenant and
//! shows up on that tenant's existing list endpoints (`GET /api/builds`, `GET /api/comps`,
//! `GET /api/splits`). Published splits are read-only snapshots (`origin_read_only`).

pub mod models;
pub mod router;
mod service;

pub use router::router;
