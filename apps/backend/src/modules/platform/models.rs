//! Request/response types for the platform API.

use serde::{Deserialize, Serialize};

/// A tenant row in the control-plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct TenantView {
    /// Discord guild snowflake.
    pub id: String,
    /// Display name.
    pub name: String,
    /// URL-ish slug.
    pub slug: String,
    /// Postgres schema name.
    pub schema_name: String,
    /// `provisioning`, `active`, or `suspended`.
    pub status: String,
    /// Optional owner Discord id.
    pub owner_discord_id: Option<String>,
    /// RFC3339 created timestamp, if present.
    pub created_at: Option<String>,
    /// RFC3339 suspended timestamp, if present.
    pub suspended_at: Option<String>,
    /// Albion Online guild id this tenant pulls data from.
    #[serde(default)]
    pub albion_guild_id: Option<String>,
    /// Albion gameinfo region (`europe`, `americas`, `asia`).
    #[serde(default)]
    pub albion_api_region: Option<String>,
    /// Discord guild icon hash, when known.
    #[serde(default)]
    pub icon_hash: Option<String>,
}

/// Body for `POST /api/platform/tenants`.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct CreateTenantRequest {
    /// Discord guild snowflake (becomes `tenants.id`).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional slug; derived from `id` when omitted.
    pub slug: Option<String>,
    /// Albion Online guild id.
    #[serde(default)]
    pub albion_guild_id: Option<String>,
    /// Albion region: `europe`, `americas`, or `asia`.
    #[serde(default)]
    pub albion_api_region: Option<String>,
}

/// Body for `POST /api/tenants/register` (first-time onboarding).
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct RegisterTenantRequest {
    /// Discord guild snowflake.
    pub id: String,
    /// Display name for the tenant.
    pub name: String,
    /// Albion Online guild id to pull roster/battles from.
    pub albion_guild_id: String,
    /// Albion gameinfo region: `europe`, `americas`, or `asia`.
    pub albion_api_region: String,
    /// Optional comma-separated allied Albion guild ids.
    pub albion_allied_guild_ids: Option<String>,
    /// Optional comma-separated allied Albion guild names.
    pub albion_allied_guild_names: Option<String>,
}

/// Public status of a Discord guild against the tenant registry.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct TenantStatusView {
    /// Discord guild id queried.
    pub id: String,
    /// Whether an active/provisioning/suspended tenant row exists.
    pub registered: bool,
    /// Tenant status when registered.
    pub status: Option<String>,
    /// Tenant display name when registered.
    pub name: Option<String>,
    /// Absolute URL of the onboarding wizard when not registered.
    pub register_url: Option<String>,
}

/// Body for `PATCH /api/platform/tenants/{id}`.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct PatchTenantRequest {
    /// Set to `active` or `suspended`.
    pub status: Option<String>,
    /// Optional rename.
    pub name: Option<String>,
}

/// One feature in the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct FeatureCatalogItem {
    /// Stable key (`regolamento`, `splits.paid`).
    pub key: String,
    /// Human label.
    pub display_name: String,
    /// Optional description.
    pub description: Option<String>,
}

/// Per-tenant flag state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct TenantFeatureFlag {
    /// Catalog key.
    pub key: String,
    /// Whether the feature is on.
    pub enabled: bool,
}

/// GET payload for a tenant's flags.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct TenantFeaturesView {
    /// Catalog of known features.
    pub catalog: Vec<FeatureCatalogItem>,
    /// Current flags for this tenant.
    pub flags: Vec<TenantFeatureFlag>,
}

/// PUT payload for a tenant's flags.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct PutTenantFeaturesRequest {
    /// Desired flag states. Missing keys are left unchanged.
    pub flags: Vec<TenantFeatureFlag>,
}

/// A platform-role assignment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct PlatformAdminView {
    /// Discord snowflake.
    pub discord_id: String,
    /// Platform role id.
    pub role_id: String,
    /// Platform role name.
    pub role_name: String,
}

/// Body for `POST /api/platform/admins`.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
pub struct AssignAdminRequest {
    /// Discord snowflake to grant SuperAdmin.
    pub discord_id: String,
}
