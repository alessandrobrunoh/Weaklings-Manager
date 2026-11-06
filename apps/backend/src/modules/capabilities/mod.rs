//! Capabilities: what a signed-in user, or the Discord bot for a guild, may see
//! and use in a tenant.
//!
//! * [`catalogue`] is the one table of modules (kinds, features, permissions,
//!   API prefixes, commands, nav groups).
//! * [`model`] builds the document from plain facts.
//! * [`gate`] applies the kind rule to API paths (`MODULE_KIND_ENFORCEMENT`).
//! * [`router`] serves `GET /api/me/capabilities`, and the bot's
//!   `GET /api/tenants/{id}/capabilities` is mounted under the tenant routes.

pub mod catalogue;
pub mod gate;
pub mod model;
pub mod router;

pub use gate::{Enforcement, kind_gate};
pub use model::tenant_version;
pub use router::router;
