//! Auth module.
//!
//! Provides Discord `OAuth2` authentication, session verification, and
//! permission-based access control. The role→permission mapping is loaded from
//! the `role_permissions` table into an in-memory cache at startup and can be
//! reloaded at runtime (see `POST /api/admin/permissions/reload`).

pub mod entities;
pub mod permission_cache;
pub mod permissions;
pub mod rbac;
pub mod router;
pub mod service;

pub use permission_cache::Permissions;
pub use permissions::Permission;
pub use rbac::{BotSecret, UserContext};
pub use router::router;
