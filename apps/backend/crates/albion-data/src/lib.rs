//! Clients and caches for external Albion data: `AlbionBB`, Albion Online Data and the `OpenAlbion`
//! catalogue.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod albionbb;
pub mod albiondata;
pub mod openalbion;
