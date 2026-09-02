//! Business logic for the regear module.
//!
//! Orchestrates the lifecycle of `regear_deaths` rows: list/get views, member-initiated
//! requests, officer adjudication (accept / reject), settings management, and the bridge into
//! the Guild Bank on accept. The extraction job itself lives in `extractor.rs`.

use std::str::FromStr;

use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::bank::entities::ActiveModel as BankActiveModel;
use crate::modules::bank::status::TransactionStatus;
use crate::modules::comps::entities::build;
use crate::modules::events::entities::event;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{
    RegearDeathActiveModel, RegearDeathColumn, RegearDeathEntity, RegearDeathModel,
    RegearSettingActiveModel, RegearSettingEntity,
};
use super::extractor::{ExtractionGuildContext, RegearExtractor};
use super::models::{
    AcceptRegearRequest, BreakdownRow, DeathFilters, DeathView, ExtractionReport,
    RegearBudgetSummary, RegearSettingsView, RejectRegearRequest, UpdateRegearSettingsRequest,
};
use super::status::RegearStatus;

/// The transaction type written into the Guild Bank when a regear is accepted.
pub const TYPE_REGEAR_CREDIT: &str = "regear_credit";

/// Rolling window (in days) for the per-month regear cap.
///
/// Shared with the intel report, which surfaces how much of the cap each
/// member has used. The two must agree, or officers would be shown a usage
/// figure that the enforcement below does not actually apply.
pub(crate) const PER_MONTH_WINDOW_DAYS: i64 = 30;

/// Service for executing regear business logic.
pub struct RegearService;

impl RegearService {
    /// Creates a new instance. Stateless — the struct exists for symmetry with the other modules.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Lists deaths visible to the caller, paginated and filtered.
    ///
    /// Without `global=true`, only the caller's own deaths are returned. With `global=true`
    /// (requires `regear.adjudicate`), all deaths are returned. The caller is responsible for
    /// enforcing that permission before invoking this method with `global=true`.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] on DB failure.
    pub async fn list_deaths(
        &self,
        db: &DatabaseConnection,
        viewer_user_id: i64,
        global: bool,
        pagination: &PaginationParams,
        filters: &DeathFilters,
    ) -> Result<PaginatedData<DeathView>, AppError> {
        let mut condition = Condition::all();
        if let Some(event_id) = filters.event_id {
            condition = condition.add(RegearDeathColumn::EventId.eq(event_id));
        }
        if let Some(status) = filters.status {
            condition = condition.add(RegearDeathColumn::Status.eq(status.to_string()));
        } else if filters.history.unwrap_or(false) {
            condition = condition.add(RegearDeathColumn::Status.is_in([
                RegearStatus::Approved.to_string(),
                RegearStatus::Rejected.to_string(),
            ]));
        }
        if let Some(user_id) = filters.user_id {
            condition = condition.add(RegearDeathColumn::UserId.eq(user_id));
        }
        if let Some(tx_id) = filters.bank_transaction_id {
            condition = condition.add(RegearDeathColumn::BankTransactionId.eq(tx_id));
        }
        if let Some(search) = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            condition = condition.add(RegearDeathColumn::PlayerName.contains(search));
        }
        if !global {
            condition = condition.add(RegearDeathColumn::UserId.eq(viewer_user_id));
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("killed_at", RegearDeathColumn::KilledAt),
                ("status", RegearDeathColumn::Status),
                ("player_name", RegearDeathColumn::PlayerName),
            ],
            RegearDeathColumn::KilledAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let query = RegearDeathEntity::find().filter(condition);
        let query = match order {
            SortOrder::Asc => query.order_by_asc(sort_column),
            SortOrder::Desc => query.order_by_desc(sort_column),
        };
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let views = to_views_with_joins(db, models).await?;

        Ok(PaginatedData::new(
            views,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Fetches one death by id, with all display joins populated.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] if the death does not exist.
    pub async fn get_death(
        &self,
        db: &DatabaseConnection,
        death_id: i64,
    ) -> Result<DeathView, AppError> {
        let model = RegearDeathEntity::find_by_id(death_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("regear death {death_id} not found")))?;
        to_view_with_joins(db, model).await
    }

