//! In-app notification inbox and officer broadcast fan-out.

pub mod entities;
pub mod models;
pub mod router;
pub mod schemas;
pub mod service;
pub mod status;

pub use crate::modules::notifications::status::NotificationKind;
pub use models::NotifySpec;
pub use router::router;
pub use service::notify_best_effort;
