//! Generic Pagination utility.
//!
//! Provides request parameter extractors and standardized response schemas for pagination.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::errors::AppError;

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

/// Largest page a client may ask for.
///
/// Not a round number for its own sake: the web client legitimately asks for
/// 500 when it loads every comp or build name into a picker, so the ceiling has
/// to clear that with room to spare while still bounding what one request can
/// pull out of the database.
pub const MAX_PAGE_LIMIT: u64 = 1_000;

impl PaginationParams {
    /// Gets the normalized page limit (defaults to 10), clamped to
    /// `1..=`[`MAX_PAGE_LIMIT`].
    ///
    /// The lower bound is load-bearing, not tidiness: `SeaORM`'s `paginate`
    /// asserts `page_size != 0`, so an un-clamped `?limit=0` panics the handler
    /// before it reaches the database and drops the connection with no
    /// response.
    #[must_use]
    pub fn limit(&self) -> u64 {
        self.limit.unwrap_or(10).clamp(1, MAX_PAGE_LIMIT)
    }

    /// Gets the normalized page number as a 0-based offset index for database queries.
    #[must_use]
    pub fn offset_page(&self) -> u64 {
        self.page.unwrap_or(1).saturating_sub(1)
    }
}

/// Slices an already-filtered in-memory list into a [`PaginatedData`] envelope.
#[must_use]
pub fn paginate_vec<T>(items: Vec<T>, pagination: &PaginationParams) -> PaginatedData<T> {
    let limit = pagination.limit().max(1);
    let total_items = items.len() as u64;
    let total_pages = total_items.div_ceil(limit).max(1);
    let start = (pagination.offset_page() * limit) as usize;
    let page_items = if start >= items.len() {
        Vec::new()
    } else {
        items.into_iter().skip(start).take(limit as usize).collect()
    };
    PaginatedData::new(
        page_items,
        total_items,
        total_pages,
        pagination.offset_page() + 1,
        limit,
    )
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

#[cfg(test)]
mod tests {
    use super::{MAX_PAGE_LIMIT, PaginationParams, SortOrder, resolve_sort_key};
    use crate::errors::AppError;

    fn params(limit: Option<u64>) -> PaginationParams {
        PaginationParams { page: None, limit }
    }

    #[test]
    fn limit_defaults_to_ten() {
        assert_eq!(params(None).limit(), 10);
    }

    /// `SeaORM`'s paginator asserts `page_size != 0`, so a zero here would
    /// panic the handler rather than return an empty page.
    #[test]
    fn limit_zero_is_lifted_to_one() {
        assert_eq!(params(Some(0)).limit(), 1);
    }

    #[test]
    fn limit_is_capped() {
        assert_eq!(params(Some(u64::MAX)).limit(), MAX_PAGE_LIMIT);
        assert_eq!(params(Some(MAX_PAGE_LIMIT + 1)).limit(), MAX_PAGE_LIMIT);
    }

    /// The picker screens ask for 500 and must keep getting 500.
    #[test]
    fn limits_the_client_actually_uses_pass_through() {
        for requested in [1, 25, 100, 500] {
            assert_eq!(params(Some(requested)).limit(), requested);
        }
    }

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
