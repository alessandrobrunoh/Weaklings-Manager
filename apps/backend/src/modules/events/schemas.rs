//! `OpenAPI` response schemas for the `events` module.
//!
//! Concrete `ApiResponse*` and `Paginated*` wrappers; utoipa names each schema after its type.

use serde::Serialize;
use utoipa::ToSchema;

use crate::pagination::PaginatedData;

/// `OpenAPI` schema wrapper for one build version's battle performance.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseBuildPerformance {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Performance data payload.
    pub data: crate::modules::events::models::BuildPerformanceView,
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

/// `OpenAPI` schema wrapper for Paginated `EventView` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The paginated event summaries data payload.
    pub data: PaginatedEventSummary,
}

/// `OpenAPI` schema wrapper for the event summary counts.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventSummary {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Counts over every non-archived event.
    pub data: crate::modules::events::models::EventSummary,
}

/// `OpenAPI` schema wrapper for the eligible participation-guild list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseParticipationGuildList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// The caller's eligible active guilds for the event.
    pub data: Vec<crate::modules::events::attribution::ParticipationGuild>,
}

/// `OpenAPI` schema wrapper for the complete live/upcoming event calendar feed.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventCalendarList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Every non-archived live event and future scheduled event.
    pub data: Vec<crate::modules::events::models::EventView>,
}

/// `OpenAPI` schema wrapper for event revision fingerprints.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventRevisionList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Status/roster fingerprints for the requested event ids.
    pub data: Vec<crate::modules::events::models::EventRevision>,
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

/// `OpenAPI` schema wrapper for a canonical event's fanout results.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventFanoutStatus {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Per-tenant copy state for the alliance-owned event.
    pub data: crate::modules::events::fanout_outbox::EventFanoutStatus,
}

/// `OpenAPI` schema wrapper for the event management-authority decision.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventManagementAuthority {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Whether the caller is the organizer and may manage the event.
    pub data: crate::modules::events::models::EventManagementAuthorityView,
}

/// `OpenAPI` schema wrapper for event roster-role list responses.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseEventRosterRoleList {
    /// Indicates the outcome of the request, always "success".
    #[schema(example = "success")]
    pub status: String,
    /// Event roster roles, starting with the virtual `Fill` role.
    pub data: Vec<crate::modules::events::models::EventRosterRoleView>,
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

/// Concrete paginated event summary response schema for `OpenAPI`.
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
