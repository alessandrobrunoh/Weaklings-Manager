//! Idempotent projection of an alliance-owned split into member-guild ledgers.

use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait,
    QueryFilter, Statement, TransactionTrait,
};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    errors::AppError,
    modules::{
        audit::entities::Model as AuditRow,
        bank::status::TransactionStatus,
        events::{
            attribution::stored_attribution, entities::event::Entity as EventEntity,
            sync::canonical_event_origin,
        },
        splits::{
            entities::{
                split::{Column as SplitColumn, Entity as SplitEntity},
                split_participant::{Column as ParticipantColumn, Entity as ParticipantEntity},
            },
            service::{
                SplitService, calculate_net_value, echo_audit_row, event_has_ended,
                participant_shares, split_audit_in,
            },
        },
        sync::{LegacyLinks, assert_split_writable},
        users::entities::{Column as UserColumn, Entity as UserEntity},
    },
    tenant::TenantRegistry,
};

use super::status::SplitStatus;

#[derive(Debug, Clone, PartialEq)]
struct Projection {
    source_user_id: i64,
    discord_id: String,
    guild_tenant_id: String,
    destination_user_id: i64,
    amount: sea_orm::prelude::Decimal,
}

/// Durable progress for one alliance split projection batch.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DistributionStatus {
    /// Stable id used to correlate retries and ledger rows.
    pub batch_id: String,
    /// `processing`, `failed`, or `complete`.
    pub state: String,
    /// Latest batch-level error, when a retry is needed.
    pub last_error: Option<String>,
    /// One result per participant projection.
    pub recipients: Vec<DistributionRecipientStatus>,
}

/// Progress and audit identifiers for one projected participant credit.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DistributionRecipientStatus {
    pub guild_tenant_id: String,
    pub source_user_id: i64,
    #[schema(value_type = String, example = "50.00")]
    pub amount: sea_orm::prelude::Decimal,
    /// `pending` until the guild-local ledger row is confirmed.
    pub state: String,
    pub transaction_id: Option<i64>,
    pub last_error: Option<String>,
}

