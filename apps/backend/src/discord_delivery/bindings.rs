//! Discord bindings: where an entity lives on Discord (DO §3.1).
//!
//! The only place delivery stores Discord ids. A binding is `creating` before a non-idempotent
//! create (with the nonce that identifies the attempt), `active` once the ids are known,
//! `closed` when the entity leaves the channel, and `deleted` when the Discord object is gone
//! (history is kept, so a later unarchive recreates it silently).

use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DbBackend, QueryResult, Statement, Value};
use serde_json::Value as Json;

use super::kinds::EntityType;
use crate::errors::AppError;

/// Lifecycle state of a binding (`discord_bindings.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingState {
    /// A Discord create is in flight or was interrupted; verify before creating again.
    Creating,
    /// The Discord objects exist and are recorded.
    Active,
    /// The entity left the channel; the objects were closed, not deleted.
    Closed,
    /// The Discord objects were deleted; the row is history.
    Deleted,
}

impl BindingState {
    /// Stored label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Active => "active",
            Self::Closed => "closed",
            Self::Deleted => "deleted",
        }
    }

    /// Parses the stored label.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        [Self::Creating, Self::Active, Self::Closed, Self::Deleted]
            .into_iter()
            .find(|state| state.as_str() == value)
    }
}

/// Operation applied to a binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingOp {
    /// Start a create attempt identified by `nonce`.
    Begin {
        /// Attempt nonce, written to the row before the Discord call.
        nonce: String,
    },
    /// Record the ids of an existing Discord object.
    Activate,
    /// Close the binding.
    Close,
    /// Mark the Discord object as deleted.
    Delete,
}

/// Rejected transition, carrying what was attempted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    /// State before the operation (`None` when the binding does not exist).
    pub from: Option<BindingState>,
    /// Operation name.
    pub op: &'static str,
}

/// Pure transition table of the binding state machine.
///
/// # Errors
///
/// Returns [`InvalidTransition`] for every pair not listed in the table.
pub fn next_state(
    current: Option<BindingState>,
    op: &BindingOp,
) -> Result<BindingState, InvalidTransition> {
    use BindingState::{Active, Closed, Creating, Deleted};
    let op_name = match op {
        BindingOp::Begin { .. } => "begin",
        BindingOp::Activate => "activate",
        BindingOp::Close => "close",
        BindingOp::Delete => "delete",
    };
    let next = match (current, op) {
        (None | Some(Deleted) | Some(Closed), BindingOp::Begin { .. }) => Some(Creating),
        (
            None | Some(Creating) | Some(Active) | Some(Closed) | Some(Deleted),
            BindingOp::Activate,
        ) => Some(Active),
        (Some(Creating | Active | Closed), BindingOp::Delete) => Some(Deleted),
        (Some(Creating | Active), BindingOp::Close) => Some(Closed),
        _ => None,
    };
    next.ok_or(InvalidTransition {
        from: current,
        op: op_name,
    })
}

/// Identity of a binding: entity plus slot (`''` for single-slot entities).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingKey {
    /// Entity type.
    pub entity_type: EntityType,
    /// Entity id (0 for singletons).
    pub entity_id: i64,
    /// Slot, for example `announcement`, `voice`, `p0`.
    pub slot: String,
}

impl BindingKey {
    /// Key of a single-slot binding.
    #[must_use]
    pub fn new(entity_type: EntityType, entity_id: i64) -> Self {
        Self {
            entity_type,
            entity_id,
            slot: String::new(),
        }
    }

    /// Key with an explicit slot.
    #[must_use]
    pub fn with_slot(entity_type: EntityType, entity_id: i64, slot: impl Into<String>) -> Self {
        Self {
            entity_type,
            entity_id,
            slot: slot.into(),
        }
    }
}

