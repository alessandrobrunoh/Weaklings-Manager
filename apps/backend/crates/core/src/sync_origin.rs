//! Synchronization vocabulary shared below the sync engine: which entity kinds
//! synchronize, and where a read-only copy's origin lives.

use serde::Serialize;
use utoipa::ToSchema;

/// Entity kinds that take part in synchronization (F2 covers the two that have
/// a legacy copy mechanism guarded by the API).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SyncKind {
    /// A scheduled or live event.
    Event,
    /// A loot split.
    Split,
}

impl SyncKind {
    /// Lowercase singular name, as used in messages and problem bodies.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Split => "split",
        }
    }

    /// Relative API/UI path of one entity of this kind (`/events/12`).
    #[must_use]
    pub fn path(self, id: i64) -> String {
        match self {
            Self::Event => format!("/events/{id}"),
            Self::Split => format!("/splits/{id}"),
        }
    }
}

/// Reference to the authoritative entity a read-only copy points back to.
///
/// Fields the legacy data does not record are `None` (and absent from the JSON);
/// the `sync_copies` backing fills them all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct OriginRef {
    /// Tenant that owns the entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// Display name of the owning tenant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_name: Option<String>,
    /// `guild` or `alliance`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_kind: Option<String>,
    /// What kind of entity the copy is.
    pub kind: SyncKind,
    /// The entity's id inside the owning tenant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<i64>,
    /// Relative route of the entity in the owning tenant (`/events/123`); the
    /// tenant switch is the client's job.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl OriginRef {
    /// One-line, human-readable explanation used as the problem `detail`.
    #[must_use]
    pub fn summary(&self) -> String {
        let owner = match (&self.tenant_name, &self.tenant_id) {
            (Some(name), _) if !name.is_empty() => format!("tenant {name}"),
            (_, Some(id)) if !id.is_empty() => format!("tenant {id}"),
            _ => "another tenant".to_owned(),
        };
        format!(
            "this {} is a synchronized copy owned by {owner}; \
             manage it from the owner tenant instead",
            self.kind.as_str()
        )
    }
}