/// Returns durable batch state to the split owner/admin.
pub async fn status(
    control: &DatabaseConnection,
    alliance_tenant_id: &str,
    split_id: i64,
) -> Result<Option<DistributionStatus>, AppError> {
    let Some(batch) = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id,state,last_error FROM alliance_split_distribution_batches \
             WHERE alliance_tenant_id=$1 AND split_id=$2",
            [alliance_tenant_id.into(), split_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let batch_id: Uuid = batch.try_get_by_index(0)?;
    let recipients = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT guild_tenant_id,source_user_id,amount,state,transaction_id,last_error \
             FROM alliance_split_distribution_items WHERE batch_id=$1 ORDER BY guild_tenant_id,source_user_id",
            [batch_id.into()],
        ))
        .await?
        .into_iter()
        .map(|row| {
            Ok(DistributionRecipientStatus {
                guild_tenant_id: row.try_get_by_index(0)?,
                source_user_id: row.try_get_by_index(1)?,
                amount: row.try_get_by_index(2)?,
                state: row.try_get_by_index(3)?,
                transaction_id: row.try_get_by_index(4)?,
                last_error: row.try_get_by_index(5)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()?;
    Ok(Some(DistributionStatus {
        batch_id: batch_id.to_string(),
        state: batch.try_get_by_index(1)?,
        last_error: batch.try_get_by_index(2)?,
        recipients,
    }))
}

/// Preflight and distribute an alliance-owned split. Invalid membership or
/// attribution is rejected before any destination ledger is touched.
pub async fn complete(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    alliance_db: &DatabaseConnection,
    split_id: i64,
    actor_user_id: i64,
) -> Result<super::models::SplitDetail, AppError> {
    let split = SplitEntity::find_by_id(split_id)
        .one(alliance_db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
    // A synchronized copy is never distributed from here; the origin pays out.
    assert_split_writable(
        Some(LegacyLinks {
            control,
            tenant_id: alliance_tenant_id,
        }),
        split_id,
        split.origin_read_only,
    )
    .await?;
    if distribution_complete(control, alliance_tenant_id, split_id).await? {
        return SplitService::for_tenant("alliance")
            .get_split(alliance_db, split_id)
            .await;
    }
    if !matches!(split.status.as_str(), "pending" | "awaiting_event")
        && !(split.status == "completed"
            && distribution_batch_exists(control, alliance_tenant_id, split_id).await?)
    {
        return Err(AppError::Conflict(format!(
            "split {split_id} is not pending and cannot be distributed"
        )));
    }
    let event_id = split.event_id.ok_or_else(|| {
        AppError::Conflict("alliance split distribution requires a linked event".to_owned())
    })?;
    let event = EventEntity::find_by_id(event_id)
        .one(alliance_db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
    if event.source_tenant_id.is_some() || event.source_event_id.is_some() {
        return Err(AppError::Forbidden(
            "only an alliance-owned event split can be distributed to member guilds".to_owned(),
        ));
    }
    if !event_has_ended(&event.status) {
        return Err(AppError::Conflict(format!(
            "split {split_id} is awaiting event {event_id} to finish"
        )));
    }

    let participants = ParticipantEntity::find()
        .filter(ParticipantColumn::SplitId.eq(split_id))
        .all(alliance_db)
        .await?;
    if participants.is_empty() {
        return Err(AppError::Validation(
            "cannot distribute a split with no participants".to_owned(),
        ));
    }
    let net_value = calculate_net_value(
        split.estimated_market_value,
        split.fee,
        split.repair_value,
        split.bags_value,
    );
    if net_value <= sea_orm::prelude::Decimal::ZERO {
        return Err(AppError::Validation(
            "split net value must be positive to distribute".to_owned(),
        ));
    }
    let participant_count = participants.len();
    let (canonical_tenant, canonical_event) =
        canonical_event_origin(control, alliance_tenant_id, event_id).await?;
    if canonical_tenant != alliance_tenant_id {
        return Err(AppError::Forbidden(
            "the event is not owned by this alliance".to_owned(),
        ));
    }

    // Resolve every participant before creating the batch or touching any
    // guild ledger. A missing identity, attribution, membership, or target
    // account blocks the entire distribution.
    let weights = participants
        .iter()
        .map(|participant| (participant.user_id, participant.weight))
        .collect::<Vec<_>>();
    let shares = participant_shares(net_value, &weights)
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    let mut projections = Vec::with_capacity(participants.len());
    for participant in participants {
        let user = UserEntity::find_by_id(participant.user_id)
            .one(alliance_db)
            .await?
            .ok_or_else(|| {
                AppError::Conflict(format!(
                    "split participant {} no longer exists; remove them manually before retrying",
                    participant.user_id
                ))
            })?;
        let discord_id = user
            .discord_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                AppError::Conflict(format!(
                    "split participant {} has no linked Discord identity; remove them manually before retrying",
                    participant.user_id
                ))
            })?;
        let guild_id = stored_attribution(
            control,
            &canonical_tenant,
            canonical_event,
            &discord_id,
        )
        .await?
        .ok_or_else(|| {
            AppError::Conflict(format!(
                "participant {} has no guild attribution for this event; remove them manually before retrying",
                user.username
            ))
        })?;
        let active = control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT 1 FROM alliance_memberships m \
                 JOIN tenants t ON t.id=m.guild_tenant_id \
                 WHERE m.alliance_tenant_id=$1 AND m.guild_tenant_id=$2 \
                   AND m.status='active' AND t.status='active' AND t.kind='guild'",
                [alliance_tenant_id.into(), guild_id.clone().into()],
            ))
            .await?
            .is_some();
        if !active {
            return Err(AppError::Conflict(format!(
                "guild {guild_id} is no longer an active alliance member; remove its participants from the split manually before retrying"
            )));
        }
        let guild = registry.get_or_load(&guild_id).await.map_err(|error| {
            AppError::Conflict(format!(
                "guild {guild_id} cannot receive its split transactions: {error}"
            ))
        })?;
        let destination = UserEntity::find()
            .filter(UserColumn::DiscordId.eq(discord_id.clone()))
            .one(&guild.db)
            .await?
            .ok_or_else(|| {
                AppError::Conflict(format!(
                    "participant {} is not registered in guild {guild_id}; remove them manually before retrying",
                    user.username
                ))
            })?;
        projections.push(Projection {
            source_user_id: user.id,
            discord_id,
            guild_tenant_id: guild_id,
            destination_user_id: destination.id,
            amount: *shares
                .get(&user.id)
                .unwrap_or(&sea_orm::prelude::Decimal::ZERO),
        });
        if projections
            .last()
            .is_some_and(|projection| projection.amount <= sea_orm::prelude::Decimal::ZERO)
        {
            return Err(AppError::Conflict(format!(
                "participant {} has a zero-value share; adjust the split weights before retrying",
                user.username
            )));
        }
    }
    projections.sort_by(|a, b| a.discord_id.cmp(&b.discord_id));

    let batch_id = load_or_create_batch(
        control,
        alliance_tenant_id,
        split_id,
        actor_user_id,
        &projections,
    )
    .await?;
    for projection in &projections {
        if item_complete(control, batch_id, &projection.discord_id).await? {
            continue;
        }
        let result = project_one(
            control,
            registry,
            alliance_tenant_id,
            split_id,
            batch_id,
            projection,
        )
        .await;
        if let Err(error) = result {
            mark_batch_failed(control, batch_id, &error.to_string()).await?;
            return Err(error);
        }
    }

    let audit = finalize_source_split(
        alliance_db,
        split_id,
        actor_user_id,
        net_value,
        participant_count,
    )
    .await?;
    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE alliance_split_distribution_batches SET state='complete', last_error=NULL, updated_at=NOW() WHERE id=$1",
            [batch_id.into()],
        ))
        .await?;
    if let Some(row) = &audit {
        echo_audit_row(alliance_db, row).await;
    }
    SplitService::for_tenant("alliance")
        .get_split(alliance_db, split_id)
        .await
}