/// One stored binding.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    /// Row id.
    pub id: i64,
    /// Identity.
    pub key: BindingKey,
    /// State.
    pub state: BindingState,
    /// Parent channel, forum or voice channel.
    pub channel_id: Option<String>,
    /// Primary message.
    pub message_id: Option<String>,
    /// Thread.
    pub thread_id: Option<String>,
    /// Signup card inside the thread.
    pub card_message_id: Option<String>,
    /// Kind-specific JSON.
    pub extra: Json,
    /// Fingerprint of the render last applied.
    pub applied_fingerprint: Option<String>,
    /// When the fingerprint was applied.
    pub applied_at: Option<DateTime<Utc>>,
    /// Nonce of the create in flight.
    pub nonce: Option<String>,
    /// When the create in flight started.
    pub creating_since: Option<DateTime<Utc>>,
    /// Last error text.
    pub last_error: Option<String>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last update time.
    pub updated_at: DateTime<Utc>,
}

/// Fields an operation may set. `None` keeps the stored value.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BindingFields {
    /// Parent channel.
    pub channel_id: Option<String>,
    /// Primary message.
    pub message_id: Option<String>,
    /// Thread.
    pub thread_id: Option<String>,
    /// Signup card.
    pub card_message_id: Option<String>,
    /// Kind-specific JSON.
    pub extra: Option<Json>,
    /// Fingerprint of the render just applied; setting it stamps `applied_at`.
    pub applied_fingerprint: Option<String>,
    /// Error text to record.
    pub last_error: Option<String>,
}

const COLUMNS: &str = "id, entity_type, entity_id, slot, state, channel_id, message_id, \
     thread_id, card_message_id, extra, applied_fingerprint, applied_at, nonce, \
     creating_since, last_error, created_at, updated_at";

fn stmt(
    backend: DbBackend,
    sql: impl AsRef<str>,
    values: impl IntoIterator<Item = Value>,
) -> Statement {
    Statement::from_sql_and_values(backend, sql.as_ref(), values)
}

fn binding_from(row: &QueryResult) -> Result<Binding, sea_orm::DbErr> {
    let custom = sea_orm::DbErr::Custom;
    let entity_type: String = row.try_get("", "entity_type")?;
    let state: String = row.try_get("", "state")?;
    let extra: String = row.try_get("", "extra")?;
    Ok(Binding {
        id: row.try_get("", "id")?,
        key: BindingKey {
            entity_type: EntityType::parse(&entity_type)
                .ok_or_else(|| custom(format!("unknown binding entity {entity_type}")))?,
            entity_id: row.try_get("", "entity_id")?,
            slot: row.try_get("", "slot")?,
        },
        state: BindingState::parse(&state)
            .ok_or_else(|| custom(format!("unknown binding state {state}")))?,
        channel_id: row.try_get("", "channel_id")?,
        message_id: row.try_get("", "message_id")?,
        thread_id: row.try_get("", "thread_id")?,
        card_message_id: row.try_get("", "card_message_id")?,
        extra: serde_json::from_str(&extra).map_err(|err| custom(err.to_string()))?,
        applied_fingerprint: row.try_get("", "applied_fingerprint")?,
        applied_at: row.try_get("", "applied_at")?,
        nonce: row.try_get("", "nonce")?,
        creating_since: row.try_get("", "creating_since")?,
        last_error: row.try_get("", "last_error")?,
        created_at: row.try_get("", "created_at")?,
        updated_at: row.try_get("", "updated_at")?,
    })
}

/// Loads one binding.
///
/// # Errors
///
/// Returns a database error when the query or the decoding fails.
pub async fn get<C: ConnectionTrait>(
    conn: &C,
    key: &BindingKey,
) -> Result<Option<Binding>, AppError> {
    let backend = conn.get_database_backend();
    let row = conn
        .query_one(stmt(
            backend,
            format!(
                "SELECT {COLUMNS} FROM discord_bindings \
                 WHERE entity_type = $1 AND entity_id = $2 AND slot = $3"
            ),
            [
                key.entity_type.as_str().into(),
                key.entity_id.into(),
                key.slot.clone().into(),
            ],
        ))
        .await?;
    row.map(|row| binding_from(&row))
        .transpose()
        .map_err(AppError::from)
}