    /// Moves a death from `available` to `pending`, enforcing the per-event and per-month caps.
    ///
    /// The caps are evaluated inside the same transaction that flips the status, so concurrent
    /// clicks on different deaths cannot overrun them.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] if the death does not exist; [`AppError::Forbidden`] if the
    /// caller is not the victim; [`AppError::Conflict`] if the death is not in the `available`
    /// status; [`AppError::Validation`] if a cap would be exceeded.
    pub async fn request_regear(
        &self,
        db: &DatabaseConnection,
        caller_user_id: i64,
        death_id: i64,
    ) -> Result<DeathView, AppError> {
        let settings = load_settings(db).await?;

        let txn = db.begin().await?;
        let model = RegearDeathEntity::find_by_id(death_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("regear death {death_id} not found")))?;

        if model.user_id != Some(caller_user_id) {
            return Err(AppError::Forbidden(
                "you can only request regear for your own deaths".to_string(),
            ));
        }
        let status = RegearStatus::from_str(&model.status).map_err(|err| {
            AppError::Internal(format!("invalid status on death {death_id}: {err}"))
        })?;
        if status != RegearStatus::Available {
            return Err(AppError::Conflict(format!(
                "death {death_id} is not available (status: {status})"
            )));
        }

        let event_used = count_event_active_for_user(&txn, model.event_id, caller_user_id).await?;
        if event_used >= u64::from(settings.max_regears_per_event.max(0) as u32) {
            return Err(AppError::Validation(format!(
                "per-event regear cap reached ({}/{})",
                event_used, settings.max_regears_per_event
            )));
        }

        let month_used = count_recent_approvals_for_user(&txn, caller_user_id).await?;
        if month_used >= u64::from(settings.max_regears_per_month.max(0) as u32) {
            return Err(AppError::Validation(format!(
                "per-month regear cap reached ({}/{})",
                month_used, settings.max_regears_per_month
            )));
        }

