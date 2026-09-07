//! Business logic for the regear module.
//!
//! Orchestrates the lifecycle of `regear_deaths` rows: list/get views, member-initiated
//! requests, officer adjudication (accept / reject), settings management, and the bridge into
//! the Guild Bank on accept. The extraction job itself lives in `extractor.rs`.

use std::str::FromStr;

use chrono::Utc;
use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link;
use crate::modules::bank::entities::ActiveModel as BankActiveModel;
use crate::modules::bank::status::TransactionStatus;
use crate::modules::comps::entities::{build, comp_build};
use crate::modules::events::entities::{event, event_participation};
use crate::modules::openalbion::service::aodp_identifier_for_stored_item;
use crate::modules::users::entities as user_entities;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::credits::{consume_request_credit, get_or_create_balance};
use super::entities::{
    RegearDeathActiveModel, RegearDeathColumn, RegearDeathEntity, RegearDeathModel,
    RegearSettingActiveModel, RegearSettingEntity, RegearSettingModel,
};
use super::extractor::{ExtractionGuildContext, RegearExtractor};
use super::models::{
    AcceptRegearRequest, BreakdownRow, CreateSelfServiceRegearRequest, DeathFilters, DeathView,
    ExtractionReport, RegearBudgetSummary, RegearSettingsView, RejectRegearRequest,
    SelfServiceCompBuildOption, SelfServiceEventOption, UpdateRegearSettingsRequest,
};
use super::slots::albionbb_key_for_slot;
use super::status::{RegearSource, RegearStatus};

