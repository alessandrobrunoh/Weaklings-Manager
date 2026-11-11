//! The single accessor that says what role an entity plays in synchronization.
//!
//! Until `sync_copies` is populated (SY-3a) the answer is backed by the legacy
//! markers behind the same signature:
//!
//! * events: `event_sync_links` in the control database (`sync_enabled = false`
//!   is a [`CopyRole::DetachedCopy`]);
//! * splits: `splits.origin_read_only` in the tenant database, with the origin
//!   resolved from `alliance_shares` when a control handle is available.
//!
//! [`CopyRole::DetachedCopy`] behaves as an origin for the scheduler, auto-stop
//! and the write guard: a link disabled by a membership departure leaves the
//! copy locally managed.

use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, Statement};

use backend_core::errors::AppError;
use backend_core::sync_origin::SyncKind;
use backend_entities::splits::split;

/// What an entity is in the synchronization topology.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyRole {
    /// Owns the data and fans it out to at least one copy.
    Origin,
    /// A read-only copy kept in sync by the origin.
    ActiveCopy,
    /// A copy whose link was disabled; it is local now and behaves as an origin.
    DetachedCopy,
    /// Not part of any synchronization.
    NotSynced,
}

impl CopyRole {
    /// True when the row is, or once was, a copy of another tenant's entity.
    ///
    /// Progression rewards stay with the origin tenant, so XP policy keys off this
    /// (a detached copy still awards nothing) and not off [`Self::is_read_only`].
    #[must_use]
    pub const fn is_copy(self) -> bool {
        matches!(self, Self::ActiveCopy | Self::DetachedCopy)
    }

    /// True when mutations must be rejected because the origin owns the data.
    #[must_use]
    pub const fn is_read_only(self) -> bool {
        matches!(self, Self::ActiveCopy)
    }
}

/// Handles that the legacy backing needs and the future `sync_copies` backing
/// does not: the control database and the id of the tenant `db` belongs to.
///
/// Removed from every signature when SY-3a switches the backing.
#[derive(Debug, Clone, Copy)]
pub struct LegacyLinks<'a> {
    /// Control-plane database (`event_sync_links`, `alliance_shares`, `tenants`).
    pub control: &'a DatabaseConnection,
    /// Tenant the entity lives in.
    pub tenant_id: &'a str,
}

/// Where a copy's origin lives, as far as the legacy data knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CopyLink {
    pub(super) role: CopyRole,
    /// Owning tenant; empty when the legacy data does not record it.
    pub(super) origin_tenant_id: String,
    /// The entity id inside the owning tenant, when recorded.
    pub(super) origin_entity_id: Option<i64>,
}

/// Looks up the legacy copy marker of one entity.
///
/// Returns `None` for anything that is not a copy (origin or not synced).
pub(super) async fn legacy_copy_link<C: ConnectionTrait>(
    db: &C,
    legacy: Option<LegacyLinks<'_>>,
    kind: SyncKind,
    id: i64,
) -> Result<Option<CopyLink>, AppError> {
    match kind {
        SyncKind::Event => {
            let Some(legacy) = legacy else {
                return Ok(None);
            };
            let row = legacy
                .control
                .query_one(Statement::from_sql_and_values(
                    legacy.control.get_database_backend(),
                    "SELECT source_tenant_id, source_event_id, sync_enabled \
                     FROM event_sync_links \
                     WHERE mirror_tenant_id = $1 AND mirror_event_id = $2",
                    [legacy.tenant_id.into(), id.into()],
                ))
                .await?;
            let Some(row) = row else {
                return Ok(None);
            };
            let enabled: bool = row.try_get_by_index(2)?;
            Ok(Some(CopyLink {
                role: if enabled {
                    CopyRole::ActiveCopy
                } else {
                    CopyRole::DetachedCopy
                },
                origin_tenant_id: row.try_get_by_index(0)?,
                origin_entity_id: Some(row.try_get_by_index(1)?),
            }))
        }
        SyncKind::Split => {
            let Some(model) = split::Entity::find_by_id(id).one(db).await? else {
                return Ok(None);
            };
            split_copy_link(legacy, id, model.origin_read_only).await
        }
    }
}

/// The split flavour of [`legacy_copy_link`] for callers that already hold the row.
pub(super) async fn split_copy_link(
    legacy: Option<LegacyLinks<'_>>,
    split_id: i64,
    origin_read_only: bool,
) -> Result<Option<CopyLink>, AppError> {
    if !origin_read_only {
        return Ok(None);
    }
    let mut link = CopyLink {
        role: CopyRole::ActiveCopy,
        origin_tenant_id: String::new(),
        origin_entity_id: None,
    };
    if let Some(legacy) = legacy {
        // Best effort: the origin only decorates the error, so a missing
        // `alliance_shares` row must not turn a clean 403 into a 500.
        let lookup = legacy
            .control
            .query_one(Statement::from_sql_and_values(
                legacy.control.get_database_backend(),
                "SELECT source_tenant_id, source_id FROM alliance_shares \
                 WHERE alliance_tenant_id = $1 AND artifact_type = 'split' \
                   AND published_id = $2",
                [legacy.tenant_id.into(), split_id.into()],
            ))
            .await;
        match lookup {
            Ok(Some(row)) => {
                if let (Ok(tenant), Ok(entity)) = (
                    row.try_get_by_index::<String>(0),
                    row.try_get_by_index::<i64>(1),
                ) {
                    link.origin_tenant_id = tenant;
                    link.origin_entity_id = Some(entity);
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::debug!(split_id, error = %error, "could not resolve split origin");
            }
        }
    }
    Ok(Some(link))
}

/// True when other tenants hold copies of this entity.
async fn is_origin(legacy: LegacyLinks<'_>, kind: SyncKind, id: i64) -> Result<bool, AppError> {
    let sql = match kind {
        SyncKind::Event => {
            "SELECT 1 FROM event_sync_links \
             WHERE source_tenant_id = $1 AND source_event_id = $2 LIMIT 1"
        }
        SyncKind::Split => {
            "SELECT 1 FROM alliance_shares \
             WHERE source_tenant_id = $1 AND artifact_type = 'split' AND source_id = $2 \
             LIMIT 1"
        }
    };
    let row = legacy
        .control
        .query_one(Statement::from_sql_and_values(
            legacy.control.get_database_backend(),
            sql,
            [legacy.tenant_id.into(), id.into()],
        ))
        .await?;
    Ok(row.is_some())
}

/// What role does `kind:id` (living in the tenant `db` belongs to) play?
///
/// This is the only question the rest of the backend asks about copies. See
/// the module docs for the legacy backing.
///
/// # Errors
///
/// Returns [`AppError::Database`] when a lookup fails.
pub async fn copy_role<C: ConnectionTrait>(
    db: &C,
    legacy: LegacyLinks<'_>,
    kind: SyncKind,
    id: i64,
) -> Result<CopyRole, AppError> {
    if let Some(link) = legacy_copy_link(db, Some(legacy), kind, id).await? {
        return Ok(link.role);
    }
    if is_origin(legacy, kind, id).await? {
        return Ok(CopyRole::Origin);
    }
    Ok(CopyRole::NotSynced)
}
