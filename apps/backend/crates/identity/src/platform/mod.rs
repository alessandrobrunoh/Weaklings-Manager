//! Control-plane platform API: tenants, feature flags, platform admins.

pub mod extractor;
pub mod models;
pub mod public;
pub mod router;
pub mod service;

pub use extractor::PlatformAdmin;
pub use public::alliance_router;
pub use public::router as public_router;
pub use router::router;
