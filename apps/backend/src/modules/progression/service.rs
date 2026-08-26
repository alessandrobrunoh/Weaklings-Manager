//! Progression service: seasons, curve, XP awards, and the caller's rank snapshot.

use chrono::{DateTime, Duration, FixedOffset, Utc};
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use uuid::Uuid;

use crate::errors::AppError;
use crate::modules::users::display_name;
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{PaginatedData, PaginationParams};

use super::curve::{apply_multiplier, level_for_xp, threshold, xp_to_next};
use super::entities::{
    ProgressionAccountActiveModel, ProgressionAccountColumn, ProgressionAccountEntity,
    ProgressionAccountModel, ProgressionSeasonActiveModel, ProgressionSeasonColumn,
    ProgressionSeasonEntity, ProgressionSeasonModel, ProgressionSettingActiveModel,
    ProgressionSettingEntity, ProgressionSettingModel, ProgressionXpLedgerActiveModel,
    ProgressionXpLedgerColumn, ProgressionXpLedgerEntity, ProgressionXpLedgerModel,
};
use super::models::{
    AdjustProgressionRequest, AwardMessageRequest, AwardMessageView, AwardOutcome, AwardSpec,
    CreateSeasonRequest, LeaderboardEntryView, LevelThresholdView, ProgressionMeView,
    ProgressionSettingsView, SeasonView, UpdateProgressionSettingsRequest, UpdateSeasonRequest,
    XpLedgerEntryView,
};
use super::status::XpSource;

/// Stateless progression operations.
pub struct ProgressionService;

impl Default for ProgressionService {
    fn default() -> Self {
        Self
    }
}

impl ProgressionService {
    /// Creates a new instance. Stateless — the struct exists for symmetry with the other modules.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// The caller's season XP, level, rank, and lifetime total.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if a query fails. Missing settings is treated as an internal
    /// error because the singleton is seeded by the migration.
    pub async fn get_me(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<ProgressionMeView, AppError> {
        let settings = load_settings(db).await?;
        let curve = Curve::from_settings(&settings);
        let now = Utc::now().into();
        let season = find_covering_season(db, now).await?;
        let lifetime_xp = lifetime_xp(db, user_id).await?;

        let Some(season) = season else {
            return Ok(empty_me(lifetime_xp));
        };

        let account = ProgressionAccountEntity::find()
            .filter(ProgressionAccountColumn::UserId.eq(user_id))
            .filter(ProgressionAccountColumn::SeasonId.eq(season.id))
            .one(db)
            .await?;

        let (xp, level, multiplier) = match account {
            Some(row) => (row.xp, row.level, row.xp_multiplier),
            None => (0, 1, Decimal::ONE),
        };
        let rank = rank_for(db, season.id, user_id, xp).await?;
        let next_level_at = if level >= curve.max_level {
            0
        } else {
            threshold(level + 1, curve.base, curve.exponent)
        };

        Ok(ProgressionMeView {
            season: Some(season_view(&season)),
            level,
            xp,
            xp_to_next: xp_to_next(xp, level, curve.base, curve.exponent, curve.max_level),
            next_level_at,
            rank: Some(rank),
            multiplier,
            lifetime_xp,
        })
    }

    /// Grants XP for `spec` if a covering active season exists and the idempotency key is new.
    ///
    /// Failures of this method must not roll back the caller (events, Discord). Callers that need
    /// that isolation should catch the error themselves.
    ///
    /// # Errors
    ///
    /// Database errors from the transaction.
    pub async fn award(
        &self,
        db: &DatabaseConnection,
        spec: AwardSpec,
    ) -> Result<AwardOutcome, AppError> {
        let settings = load_settings(db).await?;
        let base_amount = spec
            .base_amount
            .unwrap_or_else(|| rate_for(&settings, spec.source).into());
        if base_amount <= 0 {
            return Ok(AwardOutcome::SkippedRate);
        }

        let now: DateTime<FixedOffset> = Utc::now().into();
        let Some(season) = find_covering_season(db, now).await? else {
            return Ok(AwardOutcome::NoActiveSeason);
        };

        let curve = Curve::from_settings(&settings);
        let txn = db.begin().await?;

        let existing = ProgressionXpLedgerEntity::find()
            .filter(ProgressionXpLedgerColumn::SeasonId.eq(season.id))
            .filter(ProgressionXpLedgerColumn::IdempotencyKey.eq(spec.idempotency_key.clone()))
            .one(&txn)
            .await?;
        if existing.is_some() {
            txn.commit().await?;
            return Ok(AwardOutcome::Duplicate);
        }

        let account = ProgressionAccountEntity::find()
            .filter(ProgressionAccountColumn::UserId.eq(spec.user_id))
            .filter(ProgressionAccountColumn::SeasonId.eq(season.id))
            .one(&txn)
            .await?;

        let account = match account {
            Some(row) => row,
            None => insert_blank_account(&txn, spec.user_id, season.id, now).await?,
        };

        let expired = multiplier_expired(&account, now);
        let multiplier_decimal = if expired {
            Decimal::ONE
        } else {
            account.xp_multiplier
        };
        let expires_at = if expired {
            None
        } else {
            account.multiplier_expires_at
        };

        let multiplier = multiplier_decimal.to_f64().unwrap_or(1.0);
        let remainder = account.xp_remainder.to_f64().unwrap_or(0.0);
        let (applied, new_remainder) = apply_multiplier(base_amount, multiplier, remainder);
        let new_xp = account.xp.saturating_add(applied).max(0);
        let new_level = level_for_xp(new_xp, curve.base, curve.exponent, curve.max_level);

        let ledger = ProgressionXpLedgerActiveModel {
            user_id: Set(spec.user_id),
            season_id: Set(season.id),
            source: Set(spec.source.as_str().to_string()),
            base_amount: Set(base_amount),
            applied_amount: Set(applied),
            multiplier_at_time: Set(multiplier_decimal),
            idempotency_key: Set(spec.idempotency_key),
            actor_user_id: Set(spec.actor_user_id),
            created_at: Set(now),
            ..Default::default()
        };
        ledger.insert(&txn).await?;

        let mut active: ProgressionAccountActiveModel = account.into();
        active.xp = Set(new_xp);
        active.level = Set(new_level);
        active.xp_remainder = Set(Decimal::from_f64(new_remainder).unwrap_or(Decimal::ZERO));
        active.xp_multiplier = Set(multiplier_decimal);
        active.multiplier_expires_at = Set(expires_at);
        active.updated_at = Set(now);
        if spec.source == XpSource::Message {
            active.last_message_xp_at = Set(Some(now));
        }
        active.update(&txn).await?;

        txn.commit().await?;
        Ok(AwardOutcome::Applied {
            applied,
            level: new_level,
            xp: new_xp,
        })
    }

    /// Reads the singleton settings row, including a short level-threshold preview.
    ///
    /// # Errors
    ///
    /// Missing singleton is an internal error (the migration seeds it).
    pub async fn get_settings(
        &self,
        db: &DatabaseConnection,
    ) -> Result<ProgressionSettingsView, AppError> {
        let settings = load_settings(db).await?;
        Ok(settings_view(&settings))
    }

    /// Partial-updates the singleton settings. Changing the curve recalculates levels
    /// on every account of the flagged-active season (XP is left untouched).
    ///
    /// # Errors
    ///
    /// Validation errors for out-of-range knobs; database errors otherwise.
    pub async fn update_settings(
        &self,
        db: &DatabaseConnection,
        editor_user_id: i64,
        req: &UpdateProgressionSettingsRequest,
    ) -> Result<ProgressionSettingsView, AppError> {
        validate_settings_update(req)?;
        let existing = load_settings(db).await?;
        let curve_changed =
            req.xp_base.is_some() || req.xp_exponent.is_some() || req.max_level.is_some();

        let mut active: ProgressionSettingActiveModel = existing.into();
        if let Some(value) = req.xp_base {
            active.xp_base = Set(value);
        }
        if let Some(value) = req.xp_exponent {
            active.xp_exponent = Set(Decimal::from_f64(value).ok_or_else(|| {
                AppError::Validation("xp_exponent is not a finite number".into())
            })?);
        }
        if let Some(value) = req.max_level {
            active.max_level = Set(value);
        }
        if let Some(value) = req.xp_message {
            active.xp_message = Set(value);
        }
        if let Some(value) = req.xp_event_create {
            active.xp_event_create = Set(value);
        }
        if let Some(value) = req.xp_event_join {
            active.xp_event_join = Set(value);
        }
        if let Some(value) = req.xp_event_complete {
            active.xp_event_complete = Set(value);
        }
        if let Some(value) = req.xp_vod {
            active.xp_vod = Set(value);
        }
        if let Some(value) = req.message_cooldown_secs {
            active.message_cooldown_secs = Set(value);
        }
        if let Some(value) = req.message_min_chars {
            active.message_min_chars = Set(value);
        }
        if let Some(value) = req.warn_threshold {
            active.warn_threshold = Set(value);
        }
        if let Some(value) = &req.vod_forum_channel_id {
            active.vod_forum_channel_id = Set(normalize_optional(value));
        }
        if let Some(list) = &req.message_channel_deny_list {
            let json = serde_json::to_string(list)
                .map_err(|err| AppError::Internal(format!("serialize deny list: {err}")))?;
            active.message_channel_deny_list_json = Set(json);
        }
        active.updated_at = Set(Utc::now().into());
        active.updated_by_user_id = Set(Some(editor_user_id));
        let updated = active.update(db).await?;

        if curve_changed {
            recalc_levels_for_flagged_season(db, &Curve::from_settings(&updated)).await?;
        }

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "PROGRESSION_SETTINGS_SET",
            Some("PROGRESSION_SETTINGS"),
            Some(1),
            Some(editor_user_id),
            Some(serde_json::to_value(req).unwrap_or_else(|_| serde_json::json!({}))),
        )
        .await;

        Ok(settings_view(&updated))
    }