        let now = Utc::now().into();
        let mut active: RegearDeathActiveModel = model.into();
        active.status = Set(RegearStatus::Pending.to_string());
        active.requested_at = Set(Some(now));
        active.updated_at = Set(now);
        let updated = active.update(&txn).await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_REQUESTED",
            Some("REGEAR_DEATH"),
            Some(updated.id),
            Some(caller_user_id),
            Some(serde_json::json!({ "status": "pending" })),
        )
        .await;

        to_view_with_joins(db, updated).await
    }

    /// Officer accepts a pending regear: locks the breakdown, credits a Guild Bank row, and marks
    /// the death terminal `approved`. All three steps run in one DB transaction.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] if the death does not exist; [`AppError::Conflict`] if the
    /// death is not `pending`; [`AppError::Validation`] if the breakdown does not sum to
    /// `final_amount` or if the victim has no linked user.
    pub async fn accept_request(
        &self,
        db: &DatabaseConnection,
        officer_user_id: i64,
        death_id: i64,
        req: &AcceptRegearRequest,
    ) -> Result<DeathView, AppError> {
        let computed_total = sum_included(&req.breakdown);
        if computed_total != req.final_amount {
            return Err(AppError::Validation(format!(
                "breakdown total ({computed_total}) does not match final_amount ({})",
                req.final_amount
            )));
        }

        let txn = db.begin().await?;
        let model = RegearDeathEntity::find_by_id(death_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("regear death {death_id} not found")))?;

        let status = RegearStatus::from_str(&model.status).map_err(|err| {
            AppError::Internal(format!("invalid status on death {death_id}: {err}"))
        })?;
        if status != RegearStatus::Pending {
            return Err(AppError::Conflict(format!(
                "death {death_id} is not pending (status: {status})"
            )));
        }
        let Some(user_id) = model.user_id else {
            return Err(AppError::Validation(
                "victim is not linked to a user; cannot credit a bank row".to_string(),
            ));
        };

        let now = Utc::now().into();
        let breakdown_json = serde_json::to_string(&req.breakdown)
            .map_err(|err| AppError::Internal(format!("failed to serialize breakdown: {err}")))?;

        // Guard the status flip with a conditional update, checked before the Guild Bank credit is
        // created: a concurrent acceptance/rejection between the read above and here loses the
        // race here instead of creating a duplicate credit and overwriting `decided_by_user_id`.
        let flip = RegearDeathEntity::update_many()
            .filter(RegearDeathColumn::Id.eq(death_id))
            .filter(RegearDeathColumn::Status.eq(RegearStatus::Pending.to_string()))
            .set(RegearDeathActiveModel {
                status: Set(RegearStatus::Approved.to_string()),
                decided_at: Set(Some(now)),
                decided_by_user_id: Set(Some(officer_user_id)),
                final_amount: Set(Some(req.final_amount)),
                final_breakdown_json: Set(Some(breakdown_json)),
                officer_note: Set(req.note.clone()),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec(&txn)
            .await?;

        if flip.rows_affected != 1 {
            return Err(AppError::Conflict(format!(
                "death {death_id} is no longer pending (accepted or rejected by a concurrent request)"
            )));
        }

        // Insert the Guild Bank row in `pending` so the user still has to withdraw it.
        let bank_active = BankActiveModel {
            id: sea_orm::ActiveValue::NotSet,
            from_user_id: Set(None),
            to_user_id: Set(user_id),
            to_guild_bank: Set(false),
            amount: Set(req.final_amount),
            status: Set(TransactionStatus::Pending.to_string()),
            r#type: Set(TYPE_REGEAR_CREDIT.to_string()),
            split_id: Set(None),
            created_at: Set(now),
            requested_at: Set(None),
            withdrawn_at: Set(None),
            updated_at: Set(now),
        };
        let inserted_bank = bank_active.insert(&txn).await?;

        RegearDeathEntity::update_many()
            .filter(RegearDeathColumn::Id.eq(death_id))
            .set(RegearDeathActiveModel {
                bank_transaction_id: Set(Some(inserted_bank.id)),
                ..Default::default()
            })
            .exec(&txn)
            .await?;

        let updated = RegearDeathEntity::find_by_id(death_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::Internal("accepted regear death disappeared".to_string()))?;

        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_ACCEPTED",
            Some("REGEAR_DEATH"),
            Some(updated.id),
            Some(officer_user_id),
            Some(serde_json::json!({
                "final_amount": req.final_amount.to_string(),
                "bank_transaction_id": inserted_bank.id,
            })),
        )
        .await;

        // Separate `TRANSACTION`-tagged entry for the bank credit itself — the
        // entry above is tagged `REGEAR_DEATH` (a regear workflow state
        // change), which `AuditService::log`'s transaction-spam channel
        // filter only matches on `entity_type == "TRANSACTION"`. Without
        // this, every regear payout was invisible in that channel even
        // though it is exactly the kind of bank ledger activity it exists
        // to surface — the same class of event `WITHDRAW_ACCEPTED` and
        // splits' `TRANSACTION_CREATED` already tag correctly.
        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "TRANSACTION_CREATED",
            Some("TRANSACTION"),
            Some(inserted_bank.id),
            Some(officer_user_id),
            Some(serde_json::json!({
                "amount": req.final_amount.to_string(),
                "type": TYPE_REGEAR_CREDIT,
                "target_user_id": user_id,
            })),
        )
        .await;

        if user_id != officer_user_id {
            crate::modules::notifications::notify_best_effort(
                db,
                crate::modules::notifications::NotifySpec {
                    kind: crate::modules::notifications::NotificationKind::RegearAccepted,
                    user_ids: &[user_id],
                    title: "Regear approved".into(),
                    body: format!(
                        "Your regear was credited to the guild bank ({amount} silver).",
                        amount = req.final_amount
                    ),
                    link_path: Some(format!("/regears/{death_id}")),
                    source_type: "regear_death",
                    source_id: updated.id,
                    created_by_user_id: Some(officer_user_id),
                },
            )
            .await;
        }

        to_view_with_joins(db, updated).await
    }

    /// Officer rejects a pending regear: terminal state. The note is mandatory.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] if the death does not exist; [`AppError::Conflict`] if the
    /// death is not `pending`; [`AppError::Validation`] if the note is empty or > 500 chars.
    pub async fn reject_request(
        &self,
        db: &DatabaseConnection,
        officer_user_id: i64,
        death_id: i64,
        req: &RejectRegearRequest,
    ) -> Result<DeathView, AppError> {
        let trimmed = req.note.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation("reject note is required".to_string()));
        }
        if trimmed.len() > 500 {
            return Err(AppError::Validation(
                "reject note must be at most 500 chars".to_string(),
            ));
        }

        let txn = db.begin().await?;
        let model = RegearDeathEntity::find_by_id(death_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("regear death {death_id} not found")))?;

        let status = RegearStatus::from_str(&model.status).map_err(|err| {
            AppError::Internal(format!("invalid status on death {death_id}: {err}"))
        })?;
        if status != RegearStatus::Pending {
            return Err(AppError::Conflict(format!(
                "death {death_id} is not pending (status: {status})"
            )));
        }

        let recipient = model.user_id;
        let now = Utc::now().into();
        let mut active: RegearDeathActiveModel = model.into();
        active.status = Set(RegearStatus::Rejected.to_string());
        active.decided_at = Set(Some(now));
        active.decided_by_user_id = Set(Some(officer_user_id));
        active.officer_note = Set(Some(trimmed.to_string()));
        active.updated_at = Set(now);
        let updated = active.update(&txn).await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_REJECTED",
            Some("REGEAR_DEATH"),
            Some(updated.id),
            Some(officer_user_id),
            Some(serde_json::json!({ "note": trimmed })),
        )
        .await;

        if let Some(user_id) = recipient
            && user_id != officer_user_id
        {
            crate::modules::notifications::notify_best_effort(
                db,
                crate::modules::notifications::NotifySpec {
                    kind: crate::modules::notifications::NotificationKind::RegearRejected,
                    user_ids: &[user_id],
                    title: "Regear rejected".into(),
                    body: format!("Your regear request was rejected: {trimmed}"),
                    link_path: Some(format!("/regears/{death_id}")),
                    source_type: "regear_death",
                    source_id: updated.id,
                    created_by_user_id: Some(officer_user_id),
                },
            )
            .await;
        }

        to_view_with_joins(db, updated).await
    }

    /// Per-user budget usage for the most recent CTA event and the rolling 30-day window.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] on DB failure.
    pub async fn get_my_summary(
        &self,
        db: &DatabaseConnection,
        caller_user_id: i64,
    ) -> Result<RegearBudgetSummary, AppError> {
        let settings = load_settings(db).await?;

        // Most recent CTA event the caller has any death for.
        let most_recent_event = RegearDeathEntity::find()
            .filter(RegearDeathColumn::UserId.eq(caller_user_id))
            .order_by_desc(RegearDeathColumn::EventId)
            .one(db)
            .await?
            .map(|m| m.event_id);

        let per_event_used = match most_recent_event {
            Some(event_id) => {
                count_event_active_for_user(db, event_id, caller_user_id).await? as i32
            }
            None => 0,
        };
        let per_month_used = count_recent_approvals_for_user(db, caller_user_id).await? as i32;

        Ok(RegearBudgetSummary {
            per_event_used,
            per_event_max: settings.max_regears_per_event,
            per_month_used,
            per_month_max: settings.max_regears_per_month,
        })
    }

    /// Returns the singleton settings row as a view.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Internal`] if the singleton is missing.
    pub async fn get_settings(
        &self,
        db: &DatabaseConnection,
    ) -> Result<RegearSettingsView, AppError> {
        let model = load_settings(db).await?;
        Ok(RegearSettingsView::from_model(model))
    }

    /// Updates the singleton settings row with the non-`None` fields of `req`.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] for negative caps or invalid strategy strings, and
    /// [`AppError::Database`] on DB failure.
    pub async fn update_settings(
        &self,
        db: &DatabaseConnection,
        officer_user_id: i64,
        req: &UpdateRegearSettingsRequest,
    ) -> Result<RegearSettingsView, AppError> {
        let existing = load_settings(db).await?;
        if let Some(value) = req.max_regears_per_event {
            if value < 0 {
                return Err(AppError::Validation(
                    "max_regears_per_event must be >= 0".to_string(),
                ));
            }
        }
        if let Some(value) = req.max_regears_per_month {
            if value < 0 {
                return Err(AppError::Validation(
                    "max_regears_per_month must be >= 0".to_string(),
                ));
            }
        }
        if let Some(strategy) = &req.pricing_fallback_strategy {
            if strategy != "cheapest_any" && strategy != "strict" {
                return Err(AppError::Validation(
                    "pricing_fallback_strategy must be 'cheapest_any' or 'strict'".to_string(),
                ));
            }
        }

        let mut active: RegearSettingActiveModel = existing.into();
        if let Some(value) = req.max_regears_per_event {
            active.max_regears_per_event = Set(value);
        }
        if let Some(value) = req.max_regears_per_month {
            active.max_regears_per_month = Set(value);
        }
        if let Some(mask) = req.enabled_slots_mask {
            active.enabled_slots_mask = Set(mask);
        }
        if let Some(location) = &req.pricing_location {
            active.pricing_location = Set(location.clone());
        }
        if let Some(strategy) = &req.pricing_fallback_strategy {
            active.pricing_fallback_strategy = Set(strategy.clone());
        }
        active.updated_at = Set(Utc::now().into());
        active.updated_by_user_id = Set(Some(officer_user_id));
        let updated = active.update(db).await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_SETTINGS_SET",
            Some("REGEAR_SETTINGS"),
            Some(1),
            Some(officer_user_id),
            Some(serde_json::json!({
                "max_regears_per_event": req.max_regears_per_event,
                "max_regears_per_month": req.max_regears_per_month,
                "enabled_slots_mask": req.enabled_slots_mask,
                "pricing_location": req.pricing_location,
                "pricing_fallback_strategy": req.pricing_fallback_strategy,
            })),
        )
        .await;

        Ok(RegearSettingsView::from_model(updated))
    }

    /// Wraps the extractor. Lives on the service so the router can call it without instantiating
    /// the extractor directly.
    ///
    /// # Errors
    ///
    /// Propagates extractor errors verbatim.
    pub async fn run_extraction(
        &self,
        db: &DatabaseConnection,
        albiondata: &crate::modules::albiondata::service::AlbionDataService,
        guild: ExtractionGuildContext,
        event_id: i64,
    ) -> Result<ExtractionReport, AppError> {
        let extractor = RegearExtractor::new(db, albiondata, guild);
        let report = extractor.extract_for_event(event_id).await?;
        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_EXTRACTED",
            Some("EVENT"),
            Some(event_id),
            None,
            Some(serde_json::json!({
                "battles_scanned": report.battles_scanned,
                "deaths_inserted": report.deaths_inserted,
                "deaths_skipped": report.deaths_skipped,
            })),
        )
        .await;
        Ok(report)
    }
}

