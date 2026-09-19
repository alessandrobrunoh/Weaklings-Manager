//! Read-only `fight_analytics` service: reshapes the columns
//! `fight_analytics::writer` computed and persisted onto `fights` and
//! `fight_stats` into the small view `GET /api/fight-analytics/{fight_id}`
//! returns.
//!
//! This module does no computation of its own — it only reads what the
//! writer already persisted. See `fight_analytics::mod`'s own doc comment
//! for why the outcome and rollup are recomputed eagerly elsewhere rather
//! than derived here on every read.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::events::entities::fight;

use super::entities::fight_stat;

/// One fight's persisted analytics: its decided outcome, plus the
/// `fight_stats` rollup when one has been computed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FightAnalyticsView {
    /// Canonical fight id.
    pub fight_id: i64,
    /// Serialized `battles::outcome::BattleOutcome` vocabulary
    /// (`"victory"`/`"defeat"`/`"draw"`/`"unknown"`). `"unknown"` for any
    /// fight never recomputed via `fight_analytics::writer`.
    pub outcome: String,
    /// The reason `battles::outcome::combine_segments` produced for
    /// `outcome`. `None` when `outcome` has never been computed.
    pub outcome_method: Option<String>,
    /// RFC 3339. When this fight's analytics were last (re)computed. `None`
    /// means never.
    pub analytics_computed_at: Option<String>,
    /// Whether this fight's analytics need a recompute (see `fights.analytics_stale`).
    pub analytics_stale: bool,
    /// The `fight_stats` rollup. `None` when this fight has never been
    /// recomputed — a real, meaningful "not yet computed" state, not an
    /// error.
    pub stats: Option<FightStatsView>,
}

/// One fight's `fight_stats` rollup, verbatim.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FightStatsView {
    /// Distinct `AlbionBB` battle segments belonging to this fight.
    pub segment_count: i32,
    /// Deduplicated by `player_key` across every segment.
    pub unique_friendly_players: i32,
    /// Same deduplication as `unique_friendly_players`, for the enemy side.
    pub unique_enemy_players: i32,
    pub friendly_kills: i64,
    pub friendly_deaths: i64,
    pub friendly_kill_fame: i64,
    pub enemy_kills: i64,
    pub enemy_deaths: i64,
    pub enemy_kill_fame: i64,
    pub avg_friendly_item_power: f64,
    pub avg_enemy_item_power: f64,
    /// Summed from `battle_loss_estimates` across the fight's segments.
    pub friendly_estimated_loss: i64,
    /// Summed from `battle_loss_estimates` across the fight's segments.
    /// **A trade indicator only** — this codebase's non-negotiable rule (see
    /// `economy::mod`'s doc comment) is that guild income is declared via
    /// `splits`, never inferred from combat. This field must never be
    /// summed into any income/P&L total.
    pub enemy_estimated_loss: i64,
    /// RFC 3339. When this specific rollup was computed.
    pub computed_at: String,
}

/// Reads one fight's persisted analytics view.
///
/// # Errors
///
/// `AppError::NotFound` if `fight_id` does not exist. `stats: None` (not a
/// 404) when the fight exists but has never been recomputed via
/// `fight_analytics::writer`. Database errors otherwise.
pub async fn get_fight_analytics(
    db: &DatabaseConnection,
    fight_id: i64,
) -> Result<FightAnalyticsView, AppError> {
    let fight_model = fight::Entity::find_by_id(fight_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("fight {fight_id} not found")))?;

    let stats_model = fight_stat::Entity::find()
        .filter(fight_stat::Column::FightId.eq(fight_id))
        .one(db)
        .await?;

    Ok(FightAnalyticsView {
        fight_id,
        outcome: fight_model.outcome,
        outcome_method: fight_model.outcome_method,
        analytics_computed_at: fight_model
            .analytics_computed_at
            .map(|when| when.to_rfc3339()),
        analytics_stale: fight_model.analytics_stale,
        stats: stats_model.map(|stats| FightStatsView {
            segment_count: stats.segment_count,
            unique_friendly_players: stats.unique_friendly_players,
            unique_enemy_players: stats.unique_enemy_players,
            friendly_kills: stats.friendly_kills,
            friendly_deaths: stats.friendly_deaths,
            friendly_kill_fame: stats.friendly_kill_fame,
            enemy_kills: stats.enemy_kills,
            enemy_deaths: stats.enemy_deaths,
            enemy_kill_fame: stats.enemy_kill_fame,
            avg_friendly_item_power: stats.avg_friendly_item_power,
            avg_enemy_item_power: stats.avg_enemy_item_power,
            friendly_estimated_loss: stats.friendly_estimated_loss,
            enemy_estimated_loss: stats.enemy_estimated_loss,
            computed_at: stats.computed_at.to_rfc3339(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, Database, Set};

    use crate::modules::events::entities::fight;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    async fn insert_fight(db: &DatabaseConnection) -> i64 {
        let now = Utc::now();
        fight::ActiveModel {
            event_id: Set(None),
            started_at: Set(now.into()),
            ended_at: Set(None),
            grouping_method: Set("automatic".to_string()),
            grouping_confidence: Set(1.0),
            grouping_version: Set("v1".to_string()),
            needs_review: Set(false),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            outcome: Set("unknown".to_string()),
            outcome_method: Set(None),
            analytics_computed_at: Set(None),
            analytics_stale: Set(true),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
        .id
    }

    /// A fight with a computed `fight_stats` row returns the full view.
    #[tokio::test]
    async fn fight_with_stats_returns_full_view() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;
        crate::modules::fight_analytics::writer::recompute_fight_analytics(&db, fight_id)
            .await
            .expect("recompute succeeds with zero segments");

        let view = get_fight_analytics(&db, fight_id)
            .await
            .expect("view returned");

        assert_eq!(view.fight_id, fight_id);
        assert!(view.analytics_computed_at.is_some());
        assert!(!view.analytics_stale);
        let stats = view.stats.expect("stats row was computed");
        assert_eq!(stats.segment_count, 0);
    }

    /// A fight that exists but was never recomputed returns `stats: None`,
    /// not a 404.
    #[tokio::test]
    async fn fight_never_recomputed_returns_none_stats_not_404() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;

        let view = get_fight_analytics(&db, fight_id)
            .await
            .expect("view returned even without stats");

        assert_eq!(view.fight_id, fight_id);
        assert_eq!(view.outcome, "unknown");
        assert!(view.analytics_computed_at.is_none());
        assert!(view.stats.is_none());
    }

    /// An unknown fight id returns `NotFound`.
    #[tokio::test]
    async fn unknown_fight_returns_not_found() {
        let db = seed_db().await;

        let result = get_fight_analytics(&db, 999_999).await;

        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}
