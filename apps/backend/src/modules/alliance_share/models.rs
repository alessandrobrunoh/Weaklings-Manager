//! Request/response DTOs for alliance artifact sharing.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Artifact kinds this endpoint accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    /// A guild build snapshot.
    Build,
    /// A guild composition snapshot, including auto-published referenced builds.
    Comp,
    /// A guild loot-split snapshot (read-only in the alliance tenant).
    Split,
}

impl ArtifactType {
    /// Stable string stored on `alliance_shares.artifact_type`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Comp => "comp",
            Self::Split => "split",
        }
    }
}

/// `POST /api/alliance/shares` body.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateAllianceShareRequest {
    /// Artifact kind (`build`, `comp`, or `split`).
    #[serde(rename = "type")]
    pub artifact_type: ArtifactType,
    /// Source id in the caller's guild tenant schema.
    pub id: i64,
}

/// A published mapping from a guild artifact to its alliance-schema copy.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AllianceShareView {
    /// Control-plane row id.
    pub id: String,
    /// Alliance tenant that holds the published copy.
    pub alliance_tenant_id: String,
    /// Guild tenant the artifact was published from.
    pub source_tenant_id: String,
    /// Artifact kind (`build`, `comp`, or `split`).
    #[serde(rename = "type")]
    pub artifact_type: String,
    /// Id in the source (guild) schema.
    pub source_id: i64,
    /// Id of the copy in the alliance schema.
    pub published_id: i64,
    /// Discord id of the officer who last published.
    pub shared_by: String,
    /// When the snapshot was last published.
    pub shared_at: String,
}

/// Whether a guild artifact is currently published into the alliance.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AllianceShareStatusView {
    /// True when a live `alliance_shares` row exists for this source artifact.
    pub shared: bool,
    /// Present when [`Self::shared`] is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share: Option<AllianceShareView>,
}