/// The transaction type written into the Guild Bank when a regear is accepted.
pub const TYPE_REGEAR_CREDIT: &str = "regear_credit";

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

    /// Moves a death from `available` to `pending`, consuming one request credit (bonus pool
    /// first, then weekly).
    ///
    /// The credit check runs inside the same transaction that flips the status, so concurrent
    /// clicks on different deaths cannot overspend the balance. The credit is never refunded if
    /// an officer later rejects the request.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] if the death does not exist; [`AppError::Forbidden`] if the
    /// caller is not the victim; [`AppError::Conflict`] if the death is not in the `available`
    /// status; [`AppError::Validation`] if the caller has no requests remaining.
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

        consume_request_credit(&txn, &settings, caller_user_id).await?;

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

    /// The caller's current request-credit balance: weekly pool and bonus pool, each with its
    /// configured cap. Applies the lazy weekly top-up before returning, so the balance shown is
    /// always current even though nothing ticks it on a schedule.
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
        let balance = get_or_create_balance(db, &settings, caller_user_id).await?;

        Ok(RegearBudgetSummary {
            weekly_balance: balance.weekly_balance,
            weekly_cap: settings.weekly_request_cap,
            bonus_balance: balance.bonus_balance,
            bonus_cap: settings.bonus_request_cap,
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
        for (name, value) in [
            (
                "weekly_request_topup_amount",
                req.weekly_request_topup_amount,
            ),
            ("weekly_request_cap", req.weekly_request_cap),
            ("bonus_request_cap", req.bonus_request_cap),
        ] {
            if value.is_some_and(|value| value < 0) {
                return Err(AppError::Validation(format!("{name} must be >= 0")));
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
        if let Some(value) = req.weekly_request_topup_amount {
            active.weekly_request_topup_amount = Set(value);
        }
        if let Some(value) = req.weekly_request_cap {
            active.weekly_request_cap = Set(value);
        }
        if let Some(value) = req.bonus_request_cap {
            active.bonus_request_cap = Set(value);
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
                "weekly_request_topup_amount": req.weekly_request_topup_amount,
                "weekly_request_cap": req.weekly_request_cap,
                "bonus_request_cap": req.bonus_request_cap,
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

    /// Lists the events the caller may open a self-service regear request for: events they
    /// participated in, that are regear-eligible, and for which they don't already have a
    /// pending or approved self-reported request.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] on DB failure.
    pub async fn get_self_service_events(
        &self,
        db: &DatabaseConnection,
        caller_user_id: i64,
    ) -> Result<Vec<SelfServiceEventOption>, AppError> {
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::UserId.eq(caller_user_id))
            .all(db)
            .await?;

        let mut options = Vec::new();
        for participation in participations {
            let Some(event_row) = event::Entity::find_by_id(participation.event_id)
                .one(db)
                .await?
            else {
                continue;
            };
            if !event_row.regear {
                continue;
            }
            if self
                .has_active_self_report(db, event_row.id, caller_user_id)
                .await?
            {
                continue;
            }

            let primary_build_name = match participation.primary_build_id {
                Some(id) => build::Entity::find_by_id(id).one(db).await?.map(|b| b.name),
                None => None,
            };
            let secondary_build_name = match participation.secondary_build_id {
                Some(id) => build::Entity::find_by_id(id).one(db).await?.map(|b| b.name),
                None => None,
            };

            let comp_build_rows = comp_build::Entity::find()
                .filter(comp_build::Column::CompId.eq(event_row.comp_id))
                .all(db)
                .await?;
            let mut comp_builds = Vec::with_capacity(comp_build_rows.len());
            for row in comp_build_rows {
                let Some(build_row) = build::Entity::find_by_id(row.build_id).one(db).await? else {
                    continue;
                };
                comp_builds.push(SelfServiceCompBuildOption {
                    build_id: row.build_id,
                    build_name: build_row.name,
                    quantity: row.quantity,
                });
            }

            options.push(SelfServiceEventOption {
                event_id: event_row.id,
                event_title: event_row.title,
                primary_build_id: participation.primary_build_id,
                primary_build_name,
                secondary_build_id: participation.secondary_build_id,
                secondary_build_name,
                comp_id: event_row.comp_id,
                comp_builds,
            });
        }

        options.sort_by(|a, b| b.event_id.cmp(&a.event_id));
        Ok(options)
    }

    /// `true` if the caller already has a pending or approved self-reported request for this
    /// event — the application-layer duplicate guard, since the DB unique index cannot cover
    /// self-reported rows (they carry no battle/kill-feed key).
    async fn has_active_self_report(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
    ) -> Result<bool, AppError> {
        let count = RegearDeathEntity::find()
            .filter(RegearDeathColumn::EventId.eq(event_id))
            .filter(RegearDeathColumn::UserId.eq(user_id))
            .filter(RegearDeathColumn::Source.eq(RegearSource::SelfReported.to_string()))
            .filter(RegearDeathColumn::Status.is_in([
                RegearStatus::Pending.to_string(),
                RegearStatus::Approved.to_string(),
            ]))
            .count(db)
            .await?;
        Ok(count > 0)
    }

    /// Opens a member-initiated regear request, without waiting on the kill-feed extractor.
    ///
    /// The caller picks an event they participated in and a build from that event's comp
    /// (typically their assigned build, but they may claim any build in the comp — what they
    /// signed up with often differs from what they actually equipped), optionally overriding
    /// individual slots. The resulting loadout is priced the same way an extracted death is
    /// (`pricing::build_breakdown`) and inserted directly as `pending`, consuming one request
    /// credit, landing in the same officer queue as extracted deaths.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Forbidden`] if the caller did not participate in the event;
    /// [`AppError::Validation`] if the event is not regear-eligible, the build is not part of the
    /// event's comp, or the caller has no requests remaining; [`AppError::Conflict`] if the
    /// caller already has an active self-reported request for this event.
    pub async fn create_self_service_request(
        &self,
        db: &DatabaseConnection,
        albiondata: &crate::modules::albiondata::service::AlbionDataService,
        guild: &ExtractionGuildContext,
        caller_user_id: i64,
        req: &CreateSelfServiceRegearRequest,
    ) -> Result<DeathView, AppError> {
        use crate::modules::comps::entities::build_item;
        use crate::modules::comps::status::{BuildLoadout, BuildSlot};

        let settings = load_settings(db).await?;

        event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(req.event_id))
            .filter(event_participation::Column::UserId.eq(caller_user_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::Forbidden("you did not participate in this event".to_string())
            })?;

        let event_row = event::Entity::find_by_id(req.event_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("event {} not found", req.event_id)))?;
        if !event_row.regear {
            return Err(AppError::Validation(
                "event is not regear-eligible".to_string(),
            ));
        }

        if self
            .has_active_self_report(db, event_row.id, caller_user_id)
            .await?
        {
            return Err(AppError::Conflict(
                "you already have a self-reported regear request for this event".to_string(),
            ));
        }

        comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(event_row.comp_id))
            .filter(comp_build::Column::BuildId.eq(req.build_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::Validation("build is not part of this event's comp".to_string())
            })?;

        let build_items = build_item::Entity::find()
            .filter(build_item::Column::BuildId.eq(req.build_id))
            .filter(build_item::Column::Loadout.eq(BuildLoadout::Main.as_str()))
            .all(db)
            .await?;

        let mut equipment = serde_json::Map::new();
        let mut covered_slots: Vec<BuildSlot> = Vec::new();
        for item in &build_items {
            let Ok(slot) = BuildSlot::from_str(&item.slot) else {
                continue;
            };
            covered_slots.push(slot);
            let override_item = req.item_overrides.iter().find(|o| o.slot == slot);
            let (item_id, enchantment, icon) = match override_item {
                Some(o) => (o.openalbion_item_id, o.openalbion_item_enchantment, None),
                None => (
                    item.openalbion_item_id,
                    item.openalbion_item_enchantment,
                    item.openalbion_item_icon.as_deref(),
                ),
            };
            if let Some(identifier) = aodp_identifier_for_stored_item(item_id, icon, enchantment) {
                equipment.insert(
                    albionbb_key_for_slot(slot).to_string(),
                    serde_json::json!({ "Type": identifier, "Count": 1 }),
                );
            }
        }
        for item_override in &req.item_overrides {
            if covered_slots.contains(&item_override.slot) {
                continue;
            }
            if let Some(identifier) = aodp_identifier_for_stored_item(
                item_override.openalbion_item_id,
                None,
                item_override.openalbion_item_enchantment,
            ) {
                equipment.insert(
                    albionbb_key_for_slot(item_override.slot).to_string(),
                    serde_json::json!({ "Type": identifier, "Count": 1 }),
                );
            }
        }
        let equipment_value = serde_json::Value::Object(equipment);
        let loadout_json =
            serde_json::to_string(&equipment_value).unwrap_or_else(|_| "{}".to_string());

        let (breakdown, total) =
            super::pricing::build_breakdown(albiondata, &equipment_value, &settings, guild.server.as_deref())
                .await
                .unwrap_or_else(|err| {
                    tracing::warn!(error = %err, "self-service regear pricing failed; falling back to empty breakdown");
                    (Vec::new(), Decimal::ZERO)
                });
        let breakdown_json = serde_json::to_string(&breakdown).unwrap_or_else(|_| "[]".to_string());

        let player_name = resolve_player_name(db, caller_user_id).await?;

        let txn = db.begin().await?;
        consume_request_credit(&txn, &settings, caller_user_id).await?;

        let now = Utc::now().into();
        let active = RegearDeathActiveModel {
            event_id: Set(req.event_id),
            event_battle_id: Set(None),
            albionbb_battle_id: Set(None),
            albion_kill_event_id: Set(None),
            killed_at: Set(now),
            user_id: Set(Some(caller_user_id)),
            player_name: Set(player_name),
            guild_id: Set(guild.guild_id.clone()),
            primary_build_id: Set(Some(req.build_id)),
            loadout_json: Set(loadout_json.clone()),
            auto_estimate_total: Set(total),
            auto_estimate_breakdown_json: Set(breakdown_json),
            status: Set(RegearStatus::Pending.to_string()),
            requested_at: Set(Some(now)),
            source: Set(RegearSource::SelfReported.to_string()),
            override_loadout_json: Set(if req.item_overrides.is_empty() {
                None
            } else {
                Some(loadout_json)
            }),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "REGEAR_SELF_REPORTED",
            Some("REGEAR_DEATH"),
            Some(inserted.id),
            Some(caller_user_id),
            Some(serde_json::json!({
                "event_id": req.event_id,
                "build_id": req.build_id,
                "auto_estimate_total": total.to_string(),
            })),
        )
        .await;

        to_view_with_joins(db, inserted).await
    }
}

