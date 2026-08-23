//! Request/response DTOs and view models for the comps module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over
//! the API and their `OpenAPI` schemas.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::{BuildRole, BuildSlot};

/// A build category view model.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BuildCategoryView {
    /// The unique identifier of the build category.
    #[schema(example = 1)]
    pub id: i64,
    /// The human-readable name of the build category.
    pub name: String,
    /// A URL-friendly slug for the build category.
    pub slug: String,
    /// An optional description of the build category.
    pub description: Option<String>,
    /// The timestamp when the build category was created.
    pub created_at: String,
}

/// A comp category view model.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompCategoryView {
    /// The unique identifier of the comp category.
    #[schema(example = 1)]
    pub id: i64,
    /// The human-readable name of the comp category.
    pub name: String,
    /// A URL-friendly slug for the comp category.
    pub slug: String,
    /// An optional description of the comp category.
    pub description: Option<String>,
    /// The timestamp when the comp category was created.
    pub created_at: String,
}

/// A build item view model.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BuildItemView {
    /// The equipment slot of this item.
    pub slot: BuildSlot,
    /// The OpenAlbion item type.
    pub openalbion_item_type: String,
    /// The OpenAlbion item ID.
    #[schema(example = 4532)]
    pub openalbion_item_id: i64,
    /// The OpenAlbion item name.
    pub openalbion_item_name: String,
    /// The OpenAlbion item icon URL.
    pub openalbion_item_icon: Option<String>,
    /// The OpenAlbion item tier.
    pub openalbion_item_tier: Option<String>,
}

/// A build's summary, as shown in list views.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BuildSummary {
    /// Free-text description.
    ///
    /// Previously write-only: the update request could set it but no response
    /// carried it back, so the edit form could never show what was stored.
    pub description: Option<String>,
    /// The unique identifier of the build.
    #[schema(example = 1)]
    pub id: i64,
    /// The human-readable name of the build.
    pub name: String,
    /// The role of the build.
    pub role: BuildRole,
    /// The category ID this build belongs to.
    #[schema(example = 3)]
    pub category_id: i64,
    /// The category name (if available).
    pub category_name: Option<String>,
    /// The username of the user who created the build.
    pub created_by_username: String,
    /// The timestamp when the build was last updated.
    pub updated_at: String,
    /// The number of items in the build.
    #[schema(example = 7)]
    pub item_count: u64,
}

/// A build's full detail, including items.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BuildDetail {
    /// The build's summary fields.
    #[serde(flatten)]
    pub summary: BuildSummary,
    /// The list of items in the build.
    pub items: Vec<BuildItemView>,
}

/// A comp build view model within a comp.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompBuildView {
    /// The build ID.
    #[schema(example = 5)]
    pub build_id: i64,
    /// The build summary.
    pub build: BuildSummary,
    /// The quantity of this build in the comp.
    #[schema(example = 2)]
    pub quantity: i32,
}

/// A comp's summary, as shown in list views.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompSummary {
    /// The unique identifier of the comp.
    #[schema(example = 1)]
    pub id: i64,
    /// The human-readable name of the comp.
    pub name: String,
    /// The category ID this comp belongs to.
    #[schema(example = 2)]
    pub category_id: i64,
    /// The category name (if available).
    pub category_name: Option<String>,
    /// The username of the user who created the comp.
    pub created_by_username: String,
    /// The timestamp when the comp was created.
    pub created_at: String,
    /// The number of distinct builds in the comp.
    #[schema(example = 5)]
    pub build_count: u64,
    /// The total quantity of all builds in the comp.
    #[schema(example = 20)]
    pub total_quantity: i64,
    /// The parent comp ID if this comp is a variant.
    pub parent_id: Option<i64>,
}

/// A comp's full detail, including builds.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompDetail {
    /// The comp's summary fields.
    #[serde(flatten)]
    pub summary: CompSummary,
    /// The list of builds in the comp.
    pub builds: Vec<CompBuildView>,
}

/// Request body to create a build category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "PvE Healers",
    "description": "Healing builds for PvE content"
}))]
pub struct CreateBuildCategoryRequest {
    /// The human-readable name of the build category.
    pub name: String,
    /// An optional description of the build category.
    pub description: Option<String>,
}

/// Request body to update a build category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "PvE Healers (Updated)",
    "description": "Healing builds for PvE content and dungeons"
}))]
pub struct UpdateBuildCategoryRequest {
    /// The new human-readable name of the build category.
    pub name: Option<String>,
    /// The new description of the build category.
    pub description: Option<String>,
}

/// Request body to create a comp category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "10v10 HG",
    "description": "10v10 Hellgate compositions"
}))]
pub struct CreateCompCategoryRequest {
    /// The human-readable name of the comp category.
    pub name: String,
    /// An optional description of the comp category.
    pub description: Option<String>,
}

/// Request body to update a comp category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "10v10 HG (Updated)",
    "description": "10v10 Hellgate compositions and strategies"
}))]
pub struct UpdateCompCategoryRequest {
    /// The new human-readable name of the comp category.
    pub name: Option<String>,
    /// The new description of the comp category.
    pub description: Option<String>,
}