async fn load_or_create_batch(
    control: &DatabaseConnection,
    alliance_tenant_id: &str,
    split_id: i64,
    actor_user_id: i64,
    projections: &[Projection],
) -> Result<Uuid, AppError> {
    let txn = control.begin().await?;
    let proposed = Uuid::new_v4();
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO alliance_split_distribution_batches \
             (id, alliance_tenant_id, split_id, actor_user_id) VALUES ($1,$2,$3,$4) \
             ON CONFLICT (alliance_tenant_id, split_id) DO NOTHING RETURNING id",
            [
                proposed.into(),
                alliance_tenant_id.into(),
                split_id.into(),
                actor_user_id.into(),
            ],
        ))
        .await?;
    let batch_id = if let Some(row) = row {
        let batch_id: Uuid = row.try_get_by_index(0)?;
        for projection in projections {
            txn.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO alliance_split_distribution_items \
                 (batch_id,guild_tenant_id,discord_id,source_user_id,destination_user_id,amount) \
                 VALUES ($1,$2,$3,$4,$5,$6)",
                [
                    batch_id.into(),
                    projection.guild_tenant_id.clone().into(),
                    projection.discord_id.clone().into(),
                    projection.source_user_id.into(),
                    projection.destination_user_id.into(),
                    projection.amount.into(),
                ],
            ))
            .await?;
        }
        batch_id
    } else {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id FROM alliance_split_distribution_batches WHERE alliance_tenant_id=$1 AND split_id=$2 FOR UPDATE",
                [alliance_tenant_id.into(), split_id.into()],
            ))
            .await?
            .ok_or_else(|| AppError::Internal("split distribution batch disappeared".into()))?;
        let batch_id: Uuid = row.try_get_by_index(0)?;
        let stored = txn
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT guild_tenant_id,discord_id,source_user_id,destination_user_id,amount \
                 FROM alliance_split_distribution_items WHERE batch_id=$1 ORDER BY discord_id",
                [batch_id.into()],
            ))
            .await?;
        if stored.len() != projections.len() {
            return Err(AppError::Conflict(
                "the split roster changed after distribution began; reconcile the existing batch before retrying"
                    .to_owned(),
            ));
        }
        for (row, projection) in stored.iter().zip(projections) {
            let guild: String = row.try_get_by_index(0)?;
            let discord: String = row.try_get_by_index(1)?;
            let user_id: i64 = row.try_get_by_index(2)?;
            let destination: i64 = row.try_get_by_index(3)?;
            let amount: sea_orm::prelude::Decimal = row.try_get_by_index(4)?;
            if guild != projection.guild_tenant_id
                || discord != projection.discord_id
                || user_id != projection.source_user_id
                || destination != projection.destination_user_id
                || amount != projection.amount
            {
                return Err(AppError::Conflict(
                    "the split participants or their shares changed after distribution began; reconcile the existing batch before retrying"
                        .to_owned(),
                ));
            }
        }
        batch_id
    };
    txn.commit().await?;
    Ok(batch_id)
}

