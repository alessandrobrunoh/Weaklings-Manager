//! Request/response DTOs for the notification inbox.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::NotificationKind;

/// Body of `POST /api/notifications/broadcast`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BroadcastRequest {
    /// Required non-empty title, max 120 chars after trim.
    #[schema(example = "CTA tonight")]
    pub title: String,
    /// Required non-empty body, max 2000 chars after trim.
    #[schema(example = "Be online at 20:00 UTC.")]
    pub body: String,
}

/// Result of a successful guild-wide broadcast.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BroadcastResult {
    /// `notification_broadcasts.id`.
    pub id: i64,
    /// How many inbox rows were inserted.
    pub recipient_count: u64,
}

/// One inbox row as seen by the recipient.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NotificationView {
    /// Row id.
    pub id: i64,
    /// Kind key.
    pub kind: NotificationKind,
    /// Title.
    pub title: String,
    /// Body.
    pub body: String,
    /// Optional dashboard path.
    pub link_path: Option<String>,
    /// Source table/kind.
    pub source_type: String,
    /// Source row id.
    pub source_id: i64,
    /// When the recipient read it, RFC 3339.
    pub read_at: Option<String>,
    /// Insert time, RFC 3339.
    pub created_at: String,
}

/// Unread badge payload.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UnreadCountView {
    /// Number of unread inbox rows for the caller.
    pub count: u64,
}

/// Result of mark-all-read.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReadAllResult {
    /// How many rows flipped from unread to read.
    pub updated: u64,
}

/// Query filters for `GET /api/notifications`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct NotificationFilters {
    /// When `true`, only unread rows.
    pub unread: Option<bool>,
}

/// Input for [`super::service::NotificationService::notify`].
#[derive(Debug, Clone)]
pub struct NotifySpec<'a> {
    /// Kind of notification.
    pub kind: NotificationKind,
    /// Recipients.
    pub user_ids: &'a [i64],
    /// Title (already validated by the caller, or validated here).
    pub title: String,
    /// Body.
    pub body: String,
    /// Optional in-app path.
    pub link_path: Option<String>,
    /// Source table/kind.
    pub source_type: &'a str,
    /// Source row id.
    pub source_id: i64,
    /// Actor, if any.
    pub created_by_user_id: Option<i64>,
}
