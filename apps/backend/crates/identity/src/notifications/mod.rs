//! In-app notification inbox and officer broadcast fan-out.

pub mod models;
pub mod router;
pub mod schemas;
pub mod service;

pub use backend_entities::status::notifications::NotificationKind;
pub use models::NotifySpec;
pub use router::router;
pub use service::notify_best_effort;
