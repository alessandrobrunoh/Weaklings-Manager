//! Read-only `attention` service: reads `attention_findings` verbatim into
//! [`AttentionFindingView`].
//!
//! This module does no computation of its own — it only reads what
//! `attention::writer` already persisted. See `attention::mod`'s own doc
//! comment for why the recompute happens synchronously on every read
//! rather than being cached or scheduled here.

use sea_orm::{DatabaseConnection, EntityTrait};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;

use super::entities::attention_finding;

/// One persisted attention finding, verbatim.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AttentionFindingView {
    /// Surrogate primary key.
    pub id: i64,
    /// Stable rule identifier, e.g. `"win_rate_drop"`. Matches one of
    /// `attention::rules`'s function names.
    pub rule_key: String,
    /// The version of the rule's own definition that produced this row.
    pub rule_version: i32,
    /// `"high"` / `"medium"` / `"info"`.
    pub severity: String,
    /// What this finding is about: `"guild"` for a guild-wide rule
    /// (`subject_id` is then `None`), or `"enemy_guild"` for a
    /// per-enemy-guild rule such as `stale_intel`.
    pub subject_type: String,
    /// Polymorphic reference, meaning depends on `subject_type`.
    pub subject_id: Option<i64>,
    /// RFC 3339. Start of the window this finding was evaluated over.
    pub period_start: String,
    /// RFC 3339. End of the window this finding was evaluated over.
    pub period_end: String,
    /// The rule's primary metric, in whatever unit that rule uses.
    pub metric_value: f64,
    /// The comparison value for a period-over-period rule. `None` for a
    /// threshold-only rule.
    pub baseline_value: Option<f64>,
    /// The sample size the rule's minimum-sample gate was evaluated
    /// against.
    pub sample_size: i32,
    /// Parsed back from `evidence_json` — a raw JSON value, not a String,
    /// so API consumers get real JSON rather than a JSON-encoded string.
    pub evidence: serde_json::Value,
    /// RFC 3339. When this specific finding was computed.
    pub computed_at: String,
}

impl AttentionFindingView {
    /// Reshapes one persisted row into its API view, parsing
    /// `evidence_json` back into a `serde_json::Value`.
    ///
    /// # Errors
    ///
    /// `AppError::Internal` if `evidence_json` is not valid JSON — this
    /// should never happen since `attention::writer` always writes valid
    /// JSON produced by `attention::rules`, but a parse failure here is our
    /// own invariant being violated, not a caller error, so it is handled
    /// defensively rather than left to panic.
    fn from_model(model: attention_finding::Model) -> Result<Self, AppError> {
        let evidence = serde_json::from_str(&model.evidence_json).map_err(|err| {
            AppError::Internal(format!(
                "attention_findings row {} has invalid evidence_json: {err}",
                model.id
            ))
        })?;
        Ok(Self {
            id: model.id,
            rule_key: model.rule_key,
            rule_version: model.rule_version,
            severity: model.severity,
            subject_type: model.subject_type,
            subject_id: model.subject_id,
            period_start: model.period_start.to_rfc3339(),
            period_end: model.period_end.to_rfc3339(),
            metric_value: model.metric_value,
            baseline_value: model.baseline_value,
            sample_size: model.sample_size,
            evidence,
            computed_at: model.computed_at.to_rfc3339(),
        })
    }
}

/// `severity`'s sort rank for [`list_attention_findings`]'s ordering: high
/// first, then medium, then info (and anything unrecognized last, rather
/// than panicking on a value that should never occur).
fn severity_rank(severity: &str) -> u8 {
    match severity {
        "high" => 0,
        "medium" => 1,
        "info" => 2,
        _ => 3,
    }
}

/// Lists every currently-held attention finding, ordered by severity (high,
/// then medium, then info) and, within the same severity, most recently
/// computed first.
///
/// # Errors
///
/// Database errors, or `AppError::Internal` if a persisted row's
/// `evidence_json` fails to parse (see [`AttentionFindingView::from_model`]).
pub async fn list_attention_findings(
    db: &DatabaseConnection,
) -> Result<Vec<AttentionFindingView>, AppError> {
    let rows = attention_finding::Entity::find().all(db).await?;
    let mut views = rows
        .into_iter()
        .map(AttentionFindingView::from_model)
        .collect::<Result<Vec<_>, _>>()?;
    views.sort_by(|a, b| {
        severity_rank(&a.severity)
            .cmp(&severity_rank(&b.severity))
            .then_with(|| b.computed_at.cmp(&a.computed_at))
    });
    Ok(views)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, Database, Set};
    use serde_json::json;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_row(
        db: &DatabaseConnection,
        rule_key: &str,
        severity: &str,
        computed_at: chrono::DateTime<Utc>,
        evidence: serde_json::Value,
    ) {
        attention_finding::ActiveModel {
            rule_key: Set(rule_key.to_string()),
            rule_version: Set(1),
            severity: Set(severity.to_string()),
            subject_type: Set("guild".to_string()),
            subject_id: Set(None),
            period_start: Set((computed_at - chrono::Duration::days(30)).into()),
            period_end: Set(computed_at.into()),
            metric_value: Set(42.0),
            baseline_value: Set(Some(50.0)),
            sample_size: Set(20),
            evidence_json: Set(evidence.to_string()),
            computed_at: Set(computed_at.into()),
            created_at: Set(computed_at.into()),
            updated_at: Set(computed_at.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert attention_finding");
    }

    #[tokio::test]
    async fn empty_database_returns_empty_list() {
        let db = seed_db().await;

        let views = list_attention_findings(&db).await.expect("list succeeds");

        assert!(views.is_empty());
    }

    #[tokio::test]
    async fn returns_rows_ordered_by_severity_then_recency() {
        let db = seed_db().await;
        let now = Utc::now();

        insert_row(&db, "attribution_gap", "info", now, json!({"a": 1})).await;
        insert_row(
            &db,
            "win_rate_drop",
            "high",
            now - chrono::Duration::hours(1),
            json!({"drop_points": 25}),
        )
        .await;
        insert_row(&db, "trade_worsening", "medium", now, json!({"b": 2})).await;
        // A second high-severity row, more recently computed than the first
        // one, must sort ahead of it within the same severity band.
        insert_row(
            &db,
            "ip_deficit",
            "high",
            now,
            json!({"avg_ip_delta": -120.0}),
        )
        .await;

        let views = list_attention_findings(&db).await.expect("list succeeds");

        assert_eq!(views.len(), 4);
        assert_eq!(views[0].rule_key, "ip_deficit");
        assert_eq!(views[1].rule_key, "win_rate_drop");
        assert_eq!(views[2].rule_key, "trade_worsening");
        assert_eq!(views[3].rule_key, "attribution_gap");
        assert_eq!(views[1].evidence, json!({"drop_points": 25}));
        assert_eq!(views[1].baseline_value, Some(50.0));
    }
}