    /// Every season, newest start first.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list_seasons(&self, db: &DatabaseConnection) -> Result<Vec<SeasonView>, AppError> {
        let rows = ProgressionSeasonEntity::find()
            .order_by_desc(ProgressionSeasonColumn::StartsAt)
            .all(db)
            .await?;
        Ok(rows.iter().map(season_view).collect())
    }

    /// Inserts a season. Optionally makes it the only active one.
    ///
    /// # Errors
    ///
    /// Validation if the name is empty or `starts_at >= ends_at`.
    pub async fn create_season(
        &self,
        db: &DatabaseConnection,
        editor_user_id: i64,
        req: &CreateSeasonRequest,
    ) -> Result<SeasonView, AppError> {
        let name = req.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("season name is required".into()));
        }
        let starts_at = parse_rfc3339(&req.starts_at, "starts_at")?;
        let ends_at = parse_rfc3339(&req.ends_at, "ends_at")?;
        if starts_at >= ends_at {
            return Err(AppError::Validation(
                "starts_at must be before ends_at".into(),
            ));
        }
        let activate = req.activate.unwrap_or(false);
        let now: DateTime<FixedOffset> = Utc::now().into();

        let txn = db.begin().await?;
        if activate {
            deactivate_all_seasons(&txn).await?;
        }
        let row = ProgressionSeasonActiveModel {
            name: Set(name.to_string()),
            starts_at: Set(starts_at),
            ends_at: Set(ends_at),
            is_active: Set(activate),
            updated_at: Set(now),
            updated_by_user_id: Set(Some(editor_user_id)),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "PROGRESSION_SEASON_CREATE",
            Some("PROGRESSION_SEASON"),
            Some(row.id),
            Some(editor_user_id),
            Some(serde_json::json!({
                "name": row.name,
                "starts_at": req.starts_at,
                "ends_at": req.ends_at,
                "activate": activate,
            })),
        )
        .await;

        Ok(season_view(&row))
    }

    /// Lengthens, shortens, or renames a season. Dates may move while it is active.
    ///
    /// # Errors
    ///
    /// 404 if unknown; validation if the resulting window is empty.
    pub async fn update_season(
        &self,
        db: &DatabaseConnection,
        editor_user_id: i64,
        season_id: i64,
        req: &UpdateSeasonRequest,
    ) -> Result<SeasonView, AppError> {
        let existing = ProgressionSeasonEntity::find_by_id(season_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("season {season_id} not found")))?;

        let starts_at = match &req.starts_at {
            Some(value) => parse_rfc3339(value, "starts_at")?,
            None => existing.starts_at,
        };
        let ends_at = match &req.ends_at {
            Some(value) => parse_rfc3339(value, "ends_at")?,
            None => existing.ends_at,
        };
        if starts_at >= ends_at {
            return Err(AppError::Validation(
                "starts_at must be before ends_at".into(),
            ));
        }

        let mut active: ProgressionSeasonActiveModel = existing.into();
        if let Some(name) = &req.name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation("season name is required".into()));
            }
            active.name = Set(trimmed.to_string());
        }
        if req.starts_at.is_some() {
            active.starts_at = Set(starts_at);
        }
        if req.ends_at.is_some() {
            active.ends_at = Set(ends_at);
        }
        active.updated_at = Set(Utc::now().into());
        active.updated_by_user_id = Set(Some(editor_user_id));
        let updated = active.update(db).await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "PROGRESSION_SEASON_UPDATE",
            Some("PROGRESSION_SEASON"),
            Some(season_id),
            Some(editor_user_id),
            Some(serde_json::to_value(req).unwrap_or_else(|_| serde_json::json!({}))),
        )
        .await;

        Ok(season_view(&updated))
    }

    /// Makes `season_id` the only active season.
    ///
    /// # Errors
    ///
    /// 404 if unknown.
    pub async fn activate_season(
        &self,
        db: &DatabaseConnection,
        editor_user_id: i64,
        season_id: i64,
    ) -> Result<SeasonView, AppError> {
        let existing = ProgressionSeasonEntity::find_by_id(season_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("season {season_id} not found")))?;

        let txn = db.begin().await?;
        deactivate_all_seasons(&txn).await?;
        let mut active: ProgressionSeasonActiveModel = existing.into();
        active.is_active = Set(true);
        active.updated_at = Set(Utc::now().into());
        active.updated_by_user_id = Set(Some(editor_user_id));
        let updated = active.update(&txn).await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "PROGRESSION_SEASON_ACTIVATE",
            Some("PROGRESSION_SEASON"),
            Some(season_id),
            Some(editor_user_id),
            None,
        )
        .await;

        Ok(season_view(&updated))
    }

    /// Active season covering `now`, if any.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn covering_season(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Option<SeasonView>, AppError> {
        let now = Utc::now().into();
        Ok(find_covering_season(db, now)
            .await?
            .as_ref()
            .map(season_view))
    }

    /// Applies an XP multiplier to the covering-season account, creating the row if needed.
    ///
    /// No-ops when there is no covering season. The value is clamped to `[0, 5]`.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn apply_account_multiplier(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        multiplier: Decimal,
        expires_at: Option<DateTime<FixedOffset>>,
    ) -> Result<(), AppError> {
        let now: DateTime<FixedOffset> = Utc::now().into();
        let Some(season) = find_covering_season(db, now).await? else {
            return Ok(());
        };
        let account = load_or_create_account(db, user_id, season.id, now).await?;
        let mut active: ProgressionAccountActiveModel = account.into();
        active.xp_multiplier = Set(clamp_multiplier(multiplier));
        active.multiplier_expires_at = Set(expires_at);
        active.updated_at = Set(now);
        active.update(db).await?;
        Ok(())
    }

    /// Awards message XP after min-chars / deny-list / cooldown checks.
    ///
    /// Unlinked Discord users are a silent no-op (`reason = "unlinked"`), not an error.
    ///
    /// # Errors
    ///
    /// Database errors from the lookup or award.
    pub async fn award_message(
        &self,
        db: &DatabaseConnection,
        req: &AwardMessageRequest,
    ) -> Result<AwardMessageView, AppError> {
        let discord_id = req.discord_id.trim();
        if discord_id.is_empty() {
            return Ok(skip("unlinked"));
        }
        let user = UserEntity::find()
            .filter(UserColumn::DiscordId.eq(discord_id))
            .one(db)
            .await?;
        let Some(user) = user else {
            return Ok(skip("unlinked"));
        };

        let settings = load_settings(db).await?;
        if req.length < settings.message_min_chars {
            return Ok(skip("too_short"));
        }
        let deny_list: Vec<String> =
            serde_json::from_str(&settings.message_channel_deny_list_json).unwrap_or_default();
        if deny_list.iter().any(|id| id == req.channel_id.trim()) {
            return Ok(skip("denied_channel"));
        }

        let now: DateTime<FixedOffset> = Utc::now().into();
        if let Some(season) = find_covering_season(db, now).await? {
            let key = format!("msg:{}", req.message_id.trim());
            let existing = ProgressionXpLedgerEntity::find()
                .filter(ProgressionXpLedgerColumn::SeasonId.eq(season.id))
                .filter(ProgressionXpLedgerColumn::IdempotencyKey.eq(&key))
                .one(db)
                .await?;
            if existing.is_some() {
                return Ok(skip("duplicate"));
            }

            if let Some(account) = ProgressionAccountEntity::find()
                .filter(ProgressionAccountColumn::UserId.eq(user.id))
                .filter(ProgressionAccountColumn::SeasonId.eq(season.id))
                .one(db)
                .await?
                && let Some(last) = account.last_message_xp_at
            {
                let elapsed = now.signed_duration_since(last);
                if settings.message_cooldown_secs > 0
                    && elapsed < Duration::seconds(i64::from(settings.message_cooldown_secs))
                {
                    return Ok(skip("cooldown"));
                }
            }

            let outcome = self
                .award(
                    db,
                    AwardSpec {
                        user_id: user.id,
                        source: XpSource::Message,
                        base_amount: None,
                        idempotency_key: key,
                        actor_user_id: None,
                    },
                )
                .await?;
            return Ok(message_outcome(outcome));
        }

        Ok(skip("no_season"))
    }

    /// Season XP leaderboard. Defaults to the covering active season; empty if none.
    ///
    /// # Errors
    ///
    /// `404` if `season_id` is given but unknown. Database errors otherwise.
    pub async fn leaderboard(
        &self,
        db: &DatabaseConnection,
        season_id: Option<i64>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<LeaderboardEntryView>, AppError> {
        let season = match season_id {
            Some(id) => Some(
                ProgressionSeasonEntity::find_by_id(id)
                    .one(db)
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("season {id} not found")))?,
            ),
            None => find_covering_season(db, Utc::now().into()).await?,
        };
        let Some(season) = season else {
            return Ok(PaginatedData::new(Vec::new(), 0, 0, 1, pagination.limit()));
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = ProgressionAccountEntity::find()
            .filter(ProgressionAccountColumn::SeasonId.eq(season.id))
            .order_by_desc(ProgressionAccountColumn::Xp)
            .order_by_asc(ProgressionAccountColumn::UserId)
            .paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let rows = paginator.fetch_page(page).await?;
        let user_ids: Vec<i64> = rows.iter().map(|row| row.user_id).collect();
        let names = display_name::resolve_by_ids(db, &user_ids).await?;
        let rank_offset = i64::try_from(page.saturating_mul(limit)).unwrap_or(0);
        let items = rows
            .into_iter()
            .enumerate()
            .map(|(idx, row)| LeaderboardEntryView {
                rank: rank_offset + i64::try_from(idx).unwrap_or(0) + 1,
                user_id: row.user_id,
                username: names
                    .get(&row.user_id)
                    .cloned()
                    .unwrap_or_else(|| "Unknown".into()),
                xp: row.xp,
                level: row.level,
            })
            .collect();
        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Paginated XP ledger for a user in the covering season (or `season_id` if given).
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list_ledger(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        season_id: Option<i64>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<XpLedgerEntryView>, AppError> {
        let season_id = match season_id {
            Some(id) => Some(id),
            None => find_covering_season(db, Utc::now().into())
                .await?
                .map(|season| season.id),
        };
        let Some(season_id) = season_id else {
            return Ok(PaginatedData::new(Vec::new(), 0, 0, 1, pagination.limit()));
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = ProgressionXpLedgerEntity::find()
            .filter(ProgressionXpLedgerColumn::UserId.eq(user_id))
            .filter(ProgressionXpLedgerColumn::SeasonId.eq(season_id))
            .order_by_desc(ProgressionXpLedgerColumn::CreatedAt)
            .order_by_desc(ProgressionXpLedgerColumn::Id)
            .paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let rows = paginator.fetch_page(page).await?;
        Ok(PaginatedData::new(
            rows.iter().map(ledger_view).collect(),
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Officer mutation of XP / level / multiplier on the covering season.
    ///
    /// # Errors
    ///
    /// `400` if `reason` is empty, no mutation field is set, more than one of
    /// `set_xp`/`add_xp`/`set_level` is set, or there is no covering season. `404` if the
    /// target user does not exist.
    pub async fn adjust(
        &self,
        db: &DatabaseConnection,
        actor_user_id: i64,
        target_user_id: i64,
        req: &AdjustProgressionRequest,
    ) -> Result<ProgressionMeView, AppError> {
        let reason = req.reason.trim();
        if reason.is_empty() {
            return Err(AppError::Validation("reason is required".into()));
        }
        let xp_ops = [
            req.set_xp.is_some(),
            req.add_xp.is_some(),
            req.set_level.is_some(),
        ]
        .into_iter()
        .filter(|flag| *flag)
        .count();
        if xp_ops > 1 {
            return Err(AppError::Validation(
                "set_xp, add_xp, and set_level are mutually exclusive".into(),
            ));
        }
        if xp_ops == 0 && req.set_multiplier.is_none() {
            return Err(AppError::Validation(
                "at least one of set_xp, add_xp, set_level, set_multiplier is required".into(),
            ));
        }
        UserEntity::find_by_id(target_user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("user {target_user_id} not found")))?;

        let now: DateTime<FixedOffset> = Utc::now().into();
        let Some(season) = find_covering_season(db, now).await? else {
            return Err(AppError::Validation("no active covering season".into()));
        };
        let settings = load_settings(db).await?;
        let curve = Curve::from_settings(&settings);

        let txn = db.begin().await?;
        let account = load_or_create_account(&txn, target_user_id, season.id, now).await?;
        let old_xp = account.xp;

        let mut multiplier = account.xp_multiplier;
        let mut expires_at = account.multiplier_expires_at;
        if let Some(value) = req.set_multiplier {
            if !value.is_finite() {
                return Err(AppError::Validation(
                    "set_multiplier is not a finite number".into(),
                ));
            }
            let parsed = Decimal::from_f64(value).ok_or_else(|| {
                AppError::Validation("set_multiplier is not a finite number".into())
            })?;
            multiplier = clamp_multiplier(parsed);
            expires_at = match &req.multiplier_expires_at {
                Some(raw) => Some(parse_rfc3339(raw, "multiplier_expires_at")?),
                None => None,
            };
        }

        let new_xp = if let Some(value) = req.set_xp {
            value.max(0)
        } else if let Some(delta) = req.add_xp {
            old_xp.saturating_add(delta).max(0)
        } else if let Some(level) = req.set_level {
            if level < 1 {
                return Err(AppError::Validation("set_level must be >= 1".into()));
            }
            let capped = level.min(curve.max_level);
            threshold(capped, curve.base, curve.exponent)
        } else {
            old_xp
        };
        let new_level = level_for_xp(new_xp, curve.base, curve.exponent, curve.max_level);
        let applied = new_xp - old_xp;

        let ledger = ProgressionXpLedgerActiveModel {
            user_id: Set(target_user_id),
            season_id: Set(season.id),
            source: Set(XpSource::AdminAdjust.as_str().to_string()),
            base_amount: Set(applied),
            applied_amount: Set(applied),
            multiplier_at_time: Set(multiplier),
            idempotency_key: Set(format!("admin_adjust:{target_user_id}:{}", Uuid::new_v4())),
            actor_user_id: Set(Some(actor_user_id)),
            created_at: Set(now),
            ..Default::default()
        };
        ledger.insert(&txn).await?;

        let mut active: ProgressionAccountActiveModel = account.into();
        active.xp = Set(new_xp);
        active.level = Set(new_level);
        active.xp_multiplier = Set(multiplier);
        active.multiplier_expires_at = Set(expires_at);
        active.updated_at = Set(now);
        active.update(&txn).await?;
        txn.commit().await?;

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "PROGRESSION_ADJUST",
            Some("PROGRESSION_ACCOUNT"),
            Some(target_user_id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "target_user_id": target_user_id,
                "season_id": season.id,
                "reason": reason,
                "set_xp": req.set_xp,
                "add_xp": req.add_xp,
                "set_level": req.set_level,
                "set_multiplier": req.set_multiplier,
                "applied": applied,
            })),
        )
        .await;

        self.get_me(db, target_user_id).await
    }
}

struct Curve {
    base: f64,
    exponent: f64,
    max_level: i32,
}

impl Curve {
    fn from_settings(settings: &ProgressionSettingModel) -> Self {
        Self {
            base: f64::from(settings.xp_base),
            exponent: settings.xp_exponent.to_f64().unwrap_or(1.5),
            max_level: settings.max_level.max(1),
        }
    }
}

fn rate_for(settings: &ProgressionSettingModel, source: XpSource) -> i32 {
    match source {
        XpSource::Message => settings.xp_message,
        XpSource::EventCreate => settings.xp_event_create,
        XpSource::EventJoin => settings.xp_event_join,
        XpSource::EventComplete => settings.xp_event_complete,
        XpSource::Vod => settings.xp_vod,
        XpSource::AdminAdjust => 0,
    }
}

async fn load_settings(db: &DatabaseConnection) -> Result<ProgressionSettingModel, AppError> {
    ProgressionSettingEntity::find_by_id(1)
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal("progression_settings singleton missing".into()))
}

