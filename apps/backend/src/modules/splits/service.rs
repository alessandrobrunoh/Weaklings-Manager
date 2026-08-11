//! Split service logic module.
//!
//! Provides the loot-split workflow: a request that includes its participants upfront (starting
//! in `"pending"` status), officer-driven participant adjustments, and officer-driven closing of
//! the split into `"completed"` (generates Guild Bank transactions), `"not_completed"`, or
//! `"lost"`. Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::collections::HashSet;
use std::str::FromStr;

use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link::Entity as AlbionLinkEntity;
use crate::modules::bank::entities::ActiveModel as TransactionActiveModel;
use crate::modules::bank::service::TYPE_SPLIT_CREDIT;
use crate::modules::bank::status::TransactionStatus;
use crate::modules::events::entities::event::Entity as EventEntity;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{PaginatedData, PaginationParams};

use super::entities::split::{
    ActiveModel as SplitActiveModel, Column as SplitColumn, Entity as SplitEntity,
    Model as SplitModel,
};
use super::entities::split_participant::{
    ActiveModel as ParticipantActiveModel, Column as ParticipantColumn, Entity as ParticipantEntity,
};
use super::models::{
    CreateSplitRequest, MatchedParticipant, SplitDetail, SplitFilters, SplitParticipantView,
    SplitSummary, UpdateSplitRequest, UpsertParticipantRequest,
};
use super::status::SplitStatus;

/// Parses a split model's stored status string into a [`SplitStatus`].
///
/// The stored value is always one written by this service, so a parse failure indicates
/// database corruption rather than a user-facing condition.
fn parse_status(split: &SplitModel) -> Result<SplitStatus, AppError> {
    SplitStatus::from_str(&split.status)
        .map_err(|_| AppError::Internal(format!("Unknown split status: {}", split.status)))
}

/// Ensures an optional event link points to a real event.
async fn validate_event_link(
    db: &DatabaseConnection,
    event_id: Option<i64>,
) -> Result<(), AppError> {
    let Some(event_id) = event_id else {
        return Ok(());
    };

    let exists = EventEntity::find_by_id(event_id).count(db).await? > 0;
    if exists {
        return Ok(());
    }

    Err(AppError::NotFound(format!("Event {event_id} not found")))
}

/// Resolves the event title for a linked split summary.
async fn event_title(
    db: &DatabaseConnection,
    event_id: Option<i64>,
) -> Result<Option<String>, AppError> {
    let Some(event_id) = event_id else {
        return Ok(None);
    };

    let title = EventEntity::find_by_id(event_id)
        .one(db)
        .await?
        .map(|event| event.title);
    Ok(title)
}

/// Service for executing business logic operations related to loot splits.
pub struct SplitService;