async fn item_complete(
    control: &DatabaseConnection,
    batch_id: Uuid,
    discord_id: &str,
) -> Result<bool, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT state='complete' FROM alliance_split_distribution_items WHERE batch_id=$1 AND discord_id=$2",
            [batch_id.into(), discord_id.into()],
        ))
        .await?
        .ok_or_else(|| AppError::Internal("split distribution item disappeared".into()))?;
    Ok(row.try_get_by_index(0)?)
}

async fn distribution_complete(
    control: &DatabaseConnection,
    alliance_tenant_id: &str,
    split_id: i64,
) -> Result<bool, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT state='complete' FROM alliance_split_distribution_batches \
             WHERE alliance_tenant_id=$1 AND split_id=$2",
            [alliance_tenant_id.into(), split_id.into()],
        ))
        .await?;
    match row {
        Some(row) => Ok(row.try_get_by_index(0)?),
        None => Ok(false),
    }
}

pub(crate) async fn distribution_batch_exists(
    control: &DatabaseConnection,
    alliance_tenant_id: &str,
    split_id: i64,
) -> Result<bool, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM alliance_split_distribution_batches \
             WHERE alliance_tenant_id=$1 AND split_id=$2",
            [alliance_tenant_id.into(), split_id.into()],
        ))
        .await?;
    Ok(row.is_some())
}