async fn find_covering_season(
    db: &DatabaseConnection,
    now: DateTime<FixedOffset>,
) -> Result<Option<ProgressionSeasonModel>, AppError> {
    let row = ProgressionSeasonEntity::find()
        .filter(ProgressionSeasonColumn::IsActive.eq(true))
        .filter(ProgressionSeasonColumn::StartsAt.lte(now))
        .filter(ProgressionSeasonColumn::EndsAt.gte(now))
        .one(db)
        .await?;
    Ok(row)
}

fn season_view(season: &ProgressionSeasonModel) -> SeasonView {
    SeasonView {
        id: season.id,
        name: season.name.clone(),
        starts_at: season.starts_at.to_rfc3339(),
        ends_at: season.ends_at.to_rfc3339(),
        is_active: season.is_active,
    }
}

fn empty_me(lifetime_xp: i64) -> ProgressionMeView {
    ProgressionMeView {
        season: None,
        level: 1,
        xp: 0,
        xp_to_next: 0,
        next_level_at: 0,
        rank: None,
        multiplier: Decimal::ONE,
        lifetime_xp,
    }
}

async fn lifetime_xp(db: &DatabaseConnection, user_id: i64) -> Result<i64, AppError> {
    let rows = ProgressionAccountEntity::find()
        .filter(ProgressionAccountColumn::UserId.eq(user_id))
        .all(db)
        .await?;
    Ok(rows.iter().map(|row| row.xp).sum())
}