impl Default for RegearService {
    fn default() -> Self {
        Self::new()
    }
}

/// Loads the singleton settings row, raising `Internal` if it is missing (it is seeded by the
/// migration so this should only happen on a corrupted DB).
async fn load_settings(
    db: &DatabaseConnection,
) -> Result<super::entities::RegearSettingModel, AppError> {
    RegearSettingEntity::find()
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal("regear_settings singleton row is missing".to_string()))
}

/// Counts the caller's `pending + approved` deaths for one event. Used by the per-event cap.
async fn count_event_active_for_user<C>(
    db: &C,
    event_id: i64,
    user_id: i64,
) -> Result<u64, AppError>
where
    C: ConnectionTrait,
{
    let pending = RegearDeathEntity::find()
        .filter(RegearDeathColumn::EventId.eq(event_id))
        .filter(RegearDeathColumn::UserId.eq(user_id))
        .filter(RegearDeathColumn::Status.eq(RegearStatus::Pending.to_string()))
        .count(db)
        .await?;
    let approved = RegearDeathEntity::find()
        .filter(RegearDeathColumn::EventId.eq(event_id))
        .filter(RegearDeathColumn::UserId.eq(user_id))
        .filter(RegearDeathColumn::Status.eq(RegearStatus::Approved.to_string()))
        .count(db)
        .await?;
    Ok(pending + approved)
}

