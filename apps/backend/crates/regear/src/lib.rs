//! Regear module.
//!
//! Provides the routes, services, and schemas for the Call-To-Arms gear reimbursement workflow:
//! death extraction from event-linked battles, per-death estimate using Albion Online Data,
//! member-initiated requests, and officer adjudication that emits a Guild Bank transaction.
//!
//! See `plans/regear-module.md` for the full design.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub mod credits;
pub mod extractor;
pub mod models;
pub mod pricing;
pub mod router;
pub mod schemas;
pub mod service;
pub mod slots;

pub use router::router;
