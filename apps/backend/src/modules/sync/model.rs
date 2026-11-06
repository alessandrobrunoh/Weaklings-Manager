//! Sync metadata that entity views carry (`sync` block, SA-8 and the slices
//! that attach it to events, builds, comps and splits).

use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

/// Where an entity stands in synchronization, from the viewer's tenant.
#[allow(
    dead_code,
    reason = "attached to entity views by the slices that own each kind (SY-2 onwards)"
)]
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SyncInfo {
    /// `origin` or `copy`.
    pub role: String,
    /// True for copies that the viewer may not mutate.
    pub read_only: bool,
    /// `ok`, `pending`, `failed`, `blocked` or `detached`.
    pub state: String,
    /// The owning tenant, for copies.
    pub origin: Option<OriginInfo>,
    /// When the copy last converged.
    pub synced_at: Option<DateTime<Utc>>,
    /// Target counts, for origins only.
    pub targets: Option<TargetCounts>,
}

/// Owning tenant of a copy.
#[allow(dead_code, reason = "part of SyncInfo")]
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OriginInfo {
    /// Owning tenant id.
    pub tenant_id: String,
    /// Owning tenant display name.
    pub tenant_name: String,
    /// `guild` or `alliance`.
    pub tenant_kind: String,
    /// Entity id in the owning tenant.
    pub entity_id: i64,
    /// Relative route in the owning tenant.
    pub path: String,
}

/// Delivery counts across the targets of an origin entity.
#[allow(dead_code, reason = "part of SyncInfo")]
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TargetCounts {
    /// Targets in total.
    pub total: i64,
    /// Targets converged.
    pub ok: i64,
    /// Targets waiting or running.
    pub pending: i64,
    /// Targets exhausted.
    pub failed: i64,
}
