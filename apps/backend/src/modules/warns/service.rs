//! Warn register: issue, list, revoke, and threshold escalations.

use std::str::FromStr;

use chrono::{DateTime, FixedOffset, Utc};
use rust_decimal::prelude::FromPrimitive;
use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder,
};

use crate::errors::AppError;
use crate::modules::audit::service::AuditService;
use crate::modules::progression::service::ProgressionService;
use crate::modules::users::entities::Entity as UserEntity;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{
    UserWarnActiveModel, UserWarnColumn, UserWarnEntity, UserWarnModel, WarnEscalationActiveModel,
    WarnEscalationColumn, WarnEscalationEntity, WarnEscalationModel,
};
use super::models::{IssueWarnRequest, WarnEscalationView, WarnFilters, WarnView};
use super::status::WarnSeverity;

/// Reason stamped when a revoke drops the active count under the threshold.
const CLOSED_REVOKED_UNDER_THRESHOLD: &str = "revoked_under_threshold";

/// Stateless warn operations.
pub struct WarnService;

impl Default for WarnService {
    fn default() -> Self {
        Self
    }
}

impl WarnService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Issues a warn, optionally applies an XP multiplier, and opens an escalation at threshold.
    ///
    /// # Errors
    ///
    /// `400` on empty reason / invalid multiplier; `404` if the target user does not exist.
    pub async fn issue(
        &self,
        db: &DatabaseConnection,
        issuer_user_id: i64,
        req: &IssueWarnRequest,
    ) -> Result<WarnView, AppError> {
        let reason = req.reason.trim();
        if reason.is_empty() {
            return Err(AppError::Validation("reason is required".into()));
        }
        UserEntity::find_by_id(req.user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("user {} not found", req.user_id)))?;

        let severity = req.severity.unwrap_or_default();
        let multiplier = match req.multiplier {
            Some(value) => Some(parse_multiplier(value)?),
            None => None,
        };
        let multiplier_expires_at = match &req.multiplier_expires_at {
            Some(value) => Some(parse_rfc3339(value, "multiplier_expires_at")?),
            None => None,
        };
        let now: DateTime<FixedOffset> = Utc::now().into();

        let row = UserWarnActiveModel {
            user_id: Set(req.user_id),
            issued_by_user_id: Set(issuer_user_id),
            reason: Set(reason.to_string()),
            severity: Set(severity.as_str().to_string()),
            multiplier: Set(multiplier),
            multiplier_expires_at: Set(multiplier_expires_at),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await?;

        if let Some(mult) = multiplier
            && let Err(error) = ProgressionService::new()
                .apply_account_multiplier(db, req.user_id, mult, multiplier_expires_at)
                .await
        {
            tracing::warn!(
                user_id = req.user_id,
                error = %error,
                "failed to apply warn XP multiplier"
            );
        }

        let count = active_warn_count(db, req.user_id).await?;
        let settings = ProgressionService::new().get_settings(db).await?;
        if count >= settings.warn_threshold {
            maybe_open_escalation(db, req.user_id, settings.warn_threshold, count, now).await?;
        }

        let _ = AuditService::log(
            db,
            "WARN_ISSUE",
            Some("USER_WARN"),
            Some(row.id),
            Some(issuer_user_id),
            Some(serde_json::json!({
                "target_user_id": req.user_id,
                "reason": reason,
                "severity": severity.as_str(),
                "active_count": count,
            })),
        )
        .await;

        Ok(warn_view(&row, None, None))
    }

    /// Lists warns (including revoked unless filtered), newest first by default.
    ///
    /// # Errors
    ///
    /// `400` for an unknown `sort` column; database errors otherwise.
    pub async fn list(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &WarnFilters,
    ) -> Result<PaginatedData<WarnView>, AppError> {
        let mut query = UserWarnEntity::find();
        if let Some(user_id) = filters.user_id {
            query = query.filter(UserWarnColumn::UserId.eq(user_id));
        }
        if let Some(severity) = filters.severity {
            query = query.filter(UserWarnColumn::Severity.eq(severity.as_str()));
        }
        match filters.revoked {
            Some(true) => {
                query = query.filter(UserWarnColumn::RevokedAt.is_not_null());
            }
            Some(false) => {
                query = query.filter(UserWarnColumn::RevokedAt.is_null());
            }
            None => {}
        }
        if let Some(search) = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let pattern = format!("%{}%", search.to_lowercase());
            query = query
                .filter(Expr::expr(Func::lower(Expr::col(UserWarnColumn::Reason))).like(pattern));
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("created_at", UserWarnColumn::CreatedAt),
                ("severity", UserWarnColumn::Severity),
                ("reason", UserWarnColumn::Reason),
            ],
            UserWarnColumn::CreatedAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(UserWarnColumn::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(UserWarnColumn::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;
        let names = warn_names(db, &models).await?;
        Ok(PaginatedData::new(
            models
                .iter()
                .map(|row| {
                    warn_view(
                        row,
                        names.get(&row.user_id).cloned(),
                        names.get(&row.issued_by_user_id).cloned(),
                    )
                })
                .collect(),
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Soft-revokes a warn. If the active count drops below threshold, closes an unacked escalation.
    ///
    /// # Errors
    ///
    /// `404` if unknown; `409` if already revoked.
    pub async fn revoke(
        &self,
        db: &DatabaseConnection,
        actor_user_id: i64,
        warn_id: i64,
    ) -> Result<WarnView, AppError> {
        let existing = UserWarnEntity::find_by_id(warn_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("warn {warn_id} not found")))?;
        if existing.revoked_at.is_some() {
            return Err(AppError::Conflict(format!(
                "warn {warn_id} is already revoked"
            )));
        }

        let now: DateTime<FixedOffset> = Utc::now().into();
        let user_id = existing.user_id;
        let mut active: UserWarnActiveModel = existing.into();
        active.revoked_at = Set(Some(now));
        active.revoked_by = Set(Some(actor_user_id));
        let updated = active.update(db).await?;

        let count = active_warn_count(db, user_id).await?;
        let settings = ProgressionService::new().get_settings(db).await?;
        if count < settings.warn_threshold {
            close_open_escalation(db, user_id, CLOSED_REVOKED_UNDER_THRESHOLD).await?;
        }

        let _ = AuditService::log(
            db,
            "WARN_REVOKE",
            Some("USER_WARN"),
            Some(warn_id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "target_user_id": user_id,
                "active_count": count,
            })),
        )
        .await;

        Ok(warn_view(&updated, None, None))
    }

    /// Lists escalations, optionally only still-open ones.
    ///
    /// # Errors
    ///
    /// `400` for an unknown `sort` column; database errors otherwise.
    pub async fn list_escalations(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        open_only: bool,
        sort: Option<&str>,
        order: Option<&str>,
    ) -> Result<PaginatedData<WarnEscalationView>, AppError> {
        let mut query = WarnEscalationEntity::find();
        if open_only {
            query = query
                .filter(WarnEscalationColumn::AcknowledgedAt.is_null())
                .filter(WarnEscalationColumn::ClosedReason.is_null());
        }
        let sort_column = resolve_sort_key(
            sort,
            &[
                ("opened_at", WarnEscalationColumn::OpenedAt),
                ("warn_count_at_time", WarnEscalationColumn::WarnCountAtTime),
                ("threshold_at_time", WarnEscalationColumn::ThresholdAtTime),
            ],
            WarnEscalationColumn::OpenedAt,
        )?;
        let order = SortOrder::from_query(order);
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(WarnEscalationColumn::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(WarnEscalationColumn::Id),
        };
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;
        let user_ids: Vec<i64> = models.iter().map(|row| row.user_id).collect();
        let names = crate::modules::users::display_name::resolve_by_ids(db, &user_ids).await?;
        Ok(PaginatedData::new(
            models
                .iter()
                .map(|row| escalation_view(row, names.get(&row.user_id).cloned()))
                .collect(),
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Marks an escalation as handled by an officer.
    ///
    /// # Errors
    ///
    /// `404` if unknown; `409` if already acknowledged.
    pub async fn acknowledge_escalation(
        &self,
        db: &DatabaseConnection,
        actor_user_id: i64,
        escalation_id: i64,
    ) -> Result<WarnEscalationView, AppError> {
        let existing = WarnEscalationEntity::find_by_id(escalation_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("escalation {escalation_id} not found")))?;
        if existing.acknowledged_at.is_some() {
            return Err(AppError::Conflict(format!(
                "escalation {escalation_id} is already acknowledged"
            )));
        }
        let now: DateTime<FixedOffset> = Utc::now().into();
        let mut active: WarnEscalationActiveModel = existing.into();
        active.acknowledged_at = Set(Some(now));
        active.acknowledged_by = Set(Some(actor_user_id));
        let updated = active.update(db).await?;

        let _ = AuditService::log(
            db,
            "WARN_ESCALATION_ACK",
            Some("WARN_ESCALATION"),
            Some(escalation_id),
            Some(actor_user_id),
            Some(serde_json::json!({ "target_user_id": updated.user_id })),
        )
        .await;

        Ok(escalation_view(&updated, None))
    }
}

fn parse_multiplier(value: f64) -> Result<Decimal, AppError> {
    if !value.is_finite() {
        return Err(AppError::Validation(
            "multiplier is not a finite number".into(),
        ));
    }
    let parsed = Decimal::from_f64(value)
        .ok_or_else(|| AppError::Validation("multiplier is not a finite number".into()))?;
    Ok(clamp_multiplier(parsed))
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

fn parse_rfc3339(value: &str, field: &str) -> Result<DateTime<FixedOffset>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| AppError::Validation(format!("{field} must be RFC 3339")))
}

async fn active_warn_count(db: &DatabaseConnection, user_id: i64) -> Result<i32, AppError> {
    let count = UserWarnEntity::find()
        .filter(UserWarnColumn::UserId.eq(user_id))
        .filter(UserWarnColumn::RevokedAt.is_null())
        .count(db)
        .await?;
    Ok(i32::try_from(count).unwrap_or(i32::MAX))
}

async fn open_escalation(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Option<WarnEscalationModel>, AppError> {
    let row = WarnEscalationEntity::find()
        .filter(WarnEscalationColumn::UserId.eq(user_id))
        .filter(WarnEscalationColumn::AcknowledgedAt.is_null())
        .filter(WarnEscalationColumn::ClosedReason.is_null())
        .one(db)
        .await?;
    Ok(row)
}

async fn maybe_open_escalation(
    db: &DatabaseConnection,
    user_id: i64,
    threshold: i32,
    count: i32,
    now: DateTime<FixedOffset>,
) -> Result<(), AppError> {
    if open_escalation(db, user_id).await?.is_some() {
        return Ok(());
    }
    let row = WarnEscalationActiveModel {
        user_id: Set(user_id),
        threshold_at_time: Set(threshold),
        warn_count_at_time: Set(count),
        opened_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await?;
    let _ = AuditService::log(
        db,
        "WARN_ESCALATION_OPEN",
        Some("WARN_ESCALATION"),
        Some(row.id),
        None,
        Some(serde_json::json!({
            "target_user_id": user_id,
            "threshold": threshold,
            "warn_count": count,
        })),
    )
    .await;
    Ok(())
}

async fn close_open_escalation(
    db: &DatabaseConnection,
    user_id: i64,
    reason: &str,
) -> Result<(), AppError> {
    let Some(existing) = open_escalation(db, user_id).await? else {
        return Ok(());
    };
    let mut active: WarnEscalationActiveModel = existing.into();
    active.closed_reason = Set(Some(reason.to_string()));
    active.update(db).await?;
    Ok(())
}

async fn warn_names(
    db: &DatabaseConnection,
    rows: &[UserWarnModel],
) -> Result<std::collections::HashMap<i64, String>, AppError> {
    let mut user_ids: Vec<i64> = Vec::with_capacity(rows.len() * 2);
    for row in rows {
        user_ids.push(row.user_id);
        user_ids.push(row.issued_by_user_id);
    }
    crate::modules::users::display_name::resolve_by_ids(db, &user_ids).await
}

fn warn_view(
    row: &UserWarnModel,
    username: Option<String>,
    issued_by_username: Option<String>,
) -> WarnView {
    WarnView {
        id: row.id,
        user_id: row.user_id,
        username,
        issued_by_user_id: row.issued_by_user_id,
        issued_by_username,
        reason: row.reason.clone(),
        severity: WarnSeverity::from_str(&row.severity).unwrap_or(WarnSeverity::Warn),
        multiplier: row.multiplier,
        multiplier_expires_at: row.multiplier_expires_at.map(|at| at.to_rfc3339()),
        revoked_at: row.revoked_at.map(|at| at.to_rfc3339()),
        revoked_by: row.revoked_by,
        created_at: row.created_at.to_rfc3339(),
    }
}

fn escalation_view(row: &WarnEscalationModel, username: Option<String>) -> WarnEscalationView {
    WarnEscalationView {
        id: row.id,
        user_id: row.user_id,
        username,
        threshold_at_time: row.threshold_at_time,
        warn_count_at_time: row.warn_count_at_time,
        opened_at: row.opened_at.to_rfc3339(),
        acknowledged_at: row.acknowledged_at.map(|at| at.to_rfc3339()),
        acknowledged_by: row.acknowledged_by,
        closed_reason: row.closed_reason.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::audit::entities::{Column as AuditColumn, Entity as AuditEntity};
    use crate::modules::progression::entities::{
        ProgressionAccountColumn, ProgressionAccountEntity, ProgressionSeasonActiveModel,
    };
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
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
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    async fn insert_covering_season(db: &DatabaseConnection) {
        let now = Utc::now();
        ProgressionSeasonActiveModel {
            name: Set("s25".into()),
            starts_at: Set((now - Duration::days(1)).into()),
            ends_at: Set((now + Duration::days(30)).into()),
            is_active: Set(true),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("season");
    }

    fn issue_req(user_id: i64, reason: &str) -> IssueWarnRequest {
        IssueWarnRequest {
            user_id,
            reason: reason.to_string(),
            severity: None,
            multiplier: None,
            multiplier_expires_at: None,
        }
    }

    #[tokio::test]
    async fn count_only_non_revoked_and_threshold_opens_one_escalation() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let target = insert_user(&db, "target", "target@example.com").await;
        insert_covering_season(&db).await;
        let service = WarnService::new();

        let w1 = service
            .issue(&db, officer, &issue_req(target, "one"))
            .await
            .unwrap();
        let w2 = service
            .issue(&db, officer, &issue_req(target, "two"))
            .await
            .unwrap();
        let open_before = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                true,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(open_before.total_items, 0);

        service
            .issue(&db, officer, &issue_req(target, "three"))
            .await
            .unwrap();
        let open_at = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                true,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(open_at.total_items, 1);
        assert_eq!(open_at.items[0].warn_count_at_time, 3);

        service
            .issue(&db, officer, &issue_req(target, "four"))
            .await
            .unwrap();
        let still_one = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                true,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(still_one.total_items, 1);

        service.revoke(&db, officer, w1.id).await.unwrap();
        // 4 issued, 1 revoked → 3 active, still at threshold, escalation stays open
        let still_open = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                true,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(still_open.total_items, 1);

        // revoke one more → 2 active < 3, close
        service.revoke(&db, officer, w2.id).await.unwrap();

        let open_after = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                true,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(open_after.total_items, 0);

        let all_esc = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                false,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(all_esc.total_items, 1);
        assert_eq!(
            all_esc.items[0].closed_reason.as_deref(),
            Some(CLOSED_REVOKED_UNDER_THRESHOLD)
        );
    }

    #[tokio::test]
    async fn extra_warn_does_not_open_another_escalation() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let target = insert_user(&db, "target", "target@example.com").await;
        let service = WarnService::new();
        for reason in ["a", "b", "c", "d"] {
            service
                .issue(&db, officer, &issue_req(target, reason))
                .await
                .unwrap();
        }
        let all = service
            .list_escalations(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                false,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(all.total_items, 1);
    }

    #[tokio::test]
    async fn audit_paths_for_issue_and_revoke() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let target = insert_user(&db, "target", "target@example.com").await;
        let service = WarnService::new();
        let warn = service
            .issue(&db, officer, &issue_req(target, "late"))
            .await
            .unwrap();
        service.revoke(&db, officer, warn.id).await.unwrap();

        let logs = AuditEntity::find()
            .filter(AuditColumn::Action.is_in(["WARN_ISSUE", "WARN_REVOKE"]))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(logs.len(), 2);
    }

    #[tokio::test]
    async fn warn_multiplier_writes_covering_season_account() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let target = insert_user(&db, "target", "target@example.com").await;
        insert_covering_season(&db).await;
        WarnService::new()
            .issue(
                &db,
                officer,
                &IssueWarnRequest {
                    user_id: target,
                    reason: "farm".into(),
                    severity: Some(WarnSeverity::Strike),
                    multiplier: Some(0.5),
                    multiplier_expires_at: None,
                },
            )
            .await
            .unwrap();

        let account = ProgressionAccountEntity::find()
            .filter(ProgressionAccountColumn::UserId.eq(target))
            .one(&db)
            .await
            .unwrap()
            .expect("account");
        assert_eq!(account.xp_multiplier, Decimal::from_f64(0.5).unwrap());
    }

    #[tokio::test]
    async fn list_warns_sorts_by_reason_and_rejects_unknown_column() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let target = insert_user(&db, "target", "target@example.com").await;
        let service = WarnService::new();
        service
            .issue(&db, officer, &issue_req(target, "zebra"))
            .await
            .unwrap();
        service
            .issue(&db, officer, &issue_req(target, "alpha"))
            .await
            .unwrap();

        let sorted = service
            .list(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                &WarnFilters {
                    sort: Some("reason".into()),
                    order: Some("asc".into()),
                    ..WarnFilters::default()
                },
            )
            .await
            .unwrap();
        let reasons: Vec<_> = sorted.items.iter().map(|row| row.reason.as_str()).collect();
        assert_eq!(reasons, vec!["alpha", "zebra"]);
        assert_eq!(sorted.items[0].username.as_deref(), Some("target"));

        let error = service
            .list(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(20),
                },
                &WarnFilters {
                    sort: Some("fame".into()),
                    ..WarnFilters::default()
                },
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }
}