impl SplitService {
    /// Creates a new instance of the `SplitService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub(crate) async fn to_summary(
        &self,
        db: &DatabaseConnection,
        split: SplitModel,
    ) -> Result<SplitSummary, AppError> {
        let status = parse_status(&split)?;
        let created_by_username =
            crate::modules::users::display_name::resolve_by_id(db, split.created_by).await?;
        let participant_count = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split.id))
            .count(db)
            .await?;
        let linked_event_title = event_title(db, split.event_id).await?;

        Ok(SplitSummary {
            id: split.id,
            created_by_username,
            status,
            estimated_market_value: split.estimated_market_value,
            repair_value: split.repair_value,
            bags_value: split.bags_value,
            net_value: split.net_value,
            note: split.note,
            event_id: split.event_id,
            event_title: linked_event_title,
            created_at: split.created_at.to_rfc3339(),
            finalized_at: split.finalized_at.map(|dt| dt.to_rfc3339()),
            participant_count,
        })
    }

    async fn to_detail(
        &self,
        db: &DatabaseConnection,
        split: SplitModel,
    ) -> Result<SplitDetail, AppError> {
        let participants = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split.id))
            .all(db)
            .await?;

        let total_weight: i64 = participants.iter().map(|p| i64::from(p.weight)).sum();
        let net_value = split.net_value;

        // Once completed, the authoritative share amounts are whatever was actually written to
        // the transactions table at completion time (which applies remainder-correction so the
        // sum is exact) — read those back rather than recomputing, to avoid the two diverging.
        let generated_amounts: std::collections::HashMap<i64, Decimal> = if net_value.is_some() {
            crate::modules::bank::entities::Entity::find()
                .filter(crate::modules::bank::entities::Column::SplitId.eq(split.id))
                .all(db)
                .await?
                .into_iter()
                .map(|tx| (tx.to_user_id, tx.amount))
                .collect()
        } else {
            std::collections::HashMap::new()
        };

        let participant_ids: Vec<i64> = participants.iter().map(|p| p.user_id).collect();
        let names =
            crate::modules::users::display_name::resolve_by_ids(db, &participant_ids).await?;

        let mut views = Vec::with_capacity(participants.len());
        for p in participants {
            let username = names
                .get(&p.user_id)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            let share_amount = generated_amounts.get(&p.user_id).copied().or_else(|| {
                net_value.map(|net| {
                    if total_weight == 0 {
                        Decimal::ZERO
                    } else {
                        (net * Decimal::from(p.weight) / Decimal::from(total_weight)).round_dp(2)
                    }
                })
            });
            views.push(SplitParticipantView {
                user_id: p.user_id,
                username,
                weight: p.weight,
                share_amount,
            });
        }

        let summary = self.to_summary(db, split).await?;

        Ok(SplitDetail {
            summary,
            participants: views,
        })
    }

    /// Requests a new split together with its participants. Starts in [`SplitStatus::Pending`],
    /// awaiting an officer to close it via [`Self::complete_split`], [`Self::mark_not_completed`],
    /// or [`Self::mark_lost`].
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if `participants` is empty, contains a duplicate user id,
    ///   or a non-positive weight.
    /// * Returns `AppError::Database` if the insert fails.
    pub async fn create_split(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateSplitRequest,
    ) -> Result<SplitDetail, AppError> {
        if req.participants.is_empty() {
            return Err(AppError::Validation(
                "a split must be requested with at least one participant".to_string(),
            ));
        }
        if req.participants.iter().any(|p| p.weight <= 0) {
            return Err(AppError::Validation("weight must be positive".to_string()));
        }
        let mut seen = HashSet::with_capacity(req.participants.len());
        if !req.participants.iter().all(|p| seen.insert(p.user_id)) {
            return Err(AppError::Validation(
                "participants must not contain duplicate user ids".to_string(),
            ));
        }

        validate_event_link(db, req.event_id).await?;

        let txn = db.begin().await?;

        let active = SplitActiveModel {
            created_by: Set(creator_id),
            status: Set(SplitStatus::Pending.to_string()),
            estimated_market_value: Set(req.estimated_market_value),
            repair_value: Set(req.repair_value),
            bags_value: Set(req.bags_value),
            net_value: Set(None),
            note: Set(req.note),
            event_id: Set(req.event_id),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;

        for participant in &req.participants {
            let active = ParticipantActiveModel {
                split_id: Set(inserted.id),
                user_id: Set(participant.user_id),
                weight: Set(participant.weight),
                ..Default::default()
            };
            active.insert(&txn).await?;
        }

        txn.commit().await?;

        self.to_detail(db, inserted).await
    }

    async fn load_with_status(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        expected: SplitStatus,
        action: &str,
    ) -> Result<SplitModel, AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
        if parse_status(&split)? != expected {
            return Err(AppError::Validation(format!(
                "cannot {action} a split that is not in {expected} status"
            )));
        }
        Ok(split)
    }

    /// Closes a pending split with a terminal, non-completing status (`"not_completed"` or
    /// `"lost"`) — no Guild Bank transactions are generated.
    async fn close_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        status: SplitStatus,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "close")
            .await?;
        let mut active: SplitActiveModel = split.into();
        active.status = Set(status.to_string());
        let updated = active.update(db).await?;
        self.to_detail(db, updated).await
    }

    /// Marks a pending split as not completed (e.g. the distribution didn't happen). Terminal.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not in `"pending"` status.
    pub async fn mark_not_completed(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        self.close_split(db, split_id, SplitStatus::NotCompleted)
            .await
    }

    /// Marks a pending split as lost — the loot was never recovered. Terminal.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not in `"pending"` status.
    pub async fn mark_lost(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        self.close_split(db, split_id, SplitStatus::Lost).await
    }

    /// Updates mutable split values while the split is still pending.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` if the split is not pending.
    pub async fn update_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        req: UpdateSplitRequest,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "update")
            .await?;
        let mut active: SplitActiveModel = split.into();

        if let Some(value) = req.estimated_market_value {
            active.estimated_market_value = Set(value);
        }
        if let Some(value) = req.repair_value {
            active.repair_value = Set(value);
        }
        if let Some(value) = req.bags_value {
            active.bags_value = Set(value);
        }
        if let Some(note) = req.note {
            let trimmed = note.trim().to_string();
            active.note = Set((!trimmed.is_empty()).then_some(trimmed));
        }
        if let Some(event_id) = req.event_id {
            validate_event_link(db, event_id).await?;
            active.event_id = Set(event_id);
        }

        let updated = active.update(db).await?;
        self.to_detail(db, updated).await
    }

    /// Deletes a split entirely.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the split does not exist.
    pub async fn delete_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<(), AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;

        let txn = db.begin().await?;
        ParticipantEntity::delete_many()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .exec(&txn)
            .await?;

        let active: SplitActiveModel = split.into();
        active.delete(&txn).await?;

        txn.commit().await?;
        Ok(())
    }

    /// Fetches a split's full detail by id.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the split does not exist.
    pub async fn get_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
        self.to_detail(db, split).await
    }

    /// Lists paginated and filtered splits from the database.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_splits(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &SplitFilters,
    ) -> Result<PaginatedData<SplitSummary>, AppError> {
        let mut query = SplitEntity::find();
        if let Some(status) = filters.status {
            query = query.filter(SplitColumn::Status.eq(status.to_string()));
        }
        if let Some(event_id) = filters.event_id {
            query = query.filter(SplitColumn::EventId.eq(event_id));
        }

        if let Some(search) = filters.search.as_deref().filter(|s| !s.trim().is_empty()) {
            let pattern = format!("%{}%", search.trim());

            let note_cond = sea_orm::sea_query::Expr::expr(sea_orm::sea_query::Func::lower(
                sea_orm::sea_query::Expr::col(SplitColumn::Note),
            ))
            .like(pattern.to_lowercase());

            let user_subquery = sea_orm::sea_query::Query::select()
                .column(UserColumn::Id)
                .from(UserEntity)
                .and_where(
                    sea_orm::sea_query::Expr::expr(sea_orm::sea_query::Func::lower(
                        sea_orm::sea_query::Expr::col(UserColumn::Username),
                    ))
                    .like(pattern.to_lowercase()),
                )
                .to_owned();

            let creator_cond = SplitColumn::CreatedBy.in_subquery(user_subquery);

            query = query.filter(sea_orm::Condition::any().add(note_cond).add(creator_cond));
        }

        if let Some(date_from) = &filters.date_from {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date_from) {
                query = query.filter(SplitColumn::CreatedAt.gte(dt));
            }
        }

        if let Some(date_to) = &filters.date_to {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date_to) {
                query = query.filter(SplitColumn::CreatedAt.lte(dt));
            }
        }

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let mut items = Vec::with_capacity(models.len());
        for model in models {
            items.push(self.to_summary(db, model).await?);
        }

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Adds a new participant to a pending split, or updates their weight if already present.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not pending, or the weight is not positive.
    pub async fn add_or_update_participant(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        req: UpsertParticipantRequest,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "modify")
            .await?;

        if req.weight <= 0 {
            return Err(AppError::Validation("weight must be positive".to_string()));
        }

        let existing = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .filter(ParticipantColumn::UserId.eq(req.user_id))
            .one(db)
            .await?;

        if let Some(existing) = existing {
            let mut active: ParticipantActiveModel = existing.into();
            active.weight = Set(req.weight);
            active.update(db).await?;
        } else {
            let active = ParticipantActiveModel {
                split_id: Set(split_id),
                user_id: Set(req.user_id),
                weight: Set(req.weight),
                ..Default::default()
            };
            active.insert(db).await?;
        }

        self.to_detail(db, split).await
    }

    /// Removes a participant from a pending split.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not pending.
    pub async fn remove_participant(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        user_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "modify")
            .await?;

        ParticipantEntity::delete_many()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .filter(ParticipantColumn::UserId.eq(user_id))
            .exec(db)
            .await?;

        self.to_detail(db, split).await
    }

    /// Completes a pending split: computes the net value and atomically generates one Guild Bank
    /// transaction per participant.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if the split is not pending, has no participants, or the
    ///   net value is not positive.
    /// * Returns `AppError::Database` if the transaction fails.
    pub async fn complete_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        officer_user_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "complete")
            .await?;

        let participants = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .all(db)
            .await?;

        if participants.is_empty() {
            return Err(AppError::Validation(
                "cannot complete a split with no participants".to_string(),
            ));
        }

        let net_value = split.estimated_market_value - split.repair_value + split.bags_value;
        if net_value <= Decimal::ZERO {
            return Err(AppError::Validation(
                "split net value must be positive to complete".to_string(),
            ));
        }

        let total_weight: i64 = participants.iter().map(|p| i64::from(p.weight)).sum();

        let txn = db.begin().await?;

        let mut running_total = Decimal::ZERO;
        let last_index = participants.len() - 1;
        for (i, participant) in participants.iter().enumerate() {
            let share = if i == last_index {
                net_value - running_total
            } else {
                let s = (net_value * Decimal::from(participant.weight)
                    / Decimal::from(total_weight))
                .round_dp(2);
                running_total += s;
                s
            };

            let active = TransactionActiveModel {
                from_user_id: Set(None),
                to_user_id: Set(participant.user_id),
                amount: Set(share),
                status: Set(TransactionStatus::Pending.to_string()),
                r#type: Set(TYPE_SPLIT_CREDIT.to_string()),
                split_id: Set(Some(split_id)),
                ..Default::default()
            };
            let inserted_tx = active.insert(&txn).await?;
            let _ = crate::modules::audit::service::AuditService::log(
                db,
                "TRANSACTION_CREATED",
                Some("TRANSACTION"),
                Some(inserted_tx.id),
                Some(officer_user_id),
                Some(serde_json::json!({
                    "split_id": split_id,
                    "amount": share,
                    "type": TYPE_SPLIT_CREDIT,
                    "target_user_id": participant.user_id
                })),
            )
            .await;
        }

        let mut split_active: SplitActiveModel = split.into();
        split_active.status = Set(SplitStatus::Completed.to_string());
        split_active.net_value = Set(Some(net_value));
        split_active.finalized_at = Set(Some(chrono::Utc::now().into()));
        let updated_split = split_active.update(&txn).await?;

        txn.commit().await?;

        self.to_detail(db, updated_split).await
    }

    /// Matches a list of raw candidate names (e.g. OCR'd from a screenshot) against known,
    /// already-linked Albion Online players, resolving each match to a `users.id`.
    ///
    /// Matching is case-insensitive against each user's linked Albion Online character name
    /// (`albion_links.albion_player_name`). Only names that resolve all the way to an existing
    /// `users` row are returned — unmatched names, or names linked to a Discord account that
    /// has never logged into this app (so has no `discord_id` on its `users` row), are silently
    /// dropped rather than surfaced as an error. Results are deduplicated by `user_id`.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the underlying queries fail.
    pub async fn match_participants(
        &self,
        db: &DatabaseConnection,
        names: &[String],
    ) -> Result<Vec<MatchedParticipant>, AppError> {
        if names.is_empty() {
            return Ok(vec![]);
        }

        let links = AlbionLinkEntity::find().all(db).await?;

        let mut seen = HashSet::new();
        let mut out = Vec::new();

        for name in names {
            let needle = name.trim().to_lowercase();
            if needle.is_empty() {
                continue;
            }

            let Some(link) = links
                .iter()
                .find(|l| l.albion_player_name.to_lowercase() == needle)
            else {
                continue;
            };

            let user = UserEntity::find()
                .filter(UserColumn::DiscordId.eq(&link.discord_id))
                .one(db)
                .await?;

            if let Some(user) = user
                && seen.insert(user.id)
            {
                out.push(MatchedParticipant {
                    user_id: user.id,
                    username: user.username,
                    matched_name: link.albion_player_name.clone(),
                });
            }
        }

        Ok(out)
    }
}

