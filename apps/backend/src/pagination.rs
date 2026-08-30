//! Generic Pagination utility.
//!
//! Provides request parameter extractors and standardized response schemas for pagination.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::bank::models::TransactionView;

/// Parameters for pagination in request queries.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PaginationParams {
    /// The page number to fetch (1-indexed). Defaults to 1.
    #[schema(example = 1, default = 1)]
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    #[schema(example = 10, default = 10)]
    pub limit: Option<u64>,
}

impl PaginationParams {
    /// Gets the normalized page limit (defaults to 10).
    #[must_use]
    pub fn limit(&self) -> u64 {
        self.limit.unwrap_or(10)
    }

    /// Gets the normalized page number as a 0-based offset index for database queries.
    #[must_use]
    pub fn offset_page(&self) -> u64 {
        self.page.unwrap_or(1).saturating_sub(1)
    }
}

/// Sort direction for list endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    /// Oldest / smallest first.
    Asc,
    /// Newest / largest first. Default when the client omits `order`.
    #[default]
    Desc,
}

impl SortOrder {
    /// Parses `order=asc|desc`. Anything else, including absence, is descending.
    #[must_use]
    pub fn from_query(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("asc") => Self::Asc,
            _ => Self::Desc,
        }
    }
}

/// Resolves a requested sort key against a whitelist.
///
/// An unknown key is a validation error so a typo cannot silently fall back
/// to the default and look like the API ignored the client.
///
/// # Errors
///
/// Returns [`AppError::Validation`] when `requested` is non-empty and not in `allowed`.
pub fn resolve_sort_key<T: Copy>(
    requested: Option<&str>,
    allowed: &[(&str, T)],
    default: T,
) -> Result<T, AppError> {
    let Some(key) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(default);
    };
    allowed
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| *value)
        .ok_or_else(|| AppError::Validation(format!("unknown sort column '{key}'")))
}

/// A standard paginated data envelope.
#[derive(Debug, Clone, Serialize)]
pub struct PaginatedData<T> {
    /// List of items on the current page.
    pub items: Vec<T>,
    /// Total number of items across all pages.
    pub total_items: u64,
    /// Total number of pages.
    pub total_pages: u64,
    /// The current page number (1-indexed).
    pub current_page: u64,
    /// The number of items per page.
    pub limit: u64,
}

impl<T> PaginatedData<T> {
    /// Constructs a new `PaginatedData` wrapper.
    pub fn new(
        items: Vec<T>,
        total_items: u64,
        total_pages: u64,
        current_page: u64,
        limit: u64,
    ) -> Self {
        Self {
            items,
            total_items,
            total_pages,
            current_page,
            limit,
        }
    }
}