impl Default for RegearService {
    fn default() -> Self {
        Self::new()
    }
}

/// Loads the singleton settings row, raising `Internal` if it is missing (it is seeded by the
/// migration so this should only happen on a corrupted DB).
///
/// Generic over `ConnectionTrait` (not just `DatabaseConnection`) so `giveaways::service` can
/// call it with `&txn` from inside its own draw transaction — acquiring a second pool connection
/// there instead would deadlock a single-connection SQLite pool. `pub(crate)` for that same
/// cross-module use.
pub(crate) async fn load_settings<C>(db: &C) -> Result<RegearSettingModel, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    RegearSettingEntity::find()
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal("regear_settings singleton row is missing".to_string()))
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
    let source = RegearSource::from_str(&model.source).map_err(|err| {
        AppError::Internal(format!("invalid source on death {}: {err}", model.id))
    })?;

    Ok(DeathView::from_model(
        model,
        event_title,
        primary_build_name,
        status,
        source,
    ))
}

/// Resolves the caller's linked Albion in-game name, for stamping a self-reported request's
/// `player_name`. Falls back to the Manager username when the caller has no Albion link.
async fn resolve_player_name(db: &DatabaseConnection, user_id: i64) -> Result<String, AppError> {
    let user = user_entities::Entity::find_by_id(user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))?;
    if let Some(discord_id) = &user.discord_id {
        let link = albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id.clone()))
            .one(db)
            .await?;
        if let Some(link) = link {
            return Ok(link.albion_player_name);
        }
    }
    Ok(user.username)
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
    use chrono::Duration as ChronoDuration;
    use sea_orm::entity::prelude::DateTimeWithTimeZone;
    use sea_orm::{ActiveModelTrait, Database, DatabaseConnection};

    use super::super::entities::{
        RegearRequestBalanceActiveModel, RegearRequestBalanceColumn, RegearRequestBalanceEntity,
    };

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
            event_battle_id: Set(Some(1)),
            albionbb_battle_id: Set(Some("battle-1".into())),
            albion_kill_event_id: Set(Some(kill_event_id.into())),
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

    async fn insert_user_row(db: &DatabaseConnection, username: &str) -> i64 {
        crate::modules::users::entities::ActiveModel {
            username: Set(username.into()),
            email: Set(format!("{username}@example.com")),
            role: Set("User".into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    /// Seeds a balance row directly, bypassing the lazy top-up, so a test can pin an exact
    /// starting state instead of racing the real clock.
    async fn seed_balance(db: &DatabaseConnection, user_id: i64, weekly: i32, bonus: i32) {
        RegearRequestBalanceActiveModel {
            user_id: Set(user_id),
            weekly_balance: Set(weekly),
            weekly_last_topup_at: Set(Utc::now().into()),
            bonus_balance: Set(bonus),
            created_at: Set(Utc::now().into()),
            updated_at: Set(Utc::now().into()),
        }
        .insert(db)
        .await
        .expect("insert balance");
    }

    #[tokio::test]
    async fn request_regear_consumes_bonus_before_weekly() {
        let db = seed_db().await;
        let user = insert_user_row(&db, "alice").await;
        seed_balance(&db, user, 2, 1).await;
        let now = Utc::now().into();
        let death = insert_death(&db, "Alice", RegearStatus::Available, now, "k-alice").await;
        let mut active: RegearDeathActiveModel = death.clone().into();
        active.user_id = Set(Some(user));
        active.update(&db).await.expect("link victim");

        RegearService::new()
            .request_regear(&db, user, death.id)
            .await
            .expect("request regear");

        let balance = RegearRequestBalanceEntity::find()
            .filter(RegearRequestBalanceColumn::UserId.eq(user))
            .one(&db)
            .await
            .unwrap()
            .expect("balance row");
        assert_eq!(balance.bonus_balance, 0, "bonus pool is spent first");
        assert_eq!(
            balance.weekly_balance, 2,
            "weekly pool untouched while bonus remained"
        );
    }

    #[tokio::test]
    async fn request_regear_fails_when_no_credit_remaining() {
        let db = seed_db().await;
        let user = insert_user_row(&db, "bob").await;
        seed_balance(&db, user, 0, 0).await;
        let now = Utc::now().into();
        let death = insert_death(&db, "Bob", RegearStatus::Available, now, "k-bob-2").await;
        let mut active: RegearDeathActiveModel = death.clone().into();
        active.user_id = Set(Some(user));
        active.update(&db).await.expect("link victim");

        let error = RegearService::new()
            .request_regear(&db, user, death.id)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));

        // The death must still be `available` — a failed credit check aborts the whole request.
        let reloaded = RegearDeathEntity::find_by_id(death.id)
            .one(&db)
            .await
            .unwrap()
            .expect("death row");
        assert_eq!(reloaded.status, "available");
    }

    async fn insert_build_with_item(db: &DatabaseConnection, name: &str, creator: i64) -> i64 {
        use crate::modules::comps::entities::{build, build_category, build_item};
        let category = build_category::ActiveModel {
            name: Set(format!("cat-{name}")),
            slug: Set(format!("cat-{name}")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build category")
        .id;
        let build_id = build::ActiveModel {
            name: Set(name.into()),
            role: Set("dps".into()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build")
        .id;
        build_item::ActiveModel {
            build_id: Set(build_id),
            loadout: Set("main".into()),
            slot: Set("weapon".into()),
            openalbion_item_type: Set("weapon".into()),
            openalbion_item_id: Set(1),
            openalbion_item_name: Set("Broadsword".into()),
            openalbion_item_icon: Set(Some(
                "https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64"
                    .into(),
            )),
            openalbion_item_tier: Set(Some("T8".into())),
            openalbion_item_quality: Set(4),
            openalbion_item_enchantment: Set(0),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build item");
        build_id
    }

    async fn insert_comp_with_build(
        db: &DatabaseConnection,
        name: &str,
        creator: i64,
        build_id: i64,
    ) -> i64 {
        use crate::modules::comps::entities::{comp, comp_build, comp_category};
        let category = comp_category::ActiveModel {
            name: Set(format!("comp-cat-{name}")),
            slug: Set(format!("comp-cat-{name}")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("comp category")
        .id;
        let comp_id = comp::ActiveModel {
            name: Set(name.into()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("comp")
        .id;
        comp_build::ActiveModel {
            comp_id: Set(comp_id),
            build_id: Set(build_id),
            quantity: Set(1),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("comp build");
        comp_id
    }

    async fn insert_regear_event(
        db: &DatabaseConnection,
        title: &str,
        creator: i64,
        comp_id: i64,
    ) -> i64 {
        event::ActiveModel {
            title: Set(title.into()),
            comp_id: Set(comp_id),
            created_by: Set(creator),
            event_date_utc: Set(Utc::now().into()),
            regear: Set(true),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("event")
        .id
    }

    #[tokio::test]
    async fn create_self_service_request_rejects_a_non_participant() {
        let db = seed_db().await;
        let officer = insert_user_row(&db, "officer2").await;
        let member = insert_user_row(&db, "outsider").await;
        seed_balance(&db, member, 2, 0).await;
        let build_id = insert_build_with_item(&db, "Healer Build", officer).await;
        let comp_id = insert_comp_with_build(&db, "Test Comp", officer, build_id).await;
        let event_id = insert_regear_event(&db, "Test CTA", officer, comp_id).await;

        let albiondata = crate::modules::albiondata::service::AlbionDataService::default();
        let guild = ExtractionGuildContext {
            guild_id: "guild-1".into(),
            server: None,
        };
        let error = RegearService::new()
            .create_self_service_request(
                &db,
                &albiondata,
                &guild,
                member,
                &CreateSelfServiceRegearRequest {
                    event_id,
                    build_id,
                    item_overrides: Vec::new(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Forbidden(_)));
    }

    #[tokio::test]
    async fn create_self_service_request_opens_a_pending_self_reported_row_and_spends_a_credit() {
        let db = seed_db().await;
        let officer = insert_user_row(&db, "officer3").await;
        let member = insert_user_row(&db, "member1").await;
        seed_balance(&db, member, 2, 1).await;
        let build_id = insert_build_with_item(&db, "Tank Build", officer).await;
        let comp_id = insert_comp_with_build(&db, "Tank Comp", officer, build_id).await;
        let event_id = insert_regear_event(&db, "Tank CTA", officer, comp_id).await;
        crate::modules::events::entities::event_participation::ActiveModel {
            event_id: Set(event_id),
            user_id: Set(member),
            primary_build_id: Set(Some(build_id)),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("participation");

        let albiondata = crate::modules::albiondata::service::AlbionDataService::default();
        let guild = ExtractionGuildContext {
            guild_id: "guild-1".into(),
            server: None,
        };
        let death = RegearService::new()
            .create_self_service_request(
                &db,
                &albiondata,
                &guild,
                member,
                &CreateSelfServiceRegearRequest {
                    event_id,
                    build_id,
                    item_overrides: Vec::new(),
                },
            )
            .await
            .expect("self-service request");

        assert_eq!(death.status, RegearStatus::Pending);
        assert_eq!(death.source, RegearSource::SelfReported);
        assert!(death.event_battle_id.is_none());

        let balance = RegearRequestBalanceEntity::find()
            .filter(RegearRequestBalanceColumn::UserId.eq(member))
            .one(&db)
            .await
            .unwrap()
            .expect("balance row");
        assert_eq!(balance.bonus_balance, 0, "bonus pool spent first");
        assert_eq!(balance.weekly_balance, 2);

        // Lands in the same officer queue as an extracted death — no special-casing needed.
        let queue = RegearService::new()
            .list_deaths(
                &db,
                officer,
                true,
                &page(),
                &DeathFilters {
                    status: Some(RegearStatus::Pending),
                    ..Default::default()
                },
            )
            .await
            .expect("officer queue");
        assert!(queue.items.iter().any(|item| item.id == death.id));

        // A second self-service request for the same event is rejected while this one is active.
        let duplicate = RegearService::new()
            .create_self_service_request(
                &db,
                &albiondata,
                &guild,
                member,
                &CreateSelfServiceRegearRequest {
                    event_id,
                    build_id,
                    item_overrides: Vec::new(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(duplicate, AppError::Conflict(_)));
    }
}
