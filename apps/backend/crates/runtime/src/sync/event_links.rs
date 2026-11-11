//! Control-plane lookups that link an event across tenants: the canonical
//! origin of a mirrored event and the guild a participant is attributed to.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

use backend_core::errors::AppError;

/// The guild already attributed to this participant, if any.
pub async fn stored_attribution(
    control: &DatabaseConnection,
    source_tenant_id: &str,
    source_event_id: i64,
    discord_id: &str,
) -> Result<Option<String>, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT guild_tenant_id FROM event_participant_attributions \
             WHERE source_tenant_id = $1 AND source_event_id = $2 AND discord_id = $3",
            [
                source_tenant_id.into(),
                source_event_id.into(),
                discord_id.into(),
            ],
        ))
        .await?;
    row.map(|row| row.try_get_by_index(0))
        .transpose()
        .map_err(AppError::Database)
}

/// The canonical `(tenant, event)` of an event: the source of its active sync
/// link when it is a mirror, otherwise the event itself.
pub async fn canonical_event_origin(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<(String, i64), AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT source_tenant_id, source_event_id FROM event_sync_links \
             WHERE sync_enabled AND mirror_tenant_id=$1 AND mirror_event_id=$2",
            [tenant_id.into(), event_id.into()],
        ))
        .await?;
    match row {
        Some(row) => Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)),
        None => Ok((tenant_id.to_owned(), event_id)),
    }
}