async fn project_one(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    split_id: i64,
    batch_id: Uuid,
    projection: &Projection,
) -> Result<(), AppError> {
    let guild = registry.get_or_load(&projection.guild_tenant_id).await?;
    let active = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM alliance_memberships m JOIN tenants t ON t.id=m.guild_tenant_id \
             WHERE m.alliance_tenant_id=$1 AND m.guild_tenant_id=$2 \
               AND m.status='active' AND t.status='active' AND t.kind='guild'",
            [
                alliance_tenant_id.into(),
                projection.guild_tenant_id.clone().into(),
            ],
        ))
        .await?
        .is_some();
    if !active {
        return Err(AppError::Conflict(format!(
            "guild {} left the alliance during distribution; stop and reconcile this batch before retrying",
            projection.guild_tenant_id
        )));
    }
    // The unique destination key closes the crash window between tenant ledger
    // insertion and acknowledging the item in the control database.
    let key = format!("{batch_id}:{}", projection.discord_id);
    let row = guild
        .db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO transactions \
             (from_user_id,to_user_id,to_guild_bank,amount,status,type,split_id,alliance_distribution_key,source_alliance_tenant_id,source_alliance_split_id,created_at,updated_at) \
             VALUES (NULL,$1,FALSE,$2,$3,'split_credit',NULL,$4,$5,$6,NOW(),NOW()) \
             ON CONFLICT (alliance_distribution_key) DO UPDATE SET alliance_distribution_key=EXCLUDED.alliance_distribution_key \
             RETURNING id",
            [
                projection.destination_user_id.into(),
                projection.amount.into(),
                TransactionStatus::Pending.to_string().into(),
                key.into(),
                alliance_tenant_id.into(),
                split_id.into(),
            ],
        ))
        .await?
        .ok_or_else(|| AppError::Internal("split projection insert returned no transaction".into()))?;
    let transaction_id: i64 = row.try_get_by_index(0)?;
    let update = control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE alliance_split_distribution_items SET state='complete', transaction_id=$3, last_error=NULL, updated_at=NOW() \
             WHERE batch_id=$1 AND discord_id=$2",
            [batch_id.into(), projection.discord_id.clone().into(), transaction_id.into()],
        ))
        .await?;
    if update.rows_affected() != 1 {
        return Err(AppError::Internal(
            "split distribution acknowledgement did not update one recipient".to_owned(),
        ));
    }
    Ok(())
}

async fn mark_batch_failed(
    control: &DatabaseConnection,
    batch_id: Uuid,
    error: &str,
) -> Result<(), AppError> {
    let txn = control.begin().await?;
    txn
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE alliance_split_distribution_batches SET state='failed',last_error=$2,updated_at=NOW() WHERE id=$1",
            [batch_id.into(), error.to_owned().into()],
        ))
        .await?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE alliance_split_distribution_items SET last_error=$2,updated_at=NOW() \
         WHERE batch_id=$1 AND state='pending'",
        [batch_id.into(), error.to_owned().into()],
    ))
    .await?;
    txn.commit().await?;
    Ok(())
}

