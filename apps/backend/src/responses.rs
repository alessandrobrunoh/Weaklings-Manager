//! Standard API response envelopes.
//!
//! Provides wrappers to maintain consistent success response formatting.

use serde::Serialize;
use utoipa::ToSchema;

/// The standard success wrapper envelope (`JSend` style) for generics.
#[derive(Debug, Serialize)]
pub struct ApiResponse<T> {
    /// Indicates the outcome of the request, always "success" for this envelope.
    pub status: &'static str,
    /// The actual payload of the response.
    pub data: T,
}

impl<T> ApiResponse<T> {
    /// Wraps a data payload in the standard success envelope.
    pub fn new(data: T) -> Self {
        Self {
            status: "success",
            data,
        }
    }
}

/// `OpenAPI` schema wrapper for UserProfile response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUserProfile {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The user profile data payload.
    pub data: crate::modules::users::service::UserProfile,
}

/// `OpenAPI` schema wrapper for UserMetrics response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUserMetrics {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The user metrics data payload.
    pub data: crate::modules::users::service::UserMetrics,
}

/// `OpenAPI` schema wrapper for DiscordUserProfile response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseDiscordUserProfile {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The Discord user profile data payload.
    pub data: crate::modules::auth::service::DiscordUserProfile,
}

/// `OpenAPI` schema wrapper for Paginated UserProfile response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedUsers {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated user profiles data payload.
    pub data: crate::pagination::PaginatedUserProfile,
}

/// `OpenAPI` schema wrapper for `BalanceSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBalanceSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The balance summary data payload.
    pub data: crate::modules::bank::models::BalanceSummary,
}

/// `OpenAPI` schema wrapper for `GuildBankSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseGuildBankSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The guild-wide payout aggregate payload.
    pub data: crate::modules::bank::models::GuildBankSummary,
}

/// `OpenAPI` schema wrapper for administrator Guild Bank analytics.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBankAnalyticsSummary {
    /// Indicates the outcome of the request, always `"success"`.
    #[schema(example = "success")]
    pub status: String,
    /// Guild-wide bank analytics payload.
    pub data: crate::modules::bank::models::BankAnalyticsSummary,
}

/// `OpenAPI` schema wrapper for a list-of-`TransactionView` response (the withdrawal
/// request/accept endpoints return the transactions they just touched, not paginated).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseTransactionViewList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of transactions that were just requested or accepted.
    pub data: Vec<crate::modules::bank::models::TransactionView>,
}

/// `OpenAPI` schema wrapper for split KPI totals.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseSplitKpiSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Guild-wide split totals.
    pub data: crate::modules::splits::models::SplitKpiSummary,
}

/// `OpenAPI` schema wrapper for `SplitDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseSplitDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The split detail data payload.
    pub data: crate::modules::splits::models::SplitDetail,
}

/// `OpenAPI` schema wrapper for `AlbionLinkStatus` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionLinkStatus {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The Albion player link status data payload.
    pub data: crate::modules::albion::service::AlbionLinkStatus,
}

/// `OpenAPI` schema wrapper for Paginated `AlbionGuildMember` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedAlbionGuildMembers {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated guild roster data payload.
    pub data: crate::pagination::PaginatedAlbionGuildMember,
}

/// `OpenAPI` schema wrapper for Paginated `OpenAlbionWeapon` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedOpenAlbionWeapons {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated weapon catalog data payload.
    pub data: crate::pagination::PaginatedOpenAlbionWeapon,
}

/// `OpenAPI` schema wrapper for Paginated `OpenAlbionItem` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedOpenAlbionItems {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated item catalog data payload.
    pub data: crate::pagination::PaginatedOpenAlbionItem,
}

/// `OpenAPI` schema wrapper for Albion Online Data market prices.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionDataMarketPriceList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The current market rows returned by Albion Online Data.
    pub data: Vec<crate::modules::albiondata::client::AlbionDataMarketPrice>,
}