async fn rank_for(
    db: &DatabaseConnection,
    season_id: i64,
    user_id: i64,
    xp: i64,
) -> Result<i64, AppError> {
    let ahead = ProgressionAccountEntity::find()
        .filter(ProgressionAccountColumn::SeasonId.eq(season_id))
        .filter(ProgressionAccountColumn::Xp.gt(xp))
        .count(db)
        .await?;
    let tied_lower_id = ProgressionAccountEntity::find()
        .filter(ProgressionAccountColumn::SeasonId.eq(season_id))
        .filter(ProgressionAccountColumn::Xp.eq(xp))
        .filter(ProgressionAccountColumn::UserId.lt(user_id))
        .count(db)
        .await?;
    Ok(i64::try_from(ahead + tied_lower_id).unwrap_or(i64::MAX) + 1)
}

async fn insert_blank_account<C: ConnectionTrait>(
    db: &C,
    user_id: i64,
    season_id: i64,
    now: DateTime<FixedOffset>,
) -> Result<ProgressionAccountModel, AppError> {
    let active = ProgressionAccountActiveModel {
        user_id: Set(user_id),
        season_id: Set(season_id),
        xp: Set(0),
        level: Set(1),
        xp_multiplier: Set(Decimal::ONE),
        xp_remainder: Set(Decimal::ZERO),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    Ok(active.insert(db).await?)
}

async fn load_or_create_account<C: ConnectionTrait>(
    db: &C,
    user_id: i64,
    season_id: i64,
    now: DateTime<FixedOffset>,
) -> Result<ProgressionAccountModel, AppError> {
    let existing = ProgressionAccountEntity::find()
        .filter(ProgressionAccountColumn::UserId.eq(user_id))
        .filter(ProgressionAccountColumn::SeasonId.eq(season_id))
        .one(db)
        .await?;
    match existing {
        Some(row) => Ok(row),
        None => insert_blank_account(db, user_id, season_id, now).await,
    }
}

fn clamp_multiplier(value: Decimal) -> Decimal {
    if value < Decimal::ZERO {
        Decimal::ZERO
    } else if value > Decimal::from(5) {
        Decimal::from(5)
    } else {
        value
    }
}

fn skip(reason: &str) -> AwardMessageView {
    AwardMessageView {
        awarded: false,
        reason: Some(reason.to_string()),
    }
}

fn message_outcome(outcome: AwardOutcome) -> AwardMessageView {
    match outcome {
        AwardOutcome::Applied { .. } => AwardMessageView {
            awarded: true,
            reason: None,
        },
        AwardOutcome::Duplicate => skip("duplicate"),
        AwardOutcome::NoActiveSeason => skip("no_season"),
        AwardOutcome::SkippedRate => skip("skipped_rate"),
    }
}

fn ledger_view(row: &ProgressionXpLedgerModel) -> XpLedgerEntryView {
    XpLedgerEntryView {
        id: row.id,
        user_id: row.user_id,
        season_id: row.season_id,
        source: row.source.clone(),
        base_amount: row.base_amount,
        applied_amount: row.applied_amount,
        multiplier_at_time: row.multiplier_at_time,
        idempotency_key: row.idempotency_key.clone(),
        actor_user_id: row.actor_user_id,
        created_at: row.created_at.to_rfc3339(),
    }
}

fn multiplier_expired(account: &ProgressionAccountModel, now: DateTime<FixedOffset>) -> bool {
    account.multiplier_expires_at.is_some_and(|at| at <= now)
}

fn parse_rfc3339(value: &str, field: &str) -> Result<DateTime<FixedOffset>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| AppError::Validation(format!("{field} must be RFC 3339")))
}

