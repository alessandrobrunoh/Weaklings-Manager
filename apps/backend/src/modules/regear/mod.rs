//! Regear module.
//!
//! Provides the routes, services, and schemas for the Call-To-Arms gear reimbursement workflow:
//! death extraction from event-linked battles, per-death estimate using Albion Online Data,
//! member-initiated requests, and officer adjudication that emits a Guild Bank transaction.
//!
//! See `plans/regear-module.md` for the full design.

pub mod entities;
pub mod extractor;
pub mod models;
pub mod pricing;
pub mod router;
pub mod service;
pub mod slots;
pub mod status;

pub use router::router;