/// `OpenAPI` schema wrapper for an Albion render-service item icon URL.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionDataItemIcon {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The resolved render-service URL payload.
    pub data: crate::modules::albiondata::client::AlbionDataItemIcon,
}

/// `OpenAPI` schema wrapper for `BuildCategoryView` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildCategoryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of build categories.
    pub data: Vec<crate::modules::comps::models::BuildCategoryView>,
}

/// `OpenAPI` schema wrapper for `CompCategoryView` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCompCategoryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of comp categories.
    pub data: Vec<crate::modules::comps::models::CompCategoryView>,
}

/// `OpenAPI` schema wrapper for `BuildDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The build detail data payload.
    pub data: crate::modules::comps::models::BuildDetail,
}

/// `OpenAPI` schema wrapper for `CompDetail` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCompDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The comp detail data payload.
    pub data: crate::modules::comps::models::CompDetail,
}

/// `OpenAPI` schema wrapper for comp performance analytics.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCompPerformance {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The comp performance data payload.
    pub data: crate::modules::events::models::CompPerformanceView,
}

/// `OpenAPI` schema wrapper for Paginated `CompSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedComps {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated comp summaries data payload.
    pub data: crate::pagination::PaginatedCompSummary,
}

/// `OpenAPI` schema wrapper for Paginated `BuildSummary` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedBuilds {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated build summaries data payload.
    pub data: crate::pagination::PaginatedBuildSummary,
}

/// `OpenAPI` schema wrapper for Paginated `EventView` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated event summaries data payload.
    pub data: crate::pagination::PaginatedEventSummary,
}

/// `OpenAPI` schema wrapper for `EventView` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The event view data payload.
    pub data: crate::modules::events::models::EventView,
}

/// `OpenAPI` schema wrapper for `EventDetailView` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The event detail data payload.
    pub data: crate::modules::events::models::EventDetailView,
}

/// `OpenAPI` schema wrapper for `OcrResult` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseOcrResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The OCR result data payload.
    pub data: crate::modules::utils::models::OcrResult,
}

/// `OpenAPI` schema wrapper for `MatchedParticipant` list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseMatchedParticipantList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of candidate names that matched a known, saved player.
    pub data: Vec<crate::modules::splits::models::MatchedParticipant>,
}

/// `OpenAPI` schema wrapper for the AlbionBB battles list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbBattlesList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battles list payload (raw AlbionBB page + optional upstream pagination metadata).
    pub data: crate::modules::albionbb::router::AlbionBbBattlesList,
}

/// `OpenAPI` schema wrapper for an AlbionBB battle detail response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbBattleDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battle detail data payload.
    pub data: crate::modules::albionbb::client::AlbionBbBattleDetail,
}

/// `OpenAPI` schema wrapper for an AlbionBB kill events list response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbKillEventList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The list of kill events.
    pub data: Vec<crate::modules::albionbb::client::AlbionBbKillEvent>,
}

/// `OpenAPI` schema wrapper for an AlbionBB guild info response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbGuildInfo {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The guild info data payload.
    pub data: crate::modules::albionbb::client::AlbionBbGuildInfo,
}

/// `OpenAPI` schema wrapper for an AlbionBB player stats response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAlbionBbPlayerStats {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The player stats data payload (raw JSON).
    pub data: serde_json::Value,
}

/// `OpenAPI` schema wrapper for the paginated `BattleSummary` response (guild-scoped).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedBattles {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated battle summaries data payload.
    pub data: crate::pagination::PaginatedBattleSummary,
}

/// `OpenAPI` schema wrapper for the `BattleDetail` response (guild-scoped).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBattleDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The battle detail data payload.
    pub data: crate::modules::battles::models::BattleDetail,
}

/// `OpenAPI` schema wrapper for `IngestResponse` (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseIngestResponse {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The ingest result payload.
    pub data: crate::modules::siphoned::models::IngestResponse,
}

