//! Request/response DTOs for VOD review claims.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Body of `POST /api/vods`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SubmitVodRequest {
    /// Raw VOD URL (normalized server-side).
    pub url: String,
    /// Discord forum thread id the command was invoked in.
    pub discord_thread_id: String,
    /// Discord message id associated with the claim.
    pub discord_message_id: String,
    /// Parent forum channel id (must match `progression_settings.vod_forum_channel_id`).
    pub forum_channel_id: String,
    /// Discord snowflake of the thread owner. Must match the claimer.
    pub thread_owner_discord_id: String,
}

/// One claimed VOD review.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct VodReviewView {
    /// Row id.
    pub id: i64,
    /// Claimer.
    pub user_id: i64,
    /// Season the unique URL was recorded against.
    pub season_id: i64,
    /// Normalized URL.
    pub url: String,
    /// Discord thread id.
    pub discord_thread_id: String,
    /// Discord message id.
    pub discord_message_id: String,
    /// Insert time, RFC 3339.
    pub created_at: String,
}