/// Counts the caller's `approved` deaths in the rolling 30-day window. Used by the per-month cap.
async fn count_recent_approvals_for_user<C>(db: &C, user_id: i64) -> Result<u64, AppError>
where
    C: ConnectionTrait,
{
    let cutoff = Utc::now() - ChronoDuration::days(PER_MONTH_WINDOW_DAYS);
    RegearDeathEntity::find()
        .filter(RegearDeathColumn::UserId.eq(user_id))
        .filter(RegearDeathColumn::Status.eq(RegearStatus::Approved.to_string()))
        .filter(RegearDeathColumn::DecidedAt.gte(cutoff))
        .count(db)
        .await
        .map_err(AppError::Database)
}

/// Sums the contributions of included breakdown rows. Used by `accept_request` to verify the
/// officer-supplied total.
fn sum_included(rows: &[BreakdownRow]) -> Decimal {
    rows.iter()
        .filter(|row| row.included)
        .fold(Decimal::ZERO, |acc, row| acc + row.contribution())
}

/// Builds a [`DeathView`] from one model, joining the event title and the build name.
async fn to_view_with_joins(
    db: &DatabaseConnection,
    model: RegearDeathModel,
) -> Result<DeathView, AppError> {
    let event_title = event::Entity::find_by_id(model.event_id)
        .one(db)
        .await?
        .map(|event| event.title)
        .unwrap_or_else(|| format!("<event {}>", model.event_id));

    let primary_build_name = match model.primary_build_id {
        Some(build_id) => build::Entity::find_by_id(build_id)
            .one(db)
            .await?
            .map(|build| build.name),
        None => None,
    };

    let status = RegearStatus::from_str(&model.status).map_err(|err| {
        AppError::Internal(format!("invalid status on death {}: {err}", model.id))
    })?;

    Ok(DeathView::from_model(
        model,
        event_title,
        primary_build_name,
        status,
    ))
}

