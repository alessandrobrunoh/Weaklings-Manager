//! Control-plane platform API: tenants, feature flags, platform admins.

mod extractor;
pub(crate) mod models;
pub(crate) mod public;
pub(crate) mod router;
pub(crate) mod service;

pub use extractor::PlatformAdmin;
pub use public::router as public_router;
pub use router::router;
