//! The tenant `action_log` table (shared-actions §3.5).
//!
//! One row per applied or no-op action. It is the idempotency record (a retried request with the
//! same key replays instead of applying twice), the activity timeline of an entity and the source of
//! the action metrics. Rows older than [`RETENTION_DAYS`] are pruned by the event-sessions worker.

use chrono::{TimeDelta, Utc};
use sea_orm::{ActiveValue::Set, entity::prelude::*};

use crate::errors::AppError;

/// Days an `action_log` row is kept.
pub const RETENTION_DAYS: i64 = 90;

/// Maximum bytes of the request parameters stored per row.
pub const MAX_PARAMS_BYTES: usize = 2048;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "action_log")]
pub struct Model {
    /// Row id.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// `event`, ...
    pub entity_type: String,
    /// Entity id; absent for collection actions.
    pub entity_id: Option<i64>,
    /// Action id.
    pub action: String,
    /// Local user id of the actor.
    pub actor_user_id: i64,
    /// `web`, `discord`, `system` or `api`.
    pub channel: String,
    /// Client-supplied idempotency key.
    pub idempotency_key: Option<String>,
    /// Status before the action.
    pub from_state: Option<String>,
    /// Status after the action.
    pub to_state: Option<String>,
    /// `applied` or `noop`.
    pub outcome: String,
    /// Request parameters, truncated to [`MAX_PARAMS_BYTES`].
    pub params: Option<String>,
    /// JSON array of the outbox rows the action queued.
    pub effect_ids: Option<String>,
    /// When the action ran.
    pub created_at: DateTimeWithTimeZone,
}

/// Relations of `action_log`; it references no other table.
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// Values of one new row.
pub struct NewRow<'a> {
    /// `event`, ...
    pub entity_type: &'a str,
    /// Entity id.
    pub entity_id: i64,
    /// Action id.
    pub action: &'a str,
    /// Local user id of the actor.
    pub actor_user_id: i64,
    /// Channel the request came through.
    pub channel: &'a str,
    /// Idempotency key, when the request had one.
    pub idempotency_key: Option<&'a str>,
    /// Status before.
    pub from_state: &'a str,
    /// Status after.
    pub to_state: &'a str,
    /// `applied` or `noop`.
    pub outcome: &'a str,
    /// Truncated parameters, JSON text.
    pub params: Option<String>,
}

/// Inserts one row in the caller's transaction.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the insert fails (a unique index hit included).
pub async fn insert<C: ConnectionTrait>(db: &C, row: NewRow<'_>) -> Result<Model, AppError> {
    ActiveModel {
        entity_type: Set(row.entity_type.to_owned()),
        entity_id: Set(Some(row.entity_id)),
        action: Set(row.action.to_owned()),
        actor_user_id: Set(row.actor_user_id),
        channel: Set(row.channel.to_owned()),
        idempotency_key: Set(row.idempotency_key.map(str::to_owned)),
        from_state: Set(Some(row.from_state.to_owned())),
        to_state: Set(Some(row.to_state.to_owned())),
        outcome: Set(row.outcome.to_owned()),
        params: Set(row.params),
        effect_ids: Set(Some("[]".to_owned())),
        created_at: Set(Utc::now().fixed_offset()),
        ..Default::default()
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

/// The row an earlier request with the same key left for this actor and action, if any.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the lookup fails.
pub async fn find_replay<C: ConnectionTrait>(
    db: &C,
    actor_user_id: i64,
    action: &str,
    key: &str,
) -> Result<Option<Model>, AppError> {
    Entity::find()
        .filter(Column::ActorUserId.eq(actor_user_id))
        .filter(Column::Action.eq(action))
        .filter(Column::IdempotencyKey.eq(key))
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// Deletes rows older than [`RETENTION_DAYS`]; returns how many went.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the delete fails.
pub async fn prune<C: ConnectionTrait>(db: &C) -> Result<u64, AppError> {
    let cutoff = (Utc::now() - TimeDelta::days(RETENTION_DAYS)).fixed_offset();
    let result = Entity::delete_many()
        .filter(Column::CreatedAt.lt(cutoff))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected)
}
