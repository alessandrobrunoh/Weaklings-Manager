//! The write guard: copies are read-only, the origin owns the data.
//!
//! [`assert_writable`] replaces `events::lifecycle::assert_manageable_source_event`
//! and the copy half of `SplitService::deny_mutation`. A mutation that only
//! touches tenant-local state (voice channel ids, Discord threads, XP awards,
//! battle links) must not call it; those exceptions are explicit at the call
//! sites and listed in the route matrix test.

use std::collections::HashMap;

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, Statement, Value,
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::splits::entities::split;

use super::copy_role::{
    CopyLink, CopyRole, LegacyLinks, SyncKind, legacy_copy_link, split_copy_link,
};

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

/// Role and origin of one copy, as returned by [`copy_info`].
#[allow(
    dead_code,
    reason = "consumed by the SA-8 `sync` block on entity views"
)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyInfo {
    /// [`CopyRole::ActiveCopy`] or [`CopyRole::DetachedCopy`].
    pub role: CopyRole,
    /// Where the origin lives.
    pub origin: OriginRef,
}

/// Display name and kind of tenants, keyed by id. Best effort: a failure only
/// costs the decoration, never the verdict.
async fn tenant_labels(
    control: &DatabaseConnection,
    ids: &[String],
) -> HashMap<String, (String, String)> {
    let mut labels = HashMap::new();
    if ids.is_empty() {
        return labels;
    }
    let placeholders = (1..=ids.len())
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT id, name, kind FROM tenants WHERE id IN ({placeholders})");
    let values: Vec<Value> = ids.iter().cloned().map(Value::from).collect();
    match control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            &sql,
            values,
        ))
        .await
    {
        Ok(rows) => {
            for row in rows {
                if let (Ok(id), Ok(name), Ok(kind)) = (
                    row.try_get_by_index::<String>(0),
                    row.try_get_by_index::<String>(1),
                    row.try_get_by_index::<String>(2),
                ) {
                    labels.insert(id, (name, kind));
                }
            }
        }
        Err(error) => tracing::debug!(error = %error, "could not resolve origin tenant labels"),
    }
    labels
}

fn origin_ref(
    kind: SyncKind,
    link: &CopyLink,
    labels: &HashMap<String, (String, String)>,
) -> OriginRef {
    let tenant_id = (!link.origin_tenant_id.is_empty()).then(|| link.origin_tenant_id.clone());
    let label = tenant_id.as_ref().and_then(|id| labels.get(id));
    OriginRef {
        tenant_name: label
            .map(|(name, _)| name.clone())
            .or_else(|| tenant_id.clone()),
        tenant_kind: label.map(|(_, tenant_kind)| tenant_kind.clone()),
        tenant_id,
        kind,
        entity_id: link.origin_entity_id,
        path: link.origin_entity_id.map(|id| kind.path(id)),
    }
}

async fn read_only_error(
    legacy: Option<LegacyLinks<'_>>,
    kind: SyncKind,
    link: &CopyLink,
) -> AppError {
    let labels = match legacy {
        Some(legacy) if !link.origin_tenant_id.is_empty() => {
            tenant_labels(legacy.control, std::slice::from_ref(&link.origin_tenant_id)).await
        }
        _ => HashMap::new(),
    };
    AppError::ReadOnlyCopy(Box::new(origin_ref(kind, link, &labels)))
}

/// Rejects a write on a read-only copy of another tenant's entity.
///
/// Origins, non-synced rows and detached copies (a link disabled by a
/// membership departure) pass. Does not check that the row exists: the caller's
/// own lookup reports `NotFound`.
///
/// # Errors
///
/// * [`AppError::ReadOnlyCopy`] (HTTP 403, `origin` set) for an active copy.
/// * [`AppError::Database`] when the lookup fails.
pub async fn assert_writable<C: ConnectionTrait>(
    db: &C,
    legacy: LegacyLinks<'_>,
    kind: SyncKind,
    id: i64,
) -> Result<(), AppError> {
    match legacy_copy_link(db, Some(legacy), kind, id).await? {
        Some(link) if link.role.is_read_only() => {
            Err(read_only_error(Some(legacy), kind, &link).await)
        }
        _ => Ok(()),
    }
}

/// [`assert_writable`] for a split row the caller already loaded.
///
/// `legacy` is optional because many internal callers hold no control handle;
/// the verdict is the same, only the `origin` decoration is thinner.
///
/// # Errors
///
/// [`AppError::ReadOnlyCopy`] when the split is an active copy.
pub async fn assert_split_writable(
    legacy: Option<LegacyLinks<'_>>,
    split_id: i64,
    origin_read_only: bool,
) -> Result<(), AppError> {
    match split_copy_link(legacy, split_id, origin_read_only).await? {
        Some(link) if link.role.is_read_only() => {
            Err(read_only_error(legacy, SyncKind::Split, &link).await)
        }
        _ => Ok(()),
    }
}

/// Role and origin of every copy among `ids`, in one pass per backing table.
///
/// Origins and non-synced ids are simply absent from the map.
///
/// # Errors
///
/// Returns [`AppError::Database`] when a lookup fails.
#[allow(
    dead_code,
    reason = "consumed by the SA-8 `sync` block on entity views"
)]
pub async fn copy_info<C: ConnectionTrait>(
    db: &C,
    legacy: LegacyLinks<'_>,
    kind: SyncKind,
    ids: &[i64],
) -> Result<HashMap<i64, CopyInfo>, AppError> {
    let mut links: Vec<(i64, CopyLink)> = Vec::new();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    match kind {
        SyncKind::Event => {
            let placeholders = (2..ids.len() + 2)
                .map(|index| format!("${index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT mirror_event_id, source_tenant_id, source_event_id, sync_enabled \
                 FROM event_sync_links \
                 WHERE mirror_tenant_id = $1 AND mirror_event_id IN ({placeholders})"
            );
            let mut values = vec![Value::from(legacy.tenant_id.to_owned())];
            values.extend(ids.iter().copied().map(Value::from));
            let rows = legacy
                .control
                .query_all(Statement::from_sql_and_values(
                    legacy.control.get_database_backend(),
                    &sql,
                    values,
                ))
                .await?;
            for row in rows {
                let enabled: bool = row.try_get_by_index(3)?;
                links.push((
                    row.try_get_by_index(0)?,
                    CopyLink {
                        role: if enabled {
                            CopyRole::ActiveCopy
                        } else {
                            CopyRole::DetachedCopy
                        },
                        origin_tenant_id: row.try_get_by_index(1)?,
                        origin_entity_id: Some(row.try_get_by_index(2)?),
                    },
                ));
            }
        }
        SyncKind::Split => {
            let copies = split::Entity::find()
                .filter(split::Column::Id.is_in(ids.iter().copied()))
                .filter(split::Column::OriginReadOnly.eq(true))
                .all(db)
                .await?;
            for copy in copies {
                if let Some(link) = split_copy_link(Some(legacy), copy.id, true).await? {
                    links.push((copy.id, link));
                }
            }
        }
    }
    let mut tenants: Vec<String> = links
        .iter()
        .map(|(_, link)| link.origin_tenant_id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    tenants.sort();
    tenants.dedup();
    let labels = tenant_labels(legacy.control, &tenants).await;
    Ok(links
        .into_iter()
        .map(|(id, link)| {
            let origin = origin_ref(kind, &link, &labels);
            (
                id,
                CopyInfo {
                    role: link.role,
                    origin,
                },
            )
        })
        .collect())
}