fn normalize_optional(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn validate_settings_update(req: &UpdateProgressionSettingsRequest) -> Result<(), AppError> {
    if let Some(value) = req.xp_base
        && value <= 0
    {
        return Err(AppError::Validation("xp_base must be > 0".into()));
    }
    if let Some(value) = req.xp_exponent
        && !(value.is_finite() && value >= 1.0)
    {
        return Err(AppError::Validation("xp_exponent must be >= 1".into()));
    }
    if let Some(value) = req.max_level
        && value < 1
    {
        return Err(AppError::Validation("max_level must be >= 1".into()));
    }
    for (label, value) in [
        ("xp_message", req.xp_message),
        ("xp_event_create", req.xp_event_create),
        ("xp_event_join", req.xp_event_join),
        ("xp_event_complete", req.xp_event_complete),
        ("xp_vod", req.xp_vod),
        ("message_cooldown_secs", req.message_cooldown_secs),
        ("message_min_chars", req.message_min_chars),
    ] {
        if let Some(value) = value
            && value < 0
        {
            return Err(AppError::Validation(format!("{label} must be >= 0")));
        }
    }
    if let Some(value) = req.warn_threshold
        && value < 1
    {
        return Err(AppError::Validation("warn_threshold must be >= 1".into()));
    }
    Ok(())
}

fn settings_view(settings: &ProgressionSettingModel) -> ProgressionSettingsView {
    let curve = Curve::from_settings(settings);
    let preview_cap = curve.max_level.min(20);
    let level_preview = (2..=preview_cap)
        .map(|level| LevelThresholdView {
            level,
            xp: threshold(level, curve.base, curve.exponent),
        })
        .collect();
    let deny_list = serde_json::from_str(&settings.message_channel_deny_list_json)
        .unwrap_or_else(|_| Vec::new());
    ProgressionSettingsView {
        xp_base: settings.xp_base,
        xp_exponent: settings.xp_exponent,
        max_level: settings.max_level,
        xp_message: settings.xp_message,
        xp_event_create: settings.xp_event_create,
        xp_event_join: settings.xp_event_join,
        xp_event_complete: settings.xp_event_complete,
        xp_vod: settings.xp_vod,
        message_cooldown_secs: settings.message_cooldown_secs,
        message_min_chars: settings.message_min_chars,
        warn_threshold: settings.warn_threshold,
        vod_forum_channel_id: settings.vod_forum_channel_id.clone(),
        message_channel_deny_list: deny_list,
        level_preview,
    }
}

async fn deactivate_all_seasons(txn: &sea_orm::DatabaseTransaction) -> Result<(), AppError> {
    use sea_orm::sea_query::Expr;
    ProgressionSeasonEntity::update_many()
        .col_expr(ProgressionSeasonColumn::IsActive, Expr::value(false))
        .exec(txn)
        .await?;
    Ok(())
}

async fn recalc_levels_for_flagged_season(
    db: &DatabaseConnection,
    curve: &Curve,
) -> Result<(), AppError> {
    let Some(season) = ProgressionSeasonEntity::find()
        .filter(ProgressionSeasonColumn::IsActive.eq(true))
        .one(db)
        .await?
    else {
        return Ok(());
    };
    let accounts = ProgressionAccountEntity::find()
        .filter(ProgressionAccountColumn::SeasonId.eq(season.id))
        .all(db)
        .await?;
    let now: DateTime<FixedOffset> = Utc::now().into();
    for account in accounts {
        let new_level = level_for_xp(account.xp, curve.base, curve.exponent, curve.max_level);
        if new_level == account.level {
            continue;
        }
        let mut active: ProgressionAccountActiveModel = account.into();
        active.level = Set(new_level);
        active.updated_at = Set(now);
        active.update(db).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use chrono::Duration;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        use crate::modules::users::entities::ActiveModel as UserActiveModel;
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user.insert(db).await.expect("insert user").id
    }

    async fn insert_season(
        db: &DatabaseConnection,
        name: &str,
        active: bool,
        start_offset_days: i64,
        end_offset_days: i64,
    ) -> i64 {
        let now = Utc::now();
        let starts: DateTime<FixedOffset> = (now + Duration::days(start_offset_days)).into();
        let ends: DateTime<FixedOffset> = (now + Duration::days(end_offset_days)).into();
        let row = ProgressionSeasonActiveModel {
            name: Set(name.to_string()),
            starts_at: Set(starts),
            ends_at: Set(ends),
            is_active: Set(active),
            updated_at: Set(now.into()),
            ..Default::default()
        };
        row.insert(db).await.expect("insert season").id
    }

    fn spec(user_id: i64, key: &str, amount: i64) -> AwardSpec {
        AwardSpec {
            user_id,
            source: XpSource::Message,
            base_amount: Some(amount),
            idempotency_key: key.to_string(),
            actor_user_id: None,
        }
    }

    #[tokio::test]
    async fn award_is_noop_without_covering_season() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_season(&db, "past", true, -30, -1).await;

        let outcome = ProgressionService::new()
            .award(&db, spec(user_id, "msg:1", 1))
            .await
            .unwrap();
        assert_eq!(outcome, AwardOutcome::NoActiveSeason);

        let me = ProgressionService::new()
            .get_me(&db, user_id)
            .await
            .unwrap();
        assert!(me.season.is_none());
        assert_eq!(me.xp, 0);
        assert_eq!(me.level, 1);
    }

    #[tokio::test]
    async fn award_increments_xp_and_is_idempotent() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;

        let service = ProgressionService::new();
        let first = service
            .award(&db, spec(user_id, "msg:1", 100))
            .await
            .unwrap();
        assert_eq!(
            first,
            AwardOutcome::Applied {
                applied: 100,
                level: 2,
                xp: 100
            }
        );

        let again = service
            .award(&db, spec(user_id, "msg:1", 100))
            .await
            .unwrap();
        assert_eq!(again, AwardOutcome::Duplicate);

        let me = service.get_me(&db, user_id).await.unwrap();
        assert_eq!(me.xp, 100);
        assert_eq!(me.level, 2);
        assert_eq!(me.rank, Some(1));
        assert_eq!(me.lifetime_xp, 100);
        assert_eq!(me.xp_to_next, 183); // L3 threshold 283 - 100
    }

    #[tokio::test]
    async fn half_multiplier_needs_two_one_xp_awards() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        let season_id = insert_season(&db, "s25", true, -1, 30).await;

        let now: DateTime<FixedOffset> = Utc::now().into();
        let account = ProgressionAccountActiveModel {
            user_id: Set(user_id),
            season_id: Set(season_id),
            xp: Set(0),
            level: Set(1),
            xp_multiplier: Set(Decimal::from_f64(0.5).unwrap()),
            xp_remainder: Set(Decimal::ZERO),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        account.insert(&db).await.unwrap();

        let service = ProgressionService::new();
        let first = service.award(&db, spec(user_id, "msg:a", 1)).await.unwrap();
        assert_eq!(
            first,
            AwardOutcome::Applied {
                applied: 0,
                level: 1,
                xp: 0
            }
        );

        let second = service.award(&db, spec(user_id, "msg:b", 1)).await.unwrap();
        assert_eq!(
            second,
            AwardOutcome::Applied {
                applied: 1,
                level: 1,
                xp: 1
            }
        );
    }

    #[tokio::test]
    async fn skipped_when_rate_is_zero() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;

        let outcome = ProgressionService::new()
            .award(&db, spec(user_id, "msg:z", 0))
            .await
            .unwrap();
        assert_eq!(outcome, AwardOutcome::SkippedRate);
    }

    #[tokio::test]
    async fn rank_breaks_ties_by_user_id() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();

        service.award(&db, spec(alice, "a", 50)).await.unwrap();
        service.award(&db, spec(bob, "b", 50)).await.unwrap();

        let alice_me = service.get_me(&db, alice).await.unwrap();
        let bob_me = service.get_me(&db, bob).await.unwrap();
        assert_eq!(alice_me.rank, Some(1));
        assert_eq!(bob_me.rank, Some(2));
    }

    #[tokio::test]
    async fn settings_reject_non_positive_base() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let err = ProgressionService::new()
            .update_settings(
                &db,
                editor,
                &UpdateProgressionSettingsRequest {
                    xp_base: Some(0),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn changing_curve_recalculates_level_keeps_xp() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();
        service
            .award(&db, spec(user_id, "grind", 800))
            .await
            .unwrap();
        let before = service.get_me(&db, user_id).await.unwrap();
        assert_eq!(before.level, 5);
        assert_eq!(before.xp, 800);

        service
            .update_settings(
                &db,
                editor,
                &UpdateProgressionSettingsRequest {
                    xp_exponent: Some(3.0),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let after = service.get_me(&db, user_id).await.unwrap();
        assert_eq!(after.xp, 800);
        assert_eq!(after.level, 3);
    }

    #[tokio::test]
    async fn shortening_season_stops_awards_extending_resumes() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        let season_id = insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();

        assert!(matches!(
            service.award(&db, spec(user_id, "a", 1)).await.unwrap(),
            AwardOutcome::Applied { .. }
        ));

        let past: DateTime<FixedOffset> = (Utc::now() - Duration::hours(1)).into();
        service
            .update_season(
                &db,
                editor,
                season_id,
                &UpdateSeasonRequest {
                    ends_at: Some(past.to_rfc3339()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            service.award(&db, spec(user_id, "b", 1)).await.unwrap(),
            AwardOutcome::NoActiveSeason
        );

        let future: DateTime<FixedOffset> = (Utc::now() + Duration::days(2)).into();
        service
            .update_season(
                &db,
                editor,
                season_id,
                &UpdateSeasonRequest {
                    ends_at: Some(future.to_rfc3339()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            service.award(&db, spec(user_id, "c", 1)).await.unwrap(),
            AwardOutcome::Applied { .. }
        ));
    }

    async fn insert_user_with_discord(
        db: &DatabaseConnection,
        username: &str,
        email: &str,
        discord_id: &str,
    ) -> i64 {
        use crate::modules::users::entities::ActiveModel as UserActiveModel;
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some(discord_id.to_string())),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    fn msg(
        discord_id: &str,
        message_id: &str,
        channel_id: &str,
        length: i32,
    ) -> AwardMessageRequest {
        AwardMessageRequest {
            discord_id: discord_id.to_string(),
            message_id: message_id.to_string(),
            channel_id: channel_id.to_string(),
            length,
        }
    }

    #[tokio::test]
    async fn award_message_unlinked_is_noop() {
        let db = seed_db().await;
        insert_season(&db, "s25", true, -1, 30).await;
        let view = ProgressionService::new()
            .award_message(&db, &msg("no-such", "m1", "c1", 10))
            .await
            .unwrap();
        assert!(!view.awarded);
        assert_eq!(view.reason.as_deref(), Some("unlinked"));
    }

    #[tokio::test]
    async fn award_message_rejects_min_chars() {
        let db = seed_db().await;
        insert_user_with_discord(&db, "alice", "alice@example.com", "d-alice").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let view = ProgressionService::new()
            .award_message(&db, &msg("d-alice", "m1", "c1", 1))
            .await
            .unwrap();
        assert!(!view.awarded);
        assert_eq!(view.reason.as_deref(), Some("too_short"));
    }

    #[tokio::test]
    async fn award_message_respects_deny_list() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        insert_user_with_discord(&db, "alice", "alice@example.com", "d-alice").await;
        insert_season(&db, "s25", true, -1, 30).await;
        ProgressionService::new()
            .update_settings(
                &db,
                editor,
                &UpdateProgressionSettingsRequest {
                    message_channel_deny_list: Some(vec!["denied-chan".into()]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let view = ProgressionService::new()
            .award_message(&db, &msg("d-alice", "m1", "denied-chan", 20))
            .await
            .unwrap();
        assert!(!view.awarded);
        assert_eq!(view.reason.as_deref(), Some("denied_channel"));
    }

    #[tokio::test]
    async fn award_message_cooldown_and_duplicate() {
        let db = seed_db().await;
        let user_id = insert_user_with_discord(&db, "alice", "alice@example.com", "d-alice").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();
        let first = service
            .award_message(&db, &msg("d-alice", "m1", "c1", 20))
            .await
            .unwrap();
        assert!(first.awarded);

        let dup = service
            .award_message(&db, &msg("d-alice", "m1", "c1", 20))
            .await
            .unwrap();
        assert!(!dup.awarded);
        assert_eq!(dup.reason.as_deref(), Some("duplicate"));

        let cooled = service
            .award_message(&db, &msg("d-alice", "m2", "c1", 20))
            .await
            .unwrap();
        assert!(!cooled.awarded);
        assert_eq!(cooled.reason.as_deref(), Some("cooldown"));

        let me = service.get_me(&db, user_id).await.unwrap();
        assert_eq!(me.xp, 1);
    }

    #[tokio::test]
    async fn leaderboard_orders_xp_desc_then_user_id_asc() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let cara = insert_user(&db, "cara", "cara@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();
        service.award(&db, spec(alice, "a", 50)).await.unwrap();
        service.award(&db, spec(bob, "b", 80)).await.unwrap();
        service.award(&db, spec(cara, "c", 50)).await.unwrap();

        let page = service
            .leaderboard(
                &db,
                None,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 3);
        assert_eq!(page.items[0].user_id, bob);
        assert_eq!(page.items[0].rank, 1);
        assert_eq!(page.items[1].user_id, alice);
        assert_eq!(page.items[1].rank, 2);
        assert_eq!(page.items[2].user_id, cara);
        assert_eq!(page.items[2].rank, 3);
    }

    #[tokio::test]
    async fn adjust_clamps_xp_zero_set_level_and_multiplier() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_season(&db, "s25", true, -1, 30).await;
        let service = ProgressionService::new();
        service.award(&db, spec(user_id, "seed", 50)).await.unwrap();

        let clamped = service
            .adjust(
                &db,
                editor,
                user_id,
                &AdjustProgressionRequest {
                    set_xp: None,
                    add_xp: Some(-400),
                    set_level: None,
                    set_multiplier: None,
                    multiplier_expires_at: None,
                    reason: "oops".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(clamped.xp, 0);
        assert_eq!(clamped.level, 1);

        let leveled = service
            .adjust(
                &db,
                editor,
                user_id,
                &AdjustProgressionRequest {
                    set_xp: None,
                    add_xp: None,
                    set_level: Some(5),
                    set_multiplier: None,
                    multiplier_expires_at: None,
                    reason: "boost".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(leveled.xp, 800);
        assert_eq!(leveled.level, 5);

        let high = service
            .adjust(
                &db,
                editor,
                user_id,
                &AdjustProgressionRequest {
                    set_xp: None,
                    add_xp: None,
                    set_level: None,
                    set_multiplier: Some(9.0),
                    multiplier_expires_at: None,
                    reason: "cap".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(high.multiplier, Decimal::from(5));

        let low = service
            .adjust(
                &db,
                editor,
                user_id,
                &AdjustProgressionRequest {
                    set_xp: None,
                    add_xp: None,
                    set_level: None,
                    set_multiplier: Some(-2.0),
                    multiplier_expires_at: None,
                    reason: "floor".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(low.multiplier, Decimal::ZERO);
    }
}