/// Resolves a batch of model rows into views, reusing [`to_view_with_joins`].
async fn to_views_with_joins(
    db: &DatabaseConnection,
    models: Vec<RegearDeathModel>,
) -> Result<Vec<DeathView>, AppError> {
    let mut views = Vec::with_capacity(models.len());
    for model in models {
        views.push(to_view_with_joins(db, model).await?);
    }
    Ok(views)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::status::BuildSlot;
    use sea_orm::entity::prelude::DateTimeWithTimeZone;
    use sea_orm::{ActiveModelTrait, Database, DatabaseConnection};

    #[test]
    fn sum_included_ignores_excluded_rows() {
        let rows = vec![
            BreakdownRow {
                slot: BuildSlot::Weapon,
                item_id: "T8_MAIN_X".to_string(),
                quality: 1,
                unit_price: Decimal::from(1_000_000),
                quantity: 1,
                included: true,
            },
            BreakdownRow {
                slot: BuildSlot::Head,
                item_id: "T8_HEAD_X".to_string(),
                quality: 1,
                unit_price: Decimal::from(200_000),
                quantity: 1,
                included: false,
            },
        ];
        assert_eq!(sum_included(&rows), Decimal::from(1_000_000));
    }

    #[test]
    fn sum_included_multiplies_by_quantity() {
        let rows = vec![BreakdownRow {
            slot: BuildSlot::Potion,
            item_id: "T8_POTION_X".to_string(),
            quality: 1,
            unit_price: Decimal::from(5_000),
            quantity: 3,
            included: true,
        }];
        assert_eq!(sum_included(&rows), Decimal::from(15_000));
    }

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run migrations");
        db
    }

    async fn insert_death(
        db: &DatabaseConnection,
        player_name: &str,
        status: RegearStatus,
        killed_at: DateTimeWithTimeZone,
        kill_event_id: &str,
    ) -> RegearDeathModel {
        let now = Utc::now().into();
        RegearDeathActiveModel {
            event_id: Set(1),
            event_battle_id: Set(1),
            albionbb_battle_id: Set("battle-1".into()),
            albion_kill_event_id: Set(kill_event_id.into()),
            killed_at: Set(killed_at),
            player_name: Set(player_name.into()),
            guild_id: Set("guild-1".into()),
            loadout_json: Set("{}".into()),
            auto_estimate_total: Set(Decimal::from(100)),
            auto_estimate_breakdown_json: Set("[]".into()),
            status: Set(status.to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert regear death")
    }

    fn page() -> PaginationParams {
        PaginationParams {
            page: Some(1),
            limit: Some(10),
        }
    }

    #[tokio::test]
    async fn list_deaths_searches_player_name() {
        let db = seed_db().await;
        let t1 = (Utc::now() - ChronoDuration::hours(2)).into();
        let t2 = (Utc::now() - ChronoDuration::hours(1)).into();
        insert_death(&db, "Ann", RegearStatus::Available, t1, "k-ann").await;
        insert_death(&db, "Zed", RegearStatus::Available, t2, "k-zed").await;

        let page = RegearService::new()
            .list_deaths(
                &db,
                1,
                true,
                &page(),
                &DeathFilters {
                    search: Some("nn".into()),
                    ..Default::default()
                },
            )
            .await
            .expect("list deaths");
        assert_eq!(page.total_items, 1);
        assert_eq!(page.items[0].player_name, "Ann");
    }

    #[tokio::test]
    async fn list_deaths_sorts_by_player_name() {
        let db = seed_db().await;
        let t1 = (Utc::now() - ChronoDuration::hours(2)).into();
        let t2 = (Utc::now() - ChronoDuration::hours(1)).into();
        let t3 = Utc::now().into();
        insert_death(&db, "Ann", RegearStatus::Available, t1, "k-ann").await;
        insert_death(&db, "Bob", RegearStatus::Pending, t2, "k-bob").await;
        insert_death(&db, "Zed", RegearStatus::Approved, t3, "k-zed").await;

        let default_page = RegearService::new()
            .list_deaths(&db, 1, true, &page(), &DeathFilters::default())
            .await
            .expect("list deaths default sort");
        let default_names: Vec<_> = default_page
            .items
            .iter()
            .map(|death| death.player_name.as_str())
            .collect();
        assert_eq!(default_names, vec!["Zed", "Bob", "Ann"]);

        let sorted = RegearService::new()
            .list_deaths(
                &db,
                1,
                true,
                &page(),
                &DeathFilters {
                    sort: Some("player_name".into()),
                    order: Some("asc".into()),
                    ..Default::default()
                },
            )
            .await
            .expect("list deaths by player_name");
        let names: Vec<_> = sorted
            .items
            .iter()
            .map(|death| death.player_name.as_str())
            .collect();
        assert_eq!(names, vec!["Ann", "Bob", "Zed"]);
    }

    #[tokio::test]
    async fn list_deaths_history_is_terminal_only() {
        let db = seed_db().await;
        let now = Utc::now().into();
        insert_death(&db, "Ann", RegearStatus::Approved, now, "k-ann").await;
        insert_death(&db, "Bob", RegearStatus::Rejected, now, "k-bob").await;
        insert_death(&db, "Zed", RegearStatus::Pending, now, "k-zed").await;

        let page = RegearService::new()
            .list_deaths(
                &db,
                1,
                true,
                &page(),
                &DeathFilters {
                    history: Some(true),
                    ..Default::default()
                },
            )
            .await
            .expect("list history");
        assert_eq!(page.total_items, 2);
        let mut names: Vec<_> = page
            .items
            .iter()
            .map(|death| death.player_name.as_str())
            .collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Ann", "Bob"]);
    }

    #[tokio::test]
    async fn list_deaths_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let error = RegearService::new()
            .list_deaths(
                &db,
                1,
                true,
                &page(),
                &DeathFilters {
                    sort: Some("fame".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn accept_request_notifies_the_victim() {
        let db = seed_db().await;
        let victim = crate::modules::users::entities::ActiveModel {
            username: Set("victim".into()),
            email: Set("victim@example.com".into()),
            role: Set("User".into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("victim")
        .id;
        let officer = crate::modules::users::entities::ActiveModel {
            username: Set("officer".into()),
            email: Set("officer@example.com".into()),
            role: Set("User".into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("officer")
        .id;
        let now = Utc::now().into();
        let death = insert_death(&db, "Victim", RegearStatus::Pending, now, "k-victim").await;
        let mut active: RegearDeathActiveModel = death.clone().into();
        active.user_id = Set(Some(victim));
        active.update(&db).await.expect("link victim");

        RegearService::new()
            .accept_request(
                &db,
                officer,
                death.id,
                &AcceptRegearRequest {
                    final_amount: Decimal::from(100),
                    breakdown: vec![BreakdownRow {
                        slot: BuildSlot::Weapon,
                        item_id: "T8_MAIN_X".into(),
                        quality: 1,
                        unit_price: Decimal::from(100),
                        quantity: 1,
                        included: true,
                    }],
                    note: None,
                },
            )
            .await
            .expect("accept");

        let inbox = crate::modules::notifications::entities::NotificationEntity::find()
            .filter(crate::modules::notifications::entities::NotificationColumn::UserId.eq(victim))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].kind, "regear_accepted");
        assert_eq!(inbox[0].source_id, death.id);
    }
}
