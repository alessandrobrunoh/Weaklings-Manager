//! Persists one canonical Fight's aggregated analytics into `fights.outcome`
//! / `outcome_method` / `analytics_computed_at` / `analytics_stale` and the
//! `fight_stats` rollup.
//!
//! # What triggers a recompute
//!
//! There is no separate async worker or job queue for this (see the parent
//! module's doc comment on staleness-not-a-queue) — this writer is called
//! best-effort, synchronously, from every place that can change a Fight's
//! evidence:
//! - Battle hydration (`battles::service::get_battle_detail_with_losses`),
//!   right after the battle's evidence and loss estimate are persisted, for
//!   whichever fight that battle segment belongs to.
//! - Manual Fight grouping (`fights::merge_fights`/`move_battle`/
//!   `split_fight`), for every fight id each operation affects, once its own
//!   transaction has committed.
//!
//! Every caller treats a failure here as best-effort telemetry: log a
//! warning and move on, never fail the mutation that triggered it. A fight
//! whose recompute never ran, or last failed, simply keeps
//! `analytics_stale = true` (or, for a fight created before this feature
//! existed, an `outcome` that was never computed at all) — that column is
//! the whole observability story for now.
//!
//! # Idiom this matches
//!
//! Same "read the already-persisted evidence tables, compute, then upsert"
//! shape as `economy::writer::persist_battle_loss_estimate`, scaled up to
//! every segment (`battle_id`) belonging to one Fight instead of a single
//! battle. Unlike that writer, this one wraps its reads and writes in a
//! transaction: it touches two tables (`fights` and `fight_stats`) that must
//! land together as one atomic recompute. `fight_stats` is **replaced
//! wholesale** on every recompute, exactly like `battle_loss_estimates` —
//! this is a rebuildable rollup, never an immutable-identity table.
//!
//! Segment evidence is read entirely from the L0 evidence tables
//! (`battle_guild_stats`, `battle_player_stats`, `battle_loss_estimates`) —
//! deliberately never from `guild_battle_snapshots` — so this writer stays
//! self-contained within that normalized layer. In particular, a segment's
//! total fame (needed to classify its outcome) is not stored as its own
//! column anywhere in those tables, so it is derived here as the sum of
//! `kill_fame` across that segment's `battle_guild_stats` rows, both sides
//! combined.
//!
//! As always: `enemy_estimated_loss` / `enemy_kills` / `enemy_kill_fame` are
//! trade/observation figures only. This codebase's non-negotiable rule (see
//! `economy::mod`'s doc comment) is that guild income is declared via
//! `splits`, never inferred from combat — nothing here ever folds an enemy
//! figure into an income total.

use std::collections::HashMap;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::battles::evidence_entities::{battle_guild_stat, battle_player_stat};
use crate::modules::economy::entities::battle_loss_estimate;
use crate::modules::events::entities::{fight, fight_battle};

use super::compute::{self, FightSegment, PlayerAppearance, SegmentGuildLine, SegmentLossEstimate};
use super::entities::fight_stat;

