//! Request/response DTOs for guild giveaways.

use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::GiveawayStatus;

/// Body of `POST /api/giveaways`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateGiveawayRequest {
    /// Public title.
    pub title: String,
    /// Optional description.
    pub description: Option<String>,
    /// RFC 3339 deadline. Must be in the future.
    pub ends_at: String,
    /// Optional Guild Bank silver credited to the winner. Omitted or zero means no silver prize.
    #[schema(value_type = Option<String>, example = "2000000")]
    pub silver_amount: Option<Decimal>,
    /// Item prizes. At least one prize or a positive silver amount is required.
    #[serde(default)]
    pub prizes: Vec<CreateGiveawayPrizeRequest>,
}

/// One item prize on create.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateGiveawayPrizeRequest {
    /// OpenAlbion catalog id.
    pub openalbion_item_id: i64,
    /// Display name.
    pub openalbion_item_name: String,
    /// Optional render URL.
    pub openalbion_item_icon: Option<String>,
    /// Unique Albion identifier, including enchantment suffix.
    pub openalbion_item_identifier: Option<String>,
    /// Tier label.
    pub openalbion_item_tier: Option<String>,
    /// Quality `1..=5`. Omitted becomes Excellent (`4`).
    pub openalbion_item_quality: Option<i16>,
    /// How many of this item. Defaults to 1.
    pub quantity: Option<i32>,
}

/// Body of `PUT /api/giveaways/{id}/discord-message`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetGiveawayDiscordMessageRequest {
    /// Discord message snowflake.
    pub message_id: String,
    /// Discord channel snowflake.
    pub channel_id: String,
}

/// Filters for `GET /api/giveaways`.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct GiveawayFilters {
    /// Restrict to one status.
    pub status: Option<GiveawayStatus>,
    /// Case-insensitive title substring.
    pub search: Option<String>,
    /// Sort column: `created_at` (default), `ends_at`, `title`, `status`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`.
    pub order: Option<String>,
}

/// List-row view of a giveaway.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GiveawayView {
    /// Row id.
    pub id: i64,
    /// Title.
    pub title: String,
    /// Optional description.
    pub description: Option<String>,
    /// RFC 3339 deadline.
    pub ends_at: String,
    /// Lifecycle status.
    pub status: GiveawayStatus,
    /// Creator user id.
    pub created_by: i64,
    /// Creator display name.
    pub created_by_username: String,
    /// Creation time, RFC 3339.
    pub created_at: String,
    /// Optional silver prize.
    #[schema(value_type = Option<String>, example = "2000000.00")]
    pub silver_amount: Option<Decimal>,
    /// Winner user id, once drawn.
    pub winner_user_id: Option<i64>,
    /// Winner display name, once drawn.
    pub winner_username: Option<String>,
    /// Winner Discord snowflake, once drawn.
    pub winner_discord_id: Option<String>,
    /// Draw time, RFC 3339.
    pub drawn_at: Option<String>,
    /// Guild Bank transaction id for the silver prize.
    pub silver_transaction_id: Option<i64>,
    /// Discord announcement message snowflake.
    pub discord_message_id: Option<String>,
    /// Discord announcement channel snowflake.
    pub discord_channel_id: Option<String>,
    /// Number of current entries.
    pub entry_count: u64,
    /// Item prizes.
    pub prizes: Vec<GiveawayPrizeView>,
}

/// One item prize as seen by clients.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GiveawayPrizeView {
    /// Prize row id.
    pub id: i64,
    /// OpenAlbion catalog id.
    pub openalbion_item_id: i64,
    /// Display name.
    pub openalbion_item_name: String,
    /// Render URL.
    pub openalbion_item_icon: Option<String>,
    /// Unique Albion identifier.
    pub openalbion_item_identifier: Option<String>,
    /// Tier label.
    pub openalbion_item_tier: Option<String>,
    /// Quality `1..=5`.
    pub openalbion_item_quality: i16,
    /// Quantity.
    pub quantity: i32,
}

/// One Discord entry.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GiveawayEntryView {
    /// Entry row id.
    pub id: i64,
    /// Linked Manager user.
    pub user_id: i64,
    /// Display name.
    pub username: String,
    /// Discord snowflake, when linked.
    pub discord_id: Option<String>,
    /// Entry time, RFC 3339.
    pub entered_at: String,
}

/// Detail view including every participant.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GiveawayDetailView {
    /// Shared giveaway fields.
    #[serde(flatten)]
    pub giveaway: GiveawayView,
    /// Current entries, oldest first.
    pub entries: Vec<GiveawayEntryView>,
}