/// Concrete paginated user profile response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedUserProfile {
    /// List of user profiles on the current page.
    pub items: Vec<crate::modules::users::service::UserProfile>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::users::service::UserProfile>> for PaginatedUserProfile {
    fn from(data: PaginatedData<crate::modules::users::service::UserProfile>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated transaction response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedTransactionView {
    /// List of transactions on the current page.
    pub items: Vec<TransactionView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<TransactionView>> for PaginatedTransactionView {
    fn from(data: PaginatedData<TransactionView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated split summary response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedSplitSummary {
    /// List of split summaries on the current page.
    pub items: Vec<crate::modules::splits::models::SplitSummary>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::splits::models::SplitSummary>> for PaginatedSplitSummary {
    fn from(data: PaginatedData<crate::modules::splits::models::SplitSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated Albion guild member response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedAlbionGuildMember {
    /// List of guild members on the current page.
    pub items: Vec<crate::modules::albion::client::AlbionGuildMember>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::albion::client::AlbionGuildMember>>
    for PaginatedAlbionGuildMember
{
    fn from(data: PaginatedData<crate::modules::albion::client::AlbionGuildMember>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated `OpenAlbion` weapon response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedOpenAlbionWeapon {
    /// List of weapons on the current page.
    pub items: Vec<crate::modules::openalbion::client::OpenAlbionWeapon>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::openalbion::client::OpenAlbionWeapon>>
    for PaginatedOpenAlbionWeapon
{
    fn from(data: PaginatedData<crate::modules::openalbion::client::OpenAlbionWeapon>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated `OpenAlbionItem` response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedOpenAlbionItem {
    /// List of items on the current page.
    pub items: Vec<crate::modules::openalbion::client::OpenAlbionItem>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::openalbion::client::OpenAlbionItem>>
    for PaginatedOpenAlbionItem
{
    fn from(data: PaginatedData<crate::modules::openalbion::client::OpenAlbionItem>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated comp summary response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedCompSummary {
    /// List of comp summaries on the current page.
    pub items: Vec<crate::modules::comps::models::CompSummary>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::comps::models::CompSummary>> for PaginatedCompSummary {
    fn from(data: PaginatedData<crate::modules::comps::models::CompSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated build summary response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedBuildSummary {
    /// List of build summaries on the current page.
    pub items: Vec<crate::modules::comps::models::BuildSummary>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::comps::models::BuildSummary>> for PaginatedBuildSummary {
    fn from(data: PaginatedData<crate::modules::comps::models::BuildSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated event summary response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedEventSummary {
    /// List of event summaries on the current page.
    pub items: Vec<crate::modules::events::models::EventView>,
    /// Total number of items across all pages.
    #[schema(example = 15)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 2)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::events::models::EventView>> for PaginatedEventSummary {
    fn from(data: PaginatedData<crate::modules::events::models::EventView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated BattleSummary response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedBattleSummary {
    /// List of battle summaries on the current page.
    pub items: Vec<crate::modules::battles::models::BattleSummary>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::battles::models::BattleSummary>>
    for PaginatedBattleSummary
{
    fn from(data: PaginatedData<crate::modules::battles::models::BattleSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated `EntryView` response schema for `OpenAPI` (siphoned module).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedEntryView {
    /// List of siphoned energy entries on the current page.
    pub items: Vec<crate::modules::siphoned::models::EntryView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 50)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::siphoned::models::EntryView>> for PaginatedEntryView {
    fn from(data: PaginatedData<crate::modules::siphoned::models::EntryView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated `DeathView` response schema for `OpenAPI` (regear module).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedDeathView {
    /// List of regear deaths on the current page.
    pub items: Vec<crate::modules::regear::models::DeathView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 50)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::regear::models::DeathView>> for PaginatedDeathView {
    fn from(data: PaginatedData<crate::modules::regear::models::DeathView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated scouted-comp response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedScoutedComp {
    /// List of scouted enemy compositions on the current page.
    pub items: Vec<crate::modules::intel::models::ScoutedCompSummary>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::intel::models::ScoutedCompSummary>>
    for PaginatedScoutedComp
{
    fn from(data: PaginatedData<crate::modules::intel::models::ScoutedCompSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated XP leaderboard response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedLeaderboardEntryView {
    /// Leaderboard rows on the current page.
    pub items: Vec<crate::modules::progression::models::LeaderboardEntryView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::progression::models::LeaderboardEntryView>>
    for PaginatedLeaderboardEntryView
{
    fn from(
        data: PaginatedData<crate::modules::progression::models::LeaderboardEntryView>,
    ) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated XP ledger response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedXpLedgerEntryView {
    /// Ledger rows on the current page.
    pub items: Vec<crate::modules::progression::models::XpLedgerEntryView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::progression::models::XpLedgerEntryView>>
    for PaginatedXpLedgerEntryView
{
    fn from(data: PaginatedData<crate::modules::progression::models::XpLedgerEntryView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated warn list response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedWarnView {
    /// Warn rows on the current page.
    pub items: Vec<crate::modules::warns::models::WarnView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::warns::models::WarnView>> for PaginatedWarnView {
    fn from(data: PaginatedData<crate::modules::warns::models::WarnView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated warn-escalation response schema for OpenAPI.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedWarnEscalationView {
    /// Escalation rows on the current page.
    pub items: Vec<crate::modules::warns::models::WarnEscalationView>,
    /// Total number of items across all pages.
    #[schema(example = 42)]
    pub total_items: u64,
    /// Total number of pages.
    #[schema(example = 5)]
    pub total_pages: u64,
    /// The current page number (1-indexed).
    #[schema(example = 1)]
    pub current_page: u64,
    /// The number of items per page.
    #[schema(example = 10)]
    pub limit: u64,
}

impl From<PaginatedData<crate::modules::warns::models::WarnEscalationView>>
    for PaginatedWarnEscalationView
{
    fn from(data: PaginatedData<crate::modules::warns::models::WarnEscalationView>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SortOrder, resolve_sort_key};
    use crate::errors::AppError;

    #[test]
    fn resolve_sort_key_falls_back_to_default_when_absent() {
        let column = resolve_sort_key(None, &[("title", "title")], "created_at").unwrap();
        assert_eq!(column, "created_at");
        let column = resolve_sort_key(Some("  "), &[("title", "title")], "created_at").unwrap();
        assert_eq!(column, "created_at");
    }

    #[test]
    fn resolve_sort_key_matches_whitelist_case_insensitively() {
        let column = resolve_sort_key(Some("Title"), &[("title", "title")], "created_at").unwrap();
        assert_eq!(column, "title");
    }

    #[test]
    fn resolve_sort_key_rejects_unknown_columns() {
        let error =
            resolve_sort_key(Some("fame"), &[("title", "title")], "created_at").unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn sort_order_from_query_defaults_to_desc() {
        assert_eq!(SortOrder::from_query(None), SortOrder::Desc);
        assert_eq!(SortOrder::from_query(Some("ASC")), SortOrder::Asc);
        assert_eq!(SortOrder::from_query(Some("nope")), SortOrder::Desc);
    }
}