/// Lists every binding of one entity, ordered by slot.
///
/// # Errors
///
/// Returns a database error when the query or the decoding fails.
pub async fn list_for_entity<C: ConnectionTrait>(
    conn: &C,
    entity_type: EntityType,
    entity_id: i64,
) -> Result<Vec<Binding>, AppError> {
    let backend = conn.get_database_backend();
    let rows = conn
        .query_all(stmt(
            backend,
            format!(
                "SELECT {COLUMNS} FROM discord_bindings \
                 WHERE entity_type = $1 AND entity_id = $2 ORDER BY slot"
            ),
            [entity_type.as_str().into(), entity_id.into()],
        ))
        .await?;
    rows.iter()
        .map(binding_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)
}

/// Applies one operation to a binding in the caller's transaction.
///
/// The row is created when it does not exist yet. An update is conditional on the state that
/// was read, so a concurrent change yields `Conflict` rather than a lost write.
///
/// # Errors
///
/// Returns `Conflict` for a transition the state machine forbids or a concurrent change.
pub async fn apply<C: ConnectionTrait>(
    conn: &C,
    now: DateTime<Utc>,
    key: &BindingKey,
    op: BindingOp,
    fields: BindingFields,
) -> Result<Binding, AppError> {
    let backend = conn.get_database_backend();
    let current = get(conn, key).await?;
    let next = next_state(current.as_ref().map(|binding| binding.state), &op).map_err(|err| {
        AppError::Conflict(format!(
            "binding {} {}:{} cannot {} from {:?}",
            key.entity_type.as_str(),
            key.entity_id,
            key.slot,
            err.op,
            err.from
        ))
    })?;
    let (nonce, creating_since) = match &op {
        BindingOp::Begin { nonce } => (Some(nonce.clone()), Some(now)),
        _ => (None, None),
    };
    let applied_at = match (&fields.applied_fingerprint, &current) {
        (Some(_), _) => Some(now),
        (None, Some(binding)) => binding.applied_at,
        (None, None) => None,
    };
    let extra = fields.extra.as_ref().map(Json::to_string);

    match current {
        None => {
            conn.execute(stmt(
                backend,
                "INSERT INTO discord_bindings (entity_type, entity_id, slot, state, channel_id, \
                 message_id, thread_id, card_message_id, extra, applied_fingerprint, applied_at, \
                 nonce, creating_since, last_error, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, '{}'), $10, $11, $12, $13, \
                 $14, $15, $15)",
                [
                    key.entity_type.as_str().into(),
                    key.entity_id.into(),
                    key.slot.clone().into(),
                    next.as_str().into(),
                    fields.channel_id.into(),
                    fields.message_id.into(),
                    fields.thread_id.into(),
                    fields.card_message_id.into(),
                    extra.into(),
                    fields.applied_fingerprint.into(),
                    applied_at.into(),
                    nonce.into(),
                    creating_since.into(),
                    fields.last_error.into(),
                    now.into(),
                ],
            ))
            .await?;
        }
        Some(binding) => {
            let affected = conn
                .execute(stmt(
                    backend,
                    "UPDATE discord_bindings SET state = $1, channel_id = COALESCE($2, channel_id), \
                     message_id = COALESCE($3, message_id), thread_id = COALESCE($4, thread_id), \
                     card_message_id = COALESCE($5, card_message_id), \
                     extra = COALESCE($6, extra), applied_fingerprint = COALESCE($7, applied_fingerprint), \
                     applied_at = $8, nonce = $9, creating_since = $10, \
                     last_error = COALESCE($11, last_error), updated_at = $12 \
                     WHERE id = $13 AND state = $14",
                    [
                        next.as_str().into(),
                        fields.channel_id.into(),
                        fields.message_id.into(),
                        fields.thread_id.into(),
                        fields.card_message_id.into(),
                        extra.into(),
                        fields.applied_fingerprint.into(),
                        applied_at.into(),
                        nonce.into(),
                        creating_since.into(),
                        fields.last_error.into(),
                        now.into(),
                        binding.id.into(),
                        binding.state.as_str().into(),
                    ],
                ))
                .await?
                .rows_affected();
            if affected == 0 {
                return Err(AppError::Conflict(format!(
                    "binding {} {}:{} changed concurrently",
                    key.entity_type.as_str(),
                    key.entity_id,
                    key.slot
                )));
            }
        }
    }

    get(conn, key)
        .await?
        .ok_or_else(|| AppError::Internal("binding vanished after apply".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sqlite() -> sea_orm::DatabaseConnection {
        crate::testkit::tenant_schema::migrated_sqlite().await
    }

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).expect("timestamp")
    }

    #[test]
    fn transition_table_allows_exactly_the_documented_moves() {
        use BindingState::{Active, Closed, Creating, Deleted};
        let begin = BindingOp::Begin {
            nonce: "n".to_owned(),
        };
        let allowed = [
            (None, begin.clone(), Creating),
            (Some(Deleted), begin.clone(), Creating),
            (Some(Closed), begin.clone(), Creating),
            (None, BindingOp::Activate, Active),
            (Some(Creating), BindingOp::Activate, Active),
            (Some(Active), BindingOp::Activate, Active),
            (Some(Closed), BindingOp::Activate, Active),
            (Some(Deleted), BindingOp::Activate, Active),
            (Some(Creating), BindingOp::Delete, Deleted),
            (Some(Active), BindingOp::Delete, Deleted),
            (Some(Closed), BindingOp::Delete, Deleted),
            (Some(Creating), BindingOp::Close, Closed),
            (Some(Active), BindingOp::Close, Closed),
        ];
        for (from, op, to) in &allowed {
            assert_eq!(next_state(*from, op), Ok(*to), "{from:?} {op:?}");
        }
        let forbidden = [
            (Some(Creating), begin.clone()),
            (Some(Active), begin.clone()),
            (None, BindingOp::Close),
            (None, BindingOp::Delete),
            (Some(Deleted), BindingOp::Close),
            (Some(Closed), BindingOp::Close),
            (Some(Deleted), BindingOp::Delete),
        ];
        for (from, op) in &forbidden {
            assert!(
                next_state(*from, op).is_err(),
                "{from:?} {op:?} must be refused"
            );
        }
    }

    #[test]
    fn states_round_trip_through_their_labels() {
        for state in [
            BindingState::Creating,
            BindingState::Active,
            BindingState::Closed,
            BindingState::Deleted,
        ] {
            assert_eq!(BindingState::parse(state.as_str()), Some(state));
        }
        assert_eq!(BindingState::parse("unknown"), None);
    }

    #[tokio::test]
    async fn create_then_activate_records_ids_and_keeps_unset_fields() {
        let db = sqlite().await;
        let key = BindingKey::with_slot(EntityType::Event, 42, "announcement");
        let creating = apply(
            &db,
            at(0),
            &key,
            BindingOp::Begin {
                nonce: "attempt-1".to_owned(),
            },
            BindingFields::default(),
        )
        .await
        .expect("begin");
        assert_eq!(creating.state, BindingState::Creating);
        assert_eq!(creating.nonce.as_deref(), Some("attempt-1"));
        assert_eq!(creating.creating_since, Some(at(0)));

        let active = apply(
            &db,
            at(1),
            &key,
            BindingOp::Activate,
            BindingFields {
                channel_id: Some("111".to_owned()),
                message_id: Some("222".to_owned()),
                thread_id: Some("333".to_owned()),
                applied_fingerprint: Some("7:scheduled:ab".to_owned()),
                ..BindingFields::default()
            },
        )
        .await
        .expect("activate");
        assert_eq!(active.state, BindingState::Active);
        assert_eq!(
            active.nonce, None,
            "the attempt nonce is cleared on activation"
        );
        assert_eq!(active.creating_since, None);
        assert_eq!(active.message_id.as_deref(), Some("222"));
        assert_eq!(active.applied_at, Some(at(1)));

        let touched = apply(
            &db,
            at(2),
            &key,
            BindingOp::Activate,
            BindingFields {
                card_message_id: Some("444".to_owned()),
                ..BindingFields::default()
            },
        )
        .await
        .expect("second activate");
        assert_eq!(
            touched.channel_id.as_deref(),
            Some("111"),
            "unset fields are kept"
        );
        assert_eq!(touched.card_message_id.as_deref(), Some("444"));
        assert_eq!(
            touched.applied_at,
            Some(at(1)),
            "no new fingerprint, no restamp"
        );
    }

    #[tokio::test]
    async fn an_invalid_transition_is_a_conflict_and_changes_nothing() {
        let db = sqlite().await;
        let key = BindingKey::new(EntityType::Split, 5);
        apply(
            &db,
            at(0),
            &key,
            BindingOp::Activate,
            BindingFields::default(),
        )
        .await
        .expect("activate");
        let err = apply(
            &db,
            at(1),
            &key,
            BindingOp::Begin {
                nonce: "again".to_owned(),
            },
            BindingFields::default(),
        )
        .await
        .expect_err("begin on an active binding");
        assert!(matches!(err, AppError::Conflict(_)));
        let still = get(&db, &key).await.expect("get").expect("row");
        assert_eq!(still.state, BindingState::Active);
        assert_eq!(still.nonce, None);
    }

    #[tokio::test]
    async fn deleted_binding_is_kept_as_history_and_can_be_recreated() {
        let db = sqlite().await;
        let key = BindingKey::new(EntityType::Event, 9);
        apply(
            &db,
            at(0),
            &key,
            BindingOp::Activate,
            BindingFields {
                thread_id: Some("t-1".to_owned()),
                ..BindingFields::default()
            },
        )
        .await
        .expect("activate");
        apply(
            &db,
            at(1),
            &key,
            BindingOp::Delete,
            BindingFields::default(),
        )
        .await
        .expect("delete");
        let recreated = apply(
            &db,
            at(2),
            &key,
            BindingOp::Begin {
                nonce: "back".to_owned(),
            },
            BindingFields::default(),
        )
        .await
        .expect("recreate");
        assert_eq!(
            recreated.id,
            get(&db, &key).await.expect("get").expect("row").id
        );
        assert_eq!(recreated.state, BindingState::Creating);
        assert_eq!(recreated.thread_id.as_deref(), Some("t-1"));
    }

    #[tokio::test]
    async fn a_thread_id_belongs_to_one_binding_only() {
        let db = sqlite().await;
        let fields = BindingFields {
            thread_id: Some("shared-thread".to_owned()),
            ..BindingFields::default()
        };
        apply(
            &db,
            at(0),
            &BindingKey::new(EntityType::Event, 1),
            BindingOp::Activate,
            fields.clone(),
        )
        .await
        .expect("first");
        let clash = apply(
            &db,
            at(0),
            &BindingKey::new(EntityType::Event, 2),
            BindingOp::Activate,
            fields,
        )
        .await;
        assert!(clash.is_err(), "thread ids are unique across bindings");
    }

    #[tokio::test]
    async fn list_returns_every_slot_of_an_entity_in_slot_order() {
        let db = sqlite().await;
        for slot in ["voice", "announcement"] {
            apply(
                &db,
                at(0),
                &BindingKey::with_slot(EntityType::Event, 3, slot),
                BindingOp::Activate,
                BindingFields::default(),
            )
            .await
            .expect("activate");
        }
        apply(
            &db,
            at(0),
            &BindingKey::new(EntityType::Event, 4),
            BindingOp::Activate,
            BindingFields::default(),
        )
        .await
        .expect("other entity");
        let slots: Vec<String> = list_for_entity(&db, EntityType::Event, 3)
            .await
            .expect("list")
            .into_iter()
            .map(|binding| binding.key.slot)
            .collect();
        assert_eq!(slots, vec!["announcement".to_owned(), "voice".to_owned()]);
    }
}
