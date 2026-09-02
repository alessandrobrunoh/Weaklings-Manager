//! Request/response DTOs and view models for the comps module.
//!
//! Business logic lives in `service.rs`; this module only defines the shapes exchanged over
//! the API and their `OpenAPI` schemas.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::status::{BuildLoadout, BuildRole, BuildSlot};

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
    /// Which loadout this item belongs to: the main set or the swap.
    pub loadout: BuildLoadout,
    /// The abilities chosen on this item. Empty for slots that offer none.
    #[serde(default)]
    pub spells: BuildItemSpells,
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

/// The abilities chosen on one equipped item, keyed by 1-based slot index.
///
/// Active slot 1/2/3 are the player's Q/W/E on a weapon; an armor piece has a single active slot,
/// bound to D (head), R (chest) or F (shoes). A slot the officer has not filled is simply absent.
#[derive(Debug, Serialize, Deserialize, Clone, Default, ToSchema)]
#[schema(example = json!({
    "active": { "1": "HEROICSTRIKE2", "3": "MIGHTYBLOW" },
    "passive": { "1": "PASSIVE_BLEEDCHANCE" }
}))]
pub struct BuildItemSpells {
    /// Chosen active abilities, by slot index.
    #[serde(default)]
    pub active: std::collections::BTreeMap<String, String>,
    /// Chosen passive abilities, by slot index.
    #[serde(default)]
    pub passive: std::collections::BTreeMap<String, String>,
}

/// One sibling version of a build, for the version switcher.
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
#[schema(example = json!({ "id": 12, "version": 2 }))]
pub struct BuildVersionRef {
    /// The build row for this version. Comps reference a specific version, not the group.
    #[schema(example = 12)]
    pub id: i64,
    /// Version number within the `(name, category)` group. Starts at 1.
    #[schema(example = 2)]
    pub version: i32,
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
    /// The version of this build within its `(name, category)` group. Starts at 1.
    #[schema(example = 1)]
    pub version: i32,
    /// The category name (if available).
    pub category_name: Option<String>,
    /// The username of the user who created the build.
    pub created_by_username: String,
    /// The timestamp when the build was last updated.
    pub updated_at: String,
    /// The number of items in the build.
    #[schema(example = 7)]
    pub item_count: u64,
    /// When this build was archived, if it has been. `None` means it's active.
    pub archived_at: Option<String>,
}

/// A build's full detail, including items.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct BuildDetail {
    /// The build's summary fields.
    #[serde(flatten)]
    pub summary: BuildSummary,
    /// The list of items in the build.
    pub items: Vec<BuildItemView>,
    /// Every version sharing this build's `(name, category)` identity, in version order —
    /// including this one, so the switcher can render the whole group from one response.
    #[serde(default)]
    pub versions: Vec<BuildVersionRef>,
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
    /// Free-text description.
    ///
    /// Previously write-only: `UpdateCompRequest` could set it but no
    /// response carried it back, so the edit form could never show what was
    /// stored.
    pub description: Option<String>,
    /// The unique identifier of the comp.
    #[schema(example = 1)]
    pub id: i64,
    /// The human-readable name of the comp.
    pub name: String,
    /// The category ID this comp belongs to.
    #[schema(example = 2)]
    pub category_id: i64,
    /// The version of this comp within its `(name, category)` group. Starts at 1.
    #[schema(example = 1)]
    pub version: i32,
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
    /// When this comp was archived, if it has been. `None` means it's active.
    pub archived_at: Option<String>,
}

/// A comp's full detail, including builds.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct CompDetail {
    /// The comp's summary fields.
    #[serde(flatten)]
    pub summary: CompSummary,
    /// The list of builds in the comp.
    pub builds: Vec<CompBuildView>,
    /// Every version sharing this comp's `(name, category)` identity, in version order —
    /// including this one, so the switcher can render the whole group from one response.
    #[serde(default)]
    pub versions: Vec<BuildVersionRef>,
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
    /// The new parent comp ID if this comp is a variant. `null` explicitly removes the parent;
    /// omitting the field leaves the current parent unchanged.
    #[serde(default, deserialize_with = "crate::serde_helpers::double_option")]
    pub parent_id: Option<Option<i64>>,
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
    /// Alias of `q` (case-insensitive partial match).
    pub search: Option<String>,
    /// Sort column. Allowed: `name`, `role`, `created_at` (default).
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
    /// When `true`, lists archived builds instead of active ones. Defaults to `false` — every
    /// picker and listing shows active builds only unless a caller explicitly asks to browse the
    /// archive.
    pub archived: Option<bool>,
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
    /// Sort column. Allowed: `name`, `created_at` (default), `category`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc`.
    pub order: Option<String>,
    /// When `true`, lists archived comps instead of active ones. Defaults to `false` — every
    /// picker and listing shows active comps only unless a caller explicitly asks to browse the
    /// archive.
    pub archived: Option<bool>,
}
