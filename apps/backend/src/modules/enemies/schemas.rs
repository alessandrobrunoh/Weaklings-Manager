//! `OpenAPI` response schemas for the `enemies` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for a paginated enemy guild list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedEnemyGuilds {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Enemy guild page.
    pub data: PaginatedEnemyGuildSummary,
}

/// `OpenAPI` schema wrapper for one enemy guild dossier.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEnemyGuildDossier {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Enemy guild dossier.
    pub data: crate::modules::enemies::models::EnemyGuildDossier,
}

/// `OpenAPI` schema wrapper for a paginated enemy player list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponsePaginatedEnemyPlayers {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Enemy player page.
    pub data: PaginatedEnemyPlayerSummary,
}

/// `OpenAPI` schema wrapper for one enemy player dossier.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEnemyPlayerDossier {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Enemy player dossier.
    pub data: crate::modules::enemies::models::EnemyPlayerDossier,
}

/// Concrete paginated enemy guild summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedEnemyGuildSummary {
    /// List of enemy guild summaries on the current page.
    pub items: Vec<crate::modules::enemies::models::EnemyGuildSummary>,
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

impl From<PaginatedData<crate::modules::enemies::models::EnemyGuildSummary>>
    for PaginatedEnemyGuildSummary
{
    fn from(data: PaginatedData<crate::modules::enemies::models::EnemyGuildSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

/// Concrete paginated enemy player summary response schema for `OpenAPI`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PaginatedEnemyPlayerSummary {
    /// List of enemy player summaries on the current page.
    pub items: Vec<crate::modules::enemies::models::EnemyPlayerSummary>,
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

impl From<PaginatedData<crate::modules::enemies::models::EnemyPlayerSummary>>
    for PaginatedEnemyPlayerSummary
{
    fn from(data: PaginatedData<crate::modules::enemies::models::EnemyPlayerSummary>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}