/// Recomputes and persists `fight_id`'s outcome and `fight_stats` rollup from
/// its currently-persisted segment evidence.
///
/// 1. Confirms the fight exists — `NotFound` otherwise, since this is a
///    genuine caller error (an unknown fight id), not a best-effort
///    situation; every caller of this function decides for itself whether to
///    treat that as best-effort.
/// 2. Loads every `fight_battles` segment for `fight_id`. Zero segments is a
///    valid state (a fight with no linked battles yet) — evidence stays
///    empty and [`compute::compute_fight_analytics`] handles that case
///    correctly on its own.
/// 3. Loads `battle_guild_stats` / `battle_player_stats` /
///    `battle_loss_estimates` for those segments' `battle_id`s, one batched
///    `is_in(..)` query each, and reshapes them into `compute`'s plain
///    evidence types. A segment's total fame is derived as the sum of
///    `kill_fame` across its `battle_guild_stats` rows (both sides) rather
///    than read from `guild_battle_snapshots`.
/// 4. Calls [`compute::compute_fight_analytics`], then replaces `fights`'
///    outcome columns and the `fight_stats` row (inserting one if none
///    exists yet) inside one transaction.
///
/// # Errors
///
/// `AppError::NotFound` if `fight_id` does not exist. Database errors
/// otherwise.
///
/// Long by line count rather than by complexity: it is a straight sequence of
/// independent evidence reads (segments, guild stats, player stats, loss
/// estimates) followed by one upsert, each step already documented above —
/// splitting it into helpers would only scatter that sequence, the same
/// tradeoff `evidence_writer::persist_evidence` makes.
#[allow(clippy::too_many_lines)]
pub async fn recompute_fight_analytics(
    db: &DatabaseConnection,
    fight_id: i64,
) -> Result<(), AppError> {
    let txn = db.begin().await?;

    let fight_model = fight::Entity::find_by_id(fight_id)
        .one(&txn)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("fight {fight_id} not found")))?;

    let segment_rows = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(fight_id))
        .all(&txn)
        .await?;
    let battle_ids: Vec<i64> = segment_rows
        .iter()
        .map(|segment| segment.battle_id)
        .collect();

    let guild_rows = if battle_ids.is_empty() {
        Vec::new()
    } else {
        battle_guild_stat::Entity::find()
            .filter(battle_guild_stat::Column::BattleId.is_in(battle_ids.clone()))
            .all(&txn)
            .await?
    };
    let mut guilds_by_battle: HashMap<i64, Vec<battle_guild_stat::Model>> = HashMap::new();
    for row in guild_rows {
        guilds_by_battle.entry(row.battle_id).or_default().push(row);
    }
    let segments: Vec<FightSegment> = battle_ids
        .iter()
        .map(|battle_id| {
            let guild_rows = guilds_by_battle.remove(battle_id).unwrap_or_default();
            // Not stored as its own column anywhere in the normalized L0
            // evidence tables — derived here from both sides' guild rows so
            // this writer stays self-contained within `battle_guild_stats`
            // rather than reaching into `guild_battle_snapshots` for it.
            let total_fame: i64 = guild_rows.iter().map(|guild| guild.kill_fame).sum();
            FightSegment {
                battle_id: *battle_id,
                total_fame,
                guilds: guild_rows
                    .iter()
                    .map(|guild| SegmentGuildLine {
                        is_friendly: guild.is_friendly,
                        kills: i64::from(guild.kills),
                        deaths: i64::from(guild.deaths),
                        kill_fame: guild.kill_fame,
                        winner: guild.winner,
                    })
                    .collect(),
            }
        })
        .collect();

    let player_rows = if battle_ids.is_empty() {
        Vec::new()
    } else {
        battle_player_stat::Entity::find()
            .filter(battle_player_stat::Column::BattleId.is_in(battle_ids.clone()))
            .all(&txn)
            .await?
    };
    let player_appearances: Vec<PlayerAppearance> = player_rows
        .into_iter()
        .map(|player| PlayerAppearance {
            player_key: player.player_key,
            is_friendly: player.is_friendly,
            kills: player.kills,
            deaths: player.deaths,
            kill_fame: player.kill_fame,
            item_power: player.item_power,
        })
        .collect();

    let loss_estimate_rows = if battle_ids.is_empty() {
        Vec::new()
    } else {
        battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.is_in(battle_ids.clone()))
            .all(&txn)
            .await?
    };
    let loss_estimates: Vec<SegmentLossEstimate> = loss_estimate_rows
        .into_iter()
        .map(|estimate| SegmentLossEstimate {
            friendly_estimated_loss: estimate.friendly_estimated_loss,
            enemy_estimated_loss: estimate.enemy_estimated_loss,
        })
        .collect();

    let analytics =
        compute::compute_fight_analytics(&segments, &player_appearances, &loss_estimates);

    let now = Utc::now();
    let mut fight_active: fight::ActiveModel = fight_model.into();
    fight_active.outcome = Set(analytics.outcome.as_str().to_string());
    fight_active.outcome_method = Set(Some(analytics.outcome_method.clone()));
    fight_active.analytics_computed_at = Set(Some(now.into()));
    fight_active.analytics_stale = Set(false);
    fight_active.updated_at = Set(now.into());
    fight_active.update(&txn).await?;

    let existing_stats = fight_stat::Entity::find()
        .filter(fight_stat::Column::FightId.eq(fight_id))
        .one(&txn)
        .await?;

    match existing_stats {
        None => {
            fight_stat::ActiveModel {
                fight_id: Set(fight_id),
                segment_count: Set(analytics.segment_count),
                unique_friendly_players: Set(analytics.unique_friendly_players),
                unique_enemy_players: Set(analytics.unique_enemy_players),
                friendly_kills: Set(analytics.friendly_kills),
                friendly_deaths: Set(analytics.friendly_deaths),
                friendly_kill_fame: Set(analytics.friendly_kill_fame),
                enemy_kills: Set(analytics.enemy_kills),
                enemy_deaths: Set(analytics.enemy_deaths),
                enemy_kill_fame: Set(analytics.enemy_kill_fame),
                avg_friendly_item_power: Set(analytics.avg_friendly_item_power),
                avg_enemy_item_power: Set(analytics.avg_enemy_item_power),
                friendly_estimated_loss: Set(analytics.friendly_estimated_loss),
                enemy_estimated_loss: Set(analytics.enemy_estimated_loss),
                computed_at: Set(now.into()),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }
        Some(existing) => {
            let mut row: fight_stat::ActiveModel = existing.into();
            row.segment_count = Set(analytics.segment_count);
            row.unique_friendly_players = Set(analytics.unique_friendly_players);
            row.unique_enemy_players = Set(analytics.unique_enemy_players);
            row.friendly_kills = Set(analytics.friendly_kills);
            row.friendly_deaths = Set(analytics.friendly_deaths);
            row.friendly_kill_fame = Set(analytics.friendly_kill_fame);
            row.enemy_kills = Set(analytics.enemy_kills);
            row.enemy_deaths = Set(analytics.enemy_deaths);
            row.enemy_kill_fame = Set(analytics.enemy_kill_fame);
            row.avg_friendly_item_power = Set(analytics.avg_friendly_item_power);
            row.avg_enemy_item_power = Set(analytics.avg_enemy_item_power);
            row.friendly_estimated_loss = Set(analytics.friendly_estimated_loss);
            row.enemy_estimated_loss = Set(analytics.enemy_estimated_loss);
            row.computed_at = Set(now.into());
            row.updated_at = Set(now.into());
            row.update(&txn).await?;
        }
    }

    txn.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

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

    async fn link_segment(db: &DatabaseConnection, fight_id: i64, battle_id: i64, sequence: i32) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(sequence),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight_battle");
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_guild_stat(
        db: &DatabaseConnection,
        battle_id: i64,
        guild_id: &str,
        guild_name: &str,
        is_friendly: bool,
        kills: i32,
        deaths: i32,
        kill_fame: i64,
        winner: bool,
    ) {
        battle_guild_stat::ActiveModel {
            battle_id: Set(battle_id),
            guild_id: Set(guild_id.to_string()),
            guild_name: Set(guild_name.to_string()),
            alliance_id: Set(None),
            alliance_name: Set(None),
            is_friendly: Set(is_friendly),
            players: Set(5),
            kills: Set(kills),
            deaths: Set(deaths),
            kill_fame: Set(kill_fame),
            avg_item_power: Set(1000.0),
            winner: Set(winner),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_guild_stat");
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_player_stat(
        db: &DatabaseConnection,
        battle_id: i64,
        player_key: &str,
        is_friendly: bool,
        kills: i32,
        deaths: i32,
        kill_fame: i64,
        item_power: f64,
    ) {
        battle_player_stat::ActiveModel {
            battle_id: Set(battle_id),
            player_key: Set(player_key.to_string()),
            player_id: Set(None),
            player_name: Set(player_key.to_string()),
            identity_source: Set("name_only".to_string()),
            guild_id: Set(if is_friendly {
                "us".to_string()
            } else {
                "them".to_string()
            }),
            guild_name: Set(if is_friendly {
                "Weaklings".to_string()
            } else {
                "Enemy".to_string()
            }),
            alliance_name: Set(None),
            is_friendly: Set(is_friendly),
            kills: Set(kills),
            deaths: Set(deaths),
            kill_fame: Set(kill_fame),
            death_fame: Set(0),
            item_power: Set(item_power),
            main_hand_item_id: Set(None),
            role: Set(None),
            role_confidence: Set(None),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_player_stat");
    }

    async fn insert_loss_estimate(
        db: &DatabaseConnection,
        battle_id: i64,
        friendly_estimated_loss: i64,
        enemy_estimated_loss: i64,
    ) {
        let now = Utc::now();
        battle_loss_estimate::ActiveModel {
            battle_id: Set(battle_id),
            friendly_estimated_loss: Set(friendly_estimated_loss),
            friendly_priced_items: Set(1),
            friendly_total_items: Set(1),
            enemy_estimated_loss: Set(enemy_estimated_loss),
            enemy_priced_items: Set(1),
            enemy_total_items: Set(1),
            pricing_location: Set("Caerleon".to_string()),
            priced_at: Set(now.into()),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_loss_estimate");
    }

    /// A fight with one clearly-decided segment recomputes to `Victory`,
    /// produces one `fight_stats` row matching the evidence, and flips
    /// `analytics_stale` to `false`.
    #[tokio::test]
    async fn single_segment_clear_win_recomputes_outcome_and_stats() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;
        link_segment(&db, fight_id, 100, 0).await;
        insert_guild_stat(&db, 100, "us", "Weaklings", true, 8, 2, 600_000, false).await;
        insert_guild_stat(&db, 100, "them", "Enemy", false, 2, 8, 400_000, false).await;
        insert_player_stat(&db, 100, "id:p1", true, 8, 2, 600_000, 1000.0).await;
        insert_player_stat(&db, 100, "id:e1", false, 2, 8, 400_000, 900.0).await;
        insert_loss_estimate(&db, 100, 50_000, 80_000).await;

        recompute_fight_analytics(&db, fight_id)
            .await
            .expect("recompute succeeds");

        let updated = fight::Entity::find_by_id(fight_id)
            .one(&db)
            .await
            .expect("query")
            .expect("fight exists");
        assert_eq!(updated.outcome, "victory");
        assert!(updated.outcome_method.is_some());
        assert!(updated.analytics_computed_at.is_some());
        assert!(!updated.analytics_stale);

        let stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(fight_id))
            .one(&db)
            .await
            .expect("query")
            .expect("stats row exists");
        assert_eq!(stats.segment_count, 1);
        assert_eq!(stats.unique_friendly_players, 1);
        assert_eq!(stats.unique_enemy_players, 1);
        assert_eq!(stats.friendly_kills, 8);
        assert_eq!(stats.friendly_deaths, 2);
        assert_eq!(stats.friendly_kill_fame, 600_000);
        assert_eq!(stats.friendly_estimated_loss, 50_000);
        assert_eq!(stats.enemy_estimated_loss, 80_000);
    }

    /// A player appearing in two segments of the same fight is deduplicated
    /// by identity (one unique friendly player), while their kills sum
    /// across both segments — a light integration check that the wiring
    /// reaches `compute_fight_analytics` correctly, not a re-test of that
    /// function's own logic.
    #[tokio::test]
    async fn two_segments_dedupe_identity_but_sum_contributions() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;
        link_segment(&db, fight_id, 200, 0).await;
        link_segment(&db, fight_id, 201, 1).await;
        insert_guild_stat(&db, 200, "us", "Weaklings", true, 3, 1, 100_000, false).await;
        insert_guild_stat(&db, 200, "them", "Enemy", false, 1, 3, 50_000, false).await;
        insert_guild_stat(&db, 201, "us", "Weaklings", true, 2, 4, 60_000, false).await;
        insert_guild_stat(&db, 201, "them", "Enemy", false, 4, 2, 90_000, false).await;
        insert_player_stat(&db, 200, "id:p1", true, 3, 1, 100_000, 900.0).await;
        insert_player_stat(&db, 201, "id:p1", true, 2, 4, 50_000, 900.0).await;

        recompute_fight_analytics(&db, fight_id)
            .await
            .expect("recompute succeeds");

        let stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(fight_id))
            .one(&db)
            .await
            .expect("query")
            .expect("stats row exists");
        assert_eq!(stats.segment_count, 2);
        assert_eq!(
            stats.unique_friendly_players, 1,
            "the same player_key across two segments must count as one player"
        );
        assert_eq!(stats.friendly_kills, 5, "3 + 2 kills across both segments");
        assert_eq!(
            stats.friendly_deaths, 5,
            "1 + 4 deaths across both segments"
        );
    }

    /// Recomputing a fight that already has a `fight_stats` row replaces it
    /// in place rather than duplicating it.
    #[tokio::test]
    async fn recompute_replaces_existing_stats_row_instead_of_duplicating() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;
        link_segment(&db, fight_id, 300, 0).await;
        insert_player_stat(&db, 300, "id:p1", true, 1, 0, 10_000, 1000.0).await;

        recompute_fight_analytics(&db, fight_id)
            .await
            .expect("first recompute");
        let first = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(fight_id))
            .one(&db)
            .await
            .expect("query")
            .expect("stats row exists");
        assert_eq!(first.friendly_kills, 1);

        insert_player_stat(&db, 300, "id:p2", true, 4, 0, 40_000, 1000.0).await;
        // A second friendly appearance in the same segment changes the
        // evidence, so the recompute genuinely changes: re-run against
        // battle 300 again.
        recompute_fight_analytics(&db, fight_id)
            .await
            .expect("second recompute");

        let rows = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(fight_id))
            .all(&db)
            .await
            .expect("query");
        assert_eq!(rows.len(), 1, "must replace, not duplicate");
        assert_eq!(rows[0].id, first.id);
        assert_eq!(
            rows[0].friendly_kills, 5,
            "1 + 4 kills after the second player appearance"
        );
    }

    /// A fight with zero linked segments produces a fully-zeroed
    /// `fight_stats` row and an `"unknown"` outcome via `"no_segments"`, not
    /// an error.
    #[tokio::test]
    async fn zero_segments_produces_zeroed_stats_and_no_segments_outcome() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db).await;

        recompute_fight_analytics(&db, fight_id)
            .await
            .expect("recompute succeeds even with no segments");

        let updated = fight::Entity::find_by_id(fight_id)
            .one(&db)
            .await
            .expect("query")
            .expect("fight exists");
        assert_eq!(updated.outcome, "unknown");
        assert_eq!(updated.outcome_method.as_deref(), Some("no_segments"));

        let stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(fight_id))
            .one(&db)
            .await
            .expect("query")
            .expect("stats row exists");
        assert_eq!(stats.segment_count, 0);
        assert_eq!(stats.unique_friendly_players, 0);
        assert_eq!(stats.friendly_kills, 0);
        assert_eq!(stats.enemy_kills, 0);
        assert_eq!(stats.friendly_estimated_loss, 0);
        assert_eq!(stats.enemy_estimated_loss, 0);
    }

    /// Recomputing a nonexistent fight id is a genuine caller error, not a
    /// best-effort situation: it returns `NotFound` rather than silently
    /// doing nothing.
    #[tokio::test]
    async fn recompute_unknown_fight_returns_not_found() {
        let db = seed_db().await;

        let result = recompute_fight_analytics(&db, 999_999).await;

        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}