/// Flips the alliance split to `completed` and writes its `SPLIT_COMPLETED` audit row in one
/// transaction. Returns the audit row only for the call that performed the flip, so a retry that
/// finds the split already completed does not add a second row.
async fn finalize_source_split(
    alliance_db: &DatabaseConnection,
    split_id: i64,
    actor_user_id: i64,
    net_value: sea_orm::prelude::Decimal,
    participant_count: usize,
) -> Result<Option<AuditRow>, AppError> {
    let txn = alliance_db.begin().await?;
    let update = SplitEntity::update_many()
        .filter(SplitColumn::Id.eq(split_id))
        .filter(SplitColumn::Status.is_in(["pending", "awaiting_event"]))
        .set(super::entities::split::ActiveModel {
            status: Set(SplitStatus::Completed.to_string()),
            net_value: Set(Some(net_value)),
            finalized_at: Set(Some(chrono::Utc::now().into())),
            updated_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        })
        .exec(&txn)
        .await?;
    if update.rows_affected == 0 {
        let current = SplitEntity::find_by_id(split_id).one(&txn).await?;
        if current.as_ref().is_none_or(|row| row.status != "completed") {
            return Err(AppError::Conflict(
                "all guild transactions were projected, but the source split could not be finalized; retry to reconcile"
                    .to_owned(),
            ));
        }
        txn.commit().await?;
        return Ok(None);
    }
    let audit = split_audit_in(
        &txn,
        "SPLIT_COMPLETED",
        split_id,
        actor_user_id,
        Some(serde_json::json!({
            "net_value": net_value,
            "participants": participant_count,
            "alliance_distribution": true,
        })),
    )
    .await?;
    txn.commit().await?;
    Ok(Some(audit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::audit::entities::{Column as AuditColumn, Entity as AuditEntity};
    use crate::modules::splits::models::{
        CreateIslandRequest, CreateSplitRequest, UpsertParticipantRequest,
    };
    use sea_orm::{ActiveModelTrait, Database};

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run migrations");
        db
    }

    async fn pending_split(db: &DatabaseConnection, creator: i64, user: i64) -> i64 {
        let island = SplitService::new()
            .create_island(
                db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .expect("island");
        SplitService::new()
            .create_split(
                db,
                creator,
                CreateSplitRequest {
                    estimated_market_value: "100.00".parse().unwrap(),
                    fee: Some(sea_orm::prelude::Decimal::ZERO),
                    repair_value: sea_orm::prelude::Decimal::ZERO,
                    bags_value: sea_orm::prelude::Decimal::ZERO,
                    bags: Vec::new(),
                    note: None,
                    event_id: None,
                    island_tab_id: island.tabs[0].id,
                    participants: vec![UpsertParticipantRequest {
                        user_id: user,
                        weight: sea_orm::prelude::Decimal::ONE,
                    }],
                },
            )
            .await
            .expect("split")
            .summary
            .id
    }

    /// The alliance completion flip writes `SPLIT_COMPLETED` in its own transaction, and a retry
    /// that finds the split already completed adds no second row.
    #[tokio::test]
    async fn alliance_finalize_writes_split_completed_audit_once() {
        use crate::modules::users::entities::ActiveModel as UserActiveModel;
        use sea_orm::prelude::Decimal;
        let db = seed_db().await;
        let admin = UserActiveModel {
            username: Set("admin".to_string()),
            email: Set("admin@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("admin")
        .id;
        let alice = UserActiveModel {
            username: Set("alice".to_string()),
            email: Set("alice@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("alice")
        .id;
        let split_id = pending_split(&db, admin, alice).await;

        let net = Decimal::new(10000, 2);
        let first = finalize_source_split(&db, split_id, admin, net, 1)
            .await
            .expect("first finalize")
            .expect("audit row for the completing call");
        assert_eq!(first.action, "SPLIT_COMPLETED");
        assert_eq!(first.entity_type.as_deref(), Some("SPLIT"));
        assert_eq!(first.entity_id, Some(split_id));
        assert_eq!(first.user_id, Some(admin));
        assert_eq!(first.split_id, Some(split_id));

        let again = finalize_source_split(&db, split_id, admin, net, 1)
            .await
            .expect("retry finalize");
        assert!(again.is_none(), "a retry must not write a second audit row");

        let rows = AuditEntity::find()
            .filter(AuditColumn::Action.eq("SPLIT_COMPLETED"))
            .filter(AuditColumn::EntityId.eq(split_id))
            .all(&db)
            .await
            .expect("audit rows");
        assert_eq!(rows.len(), 1);
        let details = rows[0].details.clone().expect("details");
        assert_eq!(details["participants"], 1);
        assert_eq!(details["alliance_distribution"], true);

        let split = SplitEntity::find_by_id(split_id)
            .one(&db)
            .await
            .expect("split query")
            .expect("split");
        assert_eq!(split.status, "completed");
        assert_eq!(split.net_value, Some(net));
    }

    #[test]
    fn weighted_projection_preserves_the_exact_net_with_last_person_remainder() {
        let weights = [
            (1, sea_orm::prelude::Decimal::from(1)),
            (2, sea_orm::prelude::Decimal::from(1)),
            (3, sea_orm::prelude::Decimal::from(1)),
        ];
        let shares = participant_shares(sea_orm::prelude::Decimal::new(100, 2), &weights);
        assert_eq!(
            shares
                .iter()
                .map(|(_, amount)| *amount)
                .sum::<sea_orm::prelude::Decimal>(),
            sea_orm::prelude::Decimal::new(100, 2)
        );
        assert_eq!(shares[0].1, sea_orm::prelude::Decimal::new(33, 2));
        assert_eq!(shares[1].1, sea_orm::prelude::Decimal::new(33, 2));
        assert_eq!(shares[2].1, sea_orm::prelude::Decimal::new(34, 2));
    }
}