/// Request body to create a build.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "Holy Healer",
    "description": "Standard holy staff healer",
    "role": "healer",
    "category_id": 3,
    "items": [
        {
            "slot": "weapon",
            "openalbion_item_type": "weapon",
            "openalbion_item_id": 4532,
            "openalbion_item_name": "Holy Staff",
            "openalbion_item_icon": "https://...",
            "openalbion_item_tier": "8.0"
        }
    ]
}))]
pub struct CreateBuildRequest {
    /// The human-readable name of the build.
    pub name: String,
    /// An optional description of the build.
    pub description: Option<String>,
    /// The role of the build.
    pub role: BuildRole,
    /// The category ID this build belongs to.
    pub category_id: i64,
    /// Optional list of slotted items to include in the build.
    pub items: Option<Vec<CreateBuildItemRequest>>,
}

/// Request body to update a build.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "Holy Healer (Updated)",
    "description": "Standard holy staff healer with more focus"
}))]
pub struct UpdateBuildRequest {
    /// The new human-readable name of the build.
    pub name: Option<String>,
    /// The new description of the build.
    pub description: Option<String>,
    /// The new role of the build.
    pub role: Option<BuildRole>,
    /// The new category ID this build belongs to.
    pub category_id: Option<i64>,
}

/// Request body to create an initial build item with its equipment slot.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "slot": "weapon",
    "openalbion_item_type": "weapon",
    "openalbion_item_id": 4532,
    "openalbion_item_name": "Holy Staff",
    "openalbion_item_icon": "https://...",
    "openalbion_item_tier": "8.0"
}))]
pub struct CreateBuildItemRequest {
    /// The equipment slot where this item belongs.
    pub slot: BuildSlot,
    /// The OpenAlbion item type.
    pub openalbion_item_type: String,
    /// The OpenAlbion item ID.
    pub openalbion_item_id: i64,
    /// The OpenAlbion item name.
    pub openalbion_item_name: String,
    /// The OpenAlbion item icon URL.
    pub openalbion_item_icon: Option<String>,
    /// The OpenAlbion item tier.
    pub openalbion_item_tier: Option<String>,
}

/// Request body to upsert a build item.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "openalbion_item_type": "weapon",
    "openalbion_item_id": 4532,
    "openalbion_item_name": "Holy Staff",
    "openalbion_item_icon": "https://...",
    "openalbion_item_tier": "8.0"
}))]
pub struct UpsertBuildItemRequest {
    /// The OpenAlbion item type.
    pub openalbion_item_type: String,
    /// The OpenAlbion item ID.
    pub openalbion_item_id: i64,
    /// The OpenAlbion item name.
    pub openalbion_item_name: String,
    /// The OpenAlbion item icon URL.
    pub openalbion_item_icon: Option<String>,
    /// The OpenAlbion item tier.
    pub openalbion_item_tier: Option<String>,
}

/// Request body to create a comp.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "10v10 HG Standard",
    "description": "Standard 10v10 Hellgate composition",
    "category_id": 2,
    "builds": [
        { "build_id": 5, "quantity": 2 },
        { "build_id": 7, "quantity": 4 }
    ]
}))]
pub struct CreateCompRequest {
    /// The human-readable name of the comp.
    pub name: String,
    /// An optional description of the comp.
    pub description: Option<String>,
    /// The category ID this comp belongs to.
    pub category_id: i64,
    /// The list of builds to include in the comp.
    pub builds: Vec<AddCompBuildRequest>,
    /// The parent comp ID if this comp is a variant.
    pub parent_id: Option<i64>,
}

/// Request body to update a comp.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "name": "10v10 HG Standard (Updated)",
    "description": "Standard 10v10 Hellgate composition with more heals"
}))]
pub struct UpdateCompRequest {
    /// The new human-readable name of the comp.
    pub name: Option<String>,
    /// The new description of the comp.
    pub description: Option<String>,
    /// The new category ID this comp belongs to.
    pub category_id: Option<i64>,
    /// The new parent comp ID if this comp is a variant.
    pub parent_id: Option<i64>,
}

/// Request body to add a build to a comp.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "build_id": 5,
    "quantity": 2
}))]
pub struct AddCompBuildRequest {
    /// The build ID to add.
    pub build_id: i64,
    /// The quantity of this build in the comp.
    #[schema(example = 2)]
    pub quantity: i32,
}

/// Request body to update a comp build quantity.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[schema(example = json!({
    "quantity": 3
}))]
pub struct UpdateCompBuildQuantityRequest {
    /// The new quantity of this build in the comp.
    #[schema(example = 3)]
    pub quantity: i32,
}

/// Filters for listing builds.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct BuildFilters {
    /// Filter by build role.
    pub role: Option<BuildRole>,
    /// Filter by category ID.
    pub category_id: Option<i64>,
    /// Filter by build name (case-insensitive partial match).
    pub q: Option<String>,
}

/// Filters for listing comps.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct CompFilters {
    /// Filter by category ID.
    pub category_id: Option<i64>,
    /// Filter by comp name (case-insensitive partial match).
    pub q: Option<String>,
    /// Filter by search keyword (case-insensitive partial match, replaces `q`).
    pub search: Option<String>,
    /// Filter by created date (inclusive).
    pub date_from: Option<String>,
    /// Filter by created date (inclusive).
    pub date_to: Option<String>,
}