/// `OpenAPI` schema wrapper for one `EntryView` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The siphoned energy entry payload.
    pub data: crate::modules::siphoned::models::EntryView,
}

/// `OpenAPI` schema wrapper for paginated `EntryView` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated siphoned energy entries data payload.
    pub data: crate::pagination::PaginatedEntryView,
}

/// `OpenAPI` schema wrapper for paginated player balances.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedPlayerBalance {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated per-player balance payload.
    pub data: crate::pagination::PaginatedPlayerBalance,
}

/// `OpenAPI` schema wrapper for `PlayerBalanceDetail` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePlayerBalanceDetail {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The single-player balance detail payload.
    pub data: crate::modules::siphoned::models::PlayerBalanceDetail,
}

/// `OpenAPI` schema wrapper for `BatchSummary` list response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBatchSummaryList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The ingestion batch list payload.
    pub data: Vec<crate::modules::siphoned::models::BatchSummary>,
}

/// `OpenAPI` schema wrapper for `DeletedCount` response (siphoned module).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseDeletedCount {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The deletion result payload.
    pub data: crate::modules::siphoned::models::DeletedCount,
}

/// `OpenAPI` schema wrapper for the caller's season XP snapshot.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseProgressionMeView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Season XP, level, rank, multiplier, and lifetime total.
    pub data: crate::modules::progression::models::ProgressionMeView,
}

/// `OpenAPI` schema wrapper for a message XP award result.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseAwardMessageView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Whether XP was granted and why not, if skipped.
    pub data: crate::modules::progression::models::AwardMessageView,
}

/// `OpenAPI` schema wrapper for a paginated XP leaderboard.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedLeaderboardEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Leaderboard page.
    pub data: crate::pagination::PaginatedLeaderboardEntryView,
}

/// `OpenAPI` schema wrapper for a paginated XP ledger.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedXpLedgerEntryView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Ledger page.
    pub data: crate::pagination::PaginatedXpLedgerEntryView,
}

/// `OpenAPI` schema wrapper for a claimed VOD review.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseVodReviewView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Claimed VOD row.
    pub data: crate::modules::vods::models::VodReviewView,
}

/// `OpenAPI` schema wrapper for the caller's VOD review list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseVodReviewViewList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Claimed VOD rows.
    pub data: Vec<crate::modules::vods::models::VodReviewView>,
}

/// `OpenAPI` schema wrapper for a warn row.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseWarnView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Warn row.
    pub data: crate::modules::warns::models::WarnView,
}

/// `OpenAPI` schema wrapper for a paginated warn list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedWarnView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Warn page.
    pub data: crate::pagination::PaginatedWarnView,
}

/// `OpenAPI` schema wrapper for a warn escalation.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseWarnEscalationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Escalation row.
    pub data: crate::modules::warns::models::WarnEscalationView,
}

/// `OpenAPI` schema wrapper for a paginated escalation list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedWarnEscalationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Escalation page.
    pub data: crate::pagination::PaginatedWarnEscalationView,
}

/// `OpenAPI` schema wrapper for a notification inbox row.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseNotificationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Inbox row.
    pub data: crate::modules::notifications::models::NotificationView,
}

/// `OpenAPI` schema wrapper for a paginated inbox.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedNotificationView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Inbox page.
    pub data: crate::pagination::PaginatedNotificationView,
}

/// `OpenAPI` schema wrapper for the unread badge.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseUnreadCountView {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Unread count.
    pub data: crate::modules::notifications::models::UnreadCountView,
}

/// `OpenAPI` schema wrapper for mark-all-read.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseReadAllResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// How many rows flipped to read.
    pub data: crate::modules::notifications::models::ReadAllResult,
}

/// `OpenAPI` schema wrapper for a guild broadcast.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBroadcastResult {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Fan-out result.
    pub data: crate::modules::notifications::models::BroadcastResult,
}