impl Default for SplitService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user.insert(db).await.expect("Failed to insert user").id
    }

    async fn insert_user_with_discord_id(
        db: &DatabaseConnection,
        username: &str,
        email: &str,
        discord_id: &str,
    ) -> i64 {
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some(discord_id.to_string())),
            ..Default::default()
        };
        user.insert(db).await.expect("Failed to insert user").id
    }

    async fn insert_albion_link(
        db: &DatabaseConnection,
        discord_id: &str,
        player_id: &str,
        player_name: &str,
    ) {
        use crate::modules::albion::entities::albion_link::ActiveModel as AlbionLinkActiveModel;

        let link = AlbionLinkActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(player_id.to_string()),
            albion_player_name: Set(player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };
        link.insert(db).await.expect("Failed to insert albion link");
    }

    fn request(
        market: &str,
        repair: &str,
        bags: &str,
        participants: Vec<UpsertParticipantRequest>,
    ) -> CreateSplitRequest {
        CreateSplitRequest {
            estimated_market_value: market.parse().unwrap(),
            repair_value: repair.parse().unwrap(),
            bags_value: bags.parse().unwrap(),
            note: None,
            event_id: None,
            participants,
        }
    }

    #[tokio::test]
    async fn test_create_split_requires_at_least_one_participant() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;

        let service = SplitService::new();
        let result = service
            .create_split(&db, admin, request("50.00", "0.00", "0.00", vec![]))
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_split_rejects_duplicate_participants() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let result = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![
                        UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        },
                        UpsertParticipantRequest {
                            user_id: alice,
                            weight: 2,
                        },
                    ],
                ),
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_split_starts_pending_with_participants() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![UpsertParticipantRequest {
                        user_id: alice,
                        weight: 1,
                    }],
                ),
            )
            .await
            .unwrap();

        assert_eq!(split.summary.status, SplitStatus::Pending);
        assert_eq!(split.participants.len(), 1);
    }

    #[tokio::test]
    async fn test_complete_split_distributes_exact_net_value_with_rounding() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let carol = insert_user(&db, "carol", "carol@example.com").await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                request(
                    "100.00",
                    "0.00",
                    "0.00",
                    vec![alice, bob, carol]
                        .into_iter()
                        .map(|user_id| UpsertParticipantRequest { user_id, weight: 1 })
                        .collect(),
                ),
            )
            .await
            .unwrap();

        let completed = service
            .complete_split(&db, split.summary.id, admin)
            .await
            .unwrap();
        assert_eq!(completed.summary.status, SplitStatus::Completed);

        let total: Decimal = completed
            .participants
            .iter()
            .map(|p| p.share_amount.unwrap())
            .sum();
        assert_eq!(total, "100.00".parse::<Decimal>().unwrap());
    }

    #[tokio::test]
    async fn test_complete_split_twice_fails() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![UpsertParticipantRequest {
                        user_id: alice,
                        weight: 1,
                    }],
                ),
            )
            .await
            .unwrap();

        service
            .complete_split(&db, split.summary.id, admin)
            .await
            .unwrap();
        let second = service.complete_split(&db, split.summary.id, admin).await;
        assert!(second.is_err());
    }

    #[tokio::test]
    async fn test_mark_not_completed_is_terminal() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![UpsertParticipantRequest {
                        user_id: alice,
                        weight: 1,
                    }],
                ),
            )
            .await
            .unwrap();

        let closed = service
            .mark_not_completed(&db, split.summary.id)
            .await
            .unwrap();
        assert_eq!(closed.summary.status, SplitStatus::NotCompleted);

        let complete_result = service.complete_split(&db, split.summary.id, admin).await;
        assert!(complete_result.is_err());
    }

    #[tokio::test]
    async fn test_mark_lost_is_terminal() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![UpsertParticipantRequest {
                        user_id: alice,
                        weight: 1,
                    }],
                ),
            )
            .await
            .unwrap();

        let closed = service.mark_lost(&db, split.summary.id).await.unwrap();
        assert_eq!(closed.summary.status, SplitStatus::Lost);

        let complete_result = service.complete_split(&db, split.summary.id, admin).await;
        assert!(complete_result.is_err());
    }

    #[tokio::test]
    async fn test_match_participants_matches_linked_case_insensitively() {
        let db = seed_db().await;
        let alice_id = insert_user_with_discord_id(&db, "alice", "alice@example.com", "111").await;
        insert_albion_link(&db, "111", "player-1", "AliceInAlbion").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(
                &db,
                &["aliceinalbion".to_string(), "NoSuchPlayer".to_string()],
            )
            .await
            .unwrap();

        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].user_id, alice_id);
        assert_eq!(matched[0].matched_name, "AliceInAlbion");
    }

    #[tokio::test]
    async fn test_match_participants_skips_links_with_no_matching_user() {
        let db = seed_db().await;
        insert_albion_link(&db, "222", "player-2", "GhostPlayer").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(&db, &["GhostPlayer".to_string()])
            .await
            .unwrap();

        assert!(matched.is_empty());
    }

    #[tokio::test]
    async fn test_match_participants_dedupes_by_user_id() {
        let db = seed_db().await;
        let bob_id = insert_user_with_discord_id(&db, "bob", "bob@example.com", "333").await;
        insert_albion_link(&db, "333", "player-3", "Bobby").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(&db, &["Bobby".to_string(), "bobby".to_string()])
            .await
            .unwrap();

        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].user_id, bob_id);
    }
}
