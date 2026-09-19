//! Owns every SQL query behind `attention::rules`, and replaces
//! `attention_findings` wholesale per rule on each recompute.
//!
//! # Idiom this matches
//!
//! Same "read the already-persisted evidence tables, compute, then
//! replace-wholesale" shape as `fight_analytics::writer` and
//! `enemies::writer::persist_enemy_facts` — evidence is fetched in a small
//! number of batched queries (never per-row), reshaped into `attention::rules`'
//! plain input types, and every rule's row(s) are deleted then re-inserted
//! inside one transaction so a recompute either fully replaces every rule's
//! findings or (on error) changes nothing.
//!
//! Fights across the combined 60-day window (`[now - 60d, now)`) are fetched
//! once and partitioned in Rust into the current/previous 30-day windows —
//! the same "one windowed query, split by `started_at` afterwards" idiom
//! `fights::get_fight_trends` already uses — rather than issuing separate
//! queries per window.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait,
    FromQueryResult, QueryFilter, QuerySelect, Set, TransactionTrait, sea_query::Expr,
};

use crate::modules::economy::entities::battle_loss_estimate;
use crate::modules::enemies::entities::{enemy_guild, enemy_player_battle};
use crate::modules::events::entities::{fight, fight_battle};
use crate::modules::fight_analytics::entities::fight_stat;

use super::entities::attention_finding;
use super::rules::{self, Finding};

/// Recomputes every attention finding and replaces `attention_findings`
/// wholesale per rule. Returns the number of rows persisted by this
/// recompute (across every rule, including every `stale_intel` subject
/// row).
#[allow(
    clippy::too_many_lines,
    reason = "a sequential pipeline evaluating six independent rules in one transaction; each rule's real logic lives in attention::rules, this is orchestration only"
)]
pub async fn recompute_attention_findings(
    db: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<usize, DbErr> {
    let current_start = now - Duration::days(30);
    let previous_start = current_start - Duration::days(30);

    // --- Fights: one windowed query covering both periods, split in Rust. ---
    let window_fights = fight::Entity::find()
        .filter(fight::Column::StartedAt.gte(previous_start))
        .filter(fight::Column::StartedAt.lt(now))
        .all(db)
        .await?;
    let (current_fights, previous_fights): (Vec<&fight::Model>, Vec<&fight::Model>) = window_fights
        .iter()
        .partition(|f| f.started_at.with_timezone(&Utc) >= current_start);

    let current_fight_ids: Vec<i64> = current_fights.iter().map(|f| f.id).collect();
    let previous_fight_ids: Vec<i64> = previous_fights.iter().map(|f| f.id).collect();
    let all_fight_ids: Vec<i64> = window_fights.iter().map(|f| f.id).collect();

    // --- fight_stats for every fight in the combined window, in one batched query. ---
    let stats_rows = if all_fight_ids.is_empty() {
        Vec::new()
    } else {
        fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.is_in(all_fight_ids))
            .all(db)
            .await?
    };
    let stats_by_fight: HashMap<i64, fight_stat::Model> = stats_rows
        .into_iter()
        .map(|row| (row.fight_id, row))
        .collect();

    // --- win_rate_drop ---
    let win_rate_drop_finding = rules::evaluate_win_rate_drop(
        period_outcomes(&current_fights),
        period_outcomes(&previous_fights),
        current_start,
        now,
    );

    // --- trade_worsening ---
    let trade_worsening_finding = rules::evaluate_trade_worsening(
        period_trade(&current_fight_ids, &stats_by_fight),
        period_trade(&previous_fight_ids, &stats_by_fight),
        current_start,
        now,
    );

    // --- ip_deficit: current window only. ---
    let ip_samples: Vec<rules::FightIpSample> = current_fight_ids
        .iter()
        .filter_map(|id| stats_by_fight.get(id))
        .map(|stat| rules::FightIpSample {
            avg_friendly_item_power: stat.avg_friendly_item_power,
            avg_enemy_item_power: stat.avg_enemy_item_power,
        })
        .collect();
    let ip_deficit_finding = rules::evaluate_ip_deficit(&ip_samples, current_start, now);

    // --- unpriced_losses: current window's fights -> their battle segments
    // -> those battles' loss estimates. `fight_battles.battle_id` is unique
    // table-wide, so summing across it never double counts. ---
    let segment_rows = if current_fight_ids.is_empty() {
        Vec::new()
    } else {
        fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.is_in(current_fight_ids.clone()))
            .all(db)
            .await?
    };
    let battle_ids: Vec<i64> = segment_rows.iter().map(|row| row.battle_id).collect();
    let loss_estimate_rows = if battle_ids.is_empty() {
        Vec::new()
    } else {
        battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.is_in(battle_ids))
            .all(db)
            .await?
    };
    let (friendly_priced_items, friendly_total_items) =
        loss_estimate_rows
            .iter()
            .fold((0i32, 0i32), |(priced, total), row| {
                (
                    priced + row.friendly_priced_items,
                    total + row.friendly_total_items,
                )
            });
    let unpriced_losses_finding = rules::evaluate_unpriced_losses(
        friendly_priced_items,
        friendly_total_items,
        current_start,
        now,
    );

    // --- attribution_gap: current window only. ---
    let fights_total = i64::try_from(current_fights.len()).unwrap_or(i64::MAX);
    let fights_with_event = i64::try_from(
        current_fights
            .iter()
            .filter(|f| f.event_id.is_some())
            .count(),
    )
    .unwrap_or(i64::MAX);
    let attribution_gap_finding =
        rules::evaluate_attribution_gap(fights_total, fights_with_event, current_start, now);

    // --- stale_intel: one finding per qualifying enemy guild. ---
    let stale_candidates = enemy_guild::Entity::find()
        .filter(enemy_guild::Column::LastSeenAt.lte(current_start))
        .all(db)
        .await?;
    let candidate_ids: Vec<i64> = stale_candidates.iter().map(|guild| guild.id).collect();
    let distinct_battle_rows: Vec<DistinctBattleRow> = if candidate_ids.is_empty() {
        Vec::new()
    } else {
        enemy_player_battle::Entity::find()
            .select_only()
            .column(enemy_player_battle::Column::EnemyGuildId)
            .expr_as(
                Expr::col(enemy_player_battle::Column::BattleId).count_distinct(),
                "distinct_battles",
            )
            .filter(enemy_player_battle::Column::EnemyGuildId.is_in(candidate_ids))
            .group_by(enemy_player_battle::Column::EnemyGuildId)
            .into_model::<DistinctBattleRow>()
            .all(db)
            .await?
    };
    let distinct_battles_by_guild: HashMap<i64, i64> = distinct_battle_rows
        .into_iter()
        .map(|row| (row.enemy_guild_id, row.distinct_battles))
        .collect();
    let stale_intel_findings: Vec<Finding> = stale_candidates
        .iter()
        .filter_map(|guild| {
            let distinct_battles = distinct_battles_by_guild
                .get(&guild.id)
                .copied()
                .unwrap_or(0);
            rules::evaluate_stale_intel(
                guild.id,
                guild.last_seen_at.with_timezone(&Utc),
                distinct_battles,
                now,
            )
        })
        .collect();

    // --- Persist: delete-then-insert per rule_key, inside one transaction
    // so a partial recompute never leaves a mix of old and new findings. ---
    let txn = db.begin().await?;
    let mut persisted = 0usize;

    for (rule_key, finding) in [
        ("win_rate_drop", win_rate_drop_finding),
        ("trade_worsening", trade_worsening_finding),
        ("ip_deficit", ip_deficit_finding),
        ("unpriced_losses", unpriced_losses_finding),
        ("attribution_gap", attribution_gap_finding),
    ] {
        attention_finding::Entity::delete_many()
            .filter(attention_finding::Column::RuleKey.eq(rule_key))
            .exec(&txn)
            .await?;
        if let Some(finding) = finding {
            insert_finding(&txn, &finding, now).await?;
            persisted += 1;
        }
    }

    attention_finding::Entity::delete_many()
        .filter(attention_finding::Column::RuleKey.eq("stale_intel"))
        .exec(&txn)
        .await?;
    for finding in &stale_intel_findings {
        insert_finding(&txn, finding, now).await?;
        persisted += 1;
    }

    txn.commit().await?;

    Ok(persisted)
}

/// Row shape for the batched `GROUP BY enemy_guild_id` distinct-battle-count
/// query, the same technique `enemies::service`'s own rollup queries use.
#[derive(Debug, FromQueryResult)]
struct DistinctBattleRow {
    enemy_guild_id: i64,
    distinct_battles: i64,
}

/// Folds a period's fights into `rules::PeriodOutcomes`. A fight never
/// recomputed (`outcome = "unknown"`) is excluded from both numerator and
/// denominator, matching `PeriodOutcomes::decided_fights`'s own doc comment.
fn period_outcomes(fights: &[&fight::Model]) -> rules::PeriodOutcomes {
    let mut decided_fights = 0i64;
    let mut wins = 0i64;
    for fight in fights {
        match fight.outcome.as_str() {
            "victory" => {
                decided_fights += 1;
                wins += 1;
            }
            "defeat" | "draw" => {
                decided_fights += 1;
            }
            _ => {}
        }
    }
    rules::PeriodOutcomes {
        decided_fights,
        wins,
    }
}

/// Folds a period's fight ids into `rules::PeriodTrade`, using only the
/// fights that already have a `fight_stats` row — a fight with none has no
/// data to trade on and contributes nothing to either the count or the
/// sums.
fn period_trade(
    fight_ids: &[i64],
    stats_by_fight: &HashMap<i64, fight_stat::Model>,
) -> rules::PeriodTrade {
    let mut fights = 0i64;
    let mut friendly_estimated_loss_total = 0i64;
    let mut friendly_kill_fame_total = 0i64;
    for fight_id in fight_ids {
        if let Some(stat) = stats_by_fight.get(fight_id) {
            fights += 1;
            friendly_estimated_loss_total += stat.friendly_estimated_loss;
            friendly_kill_fame_total += stat.friendly_kill_fame;
        }
    }
    rules::PeriodTrade {
        fights,
        friendly_estimated_loss_total,
        friendly_kill_fame_total,
    }
}

/// Inserts one persisted row for `finding`, per the mapping documented on
/// `attention::writer`'s task spec: every column copied verbatim,
/// `evidence_json` serialized from `finding.evidence`, and `computed_at`/
/// `created_at`/`updated_at` all set to `now`.
async fn insert_finding<C: ConnectionTrait>(
    conn: &C,
    finding: &Finding,
    now: DateTime<Utc>,
) -> Result<(), DbErr> {
    attention_finding::ActiveModel {
        rule_key: Set(finding.rule_key.to_string()),
        rule_version: Set(finding.rule_version),
        severity: Set(finding.severity.as_str().to_string()),
        subject_type: Set(finding.subject_type.to_string()),
        subject_id: Set(finding.subject_id),
        period_start: Set(finding.period_start.into()),
        period_end: Set(finding.period_end.into()),
        metric_value: Set(finding.metric_value),
        baseline_value: Set(finding.baseline_value),
        sample_size: Set(finding.sample_size),
        evidence_json: Set(finding.evidence.to_string()),
        computed_at: Set(now.into()),
        created_at: Set(now.into()),
        updated_at: Set(now.into()),
        ..Default::default()
    }
    .insert(conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use chrono::Duration as ChronoDuration;
    use sea_orm::Database;

    use crate::modules::comps::entities::{comp as comp_entities, comp_category};
    use crate::modules::events::entities::event;
    use crate::modules::users::entities as user_entities;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    async fn insert_fight(
        db: &DatabaseConnection,
        started_at: DateTime<Utc>,
        outcome: &str,
        event_id: Option<i64>,
    ) -> i64 {
        let now = Utc::now();
        fight::ActiveModel {
            event_id: Set(event_id),
            started_at: Set(started_at.into()),
            ended_at: Set(None),
            grouping_method: Set("automatic".to_string()),
            grouping_confidence: Set(1.0),
            grouping_version: Set("v1".to_string()),
            needs_review: Set(false),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            outcome: Set(outcome.to_string()),
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

    async fn insert_fight_stat(
        db: &DatabaseConnection,
        fight_id: i64,
        friendly_estimated_loss: i64,
        friendly_kill_fame: i64,
        avg_friendly_item_power: f64,
        avg_enemy_item_power: f64,
    ) {
        let now = Utc::now();
        fight_stat::ActiveModel {
            fight_id: Set(fight_id),
            segment_count: Set(1),
            unique_friendly_players: Set(1),
            unique_enemy_players: Set(1),
            friendly_kills: Set(0),
            friendly_deaths: Set(0),
            friendly_kill_fame: Set(friendly_kill_fame),
            enemy_kills: Set(0),
            enemy_deaths: Set(0),
            enemy_kill_fame: Set(0),
            avg_friendly_item_power: Set(avg_friendly_item_power),
            avg_enemy_item_power: Set(avg_enemy_item_power),
            friendly_estimated_loss: Set(friendly_estimated_loss),
            enemy_estimated_loss: Set(0),
            computed_at: Set(now.into()),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight_stat");
    }

    async fn link_segment(db: &DatabaseConnection, fight_id: i64, battle_id: i64) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(0),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight_battle");
    }

    async fn insert_loss_estimate(
        db: &DatabaseConnection,
        battle_id: i64,
        friendly_priced_items: i32,
        friendly_total_items: i32,
    ) {
        let now = Utc::now();
        battle_loss_estimate::ActiveModel {
            battle_id: Set(battle_id),
            friendly_estimated_loss: Set(0),
            friendly_priced_items: Set(friendly_priced_items),
            friendly_total_items: Set(friendly_total_items),
            enemy_estimated_loss: Set(0),
            enemy_priced_items: Set(0),
            enemy_total_items: Set(0),
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

    async fn insert_enemy_guild(db: &DatabaseConnection, last_seen_at: DateTime<Utc>) -> i64 {
        enemy_guild::ActiveModel {
            guild_key: Set(format!(
                "id:{}",
                last_seen_at.timestamp_nanos_opt().unwrap_or(0)
            )),
            albion_guild_id: Set(None),
            name: Set("Stale Foes".to_string()),
            current_alliance_id: Set(None),
            current_alliance_name: Set(None),
            first_seen_at: Set(last_seen_at.into()),
            last_seen_at: Set(last_seen_at.into()),
            is_watchlisted: Set(false),
            notes: Set(None),
            created_at: Set(Utc::now().into()),
            updated_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert enemy_guild")
        .id
    }

    async fn insert_enemy_player(db: &DatabaseConnection, enemy_guild_id: i64) -> i64 {
        use crate::modules::enemies::entities::enemy_player;
        let now = Utc::now();
        enemy_player::ActiveModel {
            player_key: Set(format!("id:p{enemy_guild_id}-{now}")),
            albion_player_id: Set(None),
            name: Set("Foe".to_string()),
            identity_source: Set("name_only".to_string()),
            current_enemy_guild_id: Set(Some(enemy_guild_id)),
            first_seen_at: Set(now.into()),
            last_seen_at: Set(now.into()),
            is_watchlisted: Set(false),
            notes: Set(None),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert enemy_player")
        .id
    }

    async fn insert_enemy_player_battle(
        db: &DatabaseConnection,
        battle_id: i64,
        enemy_player_id: i64,
        enemy_guild_id: i64,
        occurred_at: DateTime<Utc>,
    ) {
        enemy_player_battle::ActiveModel {
            battle_id: Set(battle_id),
            enemy_player_id: Set(enemy_player_id),
            enemy_guild_id: Set(enemy_guild_id),
            occurred_at: Set(occurred_at.into()),
            role: Set(None),
            main_hand_item_id: Set(None),
            item_power: Set(1000.0),
            our_kills_on_them: Set(0),
            their_kills_on_us: Set(0),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert enemy_player_battle");
    }

    async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
        user_entities::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("member".to_string()),
            discord_id: Set(Some(format!("discord-{name}"))),
            created_at: Set(Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    /// Minimal fixture chain (comp category -> comp -> event) so a fight can
    /// legitimately reference a real `events` row (`fights.event_id` is a
    /// real foreign key) instead of an arbitrary, non-existent id.
    async fn insert_event(db: &DatabaseConnection, title: &str) -> i64 {
        let now = Utc::now();
        let user_id = insert_user(db, &format!("creator-{title}")).await;

        let comp_category_id = comp_category::ActiveModel {
            name: Set("Comp Category".to_string()),
            slug: Set(format!("comp-category-{title}")),
            description: Set(None),
            created_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp category")
        .id;

        let comp_id = comp_entities::ActiveModel {
            name: Set(format!("Comp {title}")),
            description: Set(None),
            category_id: Set(comp_category_id),
            version: Set(1),
            created_by: Set(user_id),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            parent_id: Set(None),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp")
        .id;

        event::ActiveModel {
            title: Set(title.to_string()),
            description: Set(None),
            call_to_arms: Set(false),
            regear: Set(true),
            comp_id: Set(comp_id),
            player_cap: Set(None),
            created_by: Set(user_id),
            event_date_utc: Set(now.into()),
            mass_time_utc: Set(None),
            start_time_utc: Set(None),
            created_at: Set(now.into()),
            updated_at: Set(now.into()),
            status: Set("completed".to_string()),
            started_at: Set(None),
            stopped_at: Set(None),
            auto_stop_deadline: Set(None),
            link_status: Set("idle".to_string()),
            link_attempts: Set(0),
            link_last_error: Set(None),
            link_battles_completed_at: Set(None),
            discord_voice_channel_id: Set(None),
            roster_version: Set(0),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event")
        .id
    }

    async fn findings_for_rule(
        db: &DatabaseConnection,
        rule_key: &str,
    ) -> Vec<attention_finding::Model> {
        attention_finding::Entity::find()
            .filter(attention_finding::Column::RuleKey.eq(rule_key))
            .all(db)
            .await
            .expect("query attention_findings")
    }

    #[tokio::test]
    async fn empty_database_recomputes_to_zero_rows() {
        let db = seed_db().await;

        let count = recompute_attention_findings(&db, Utc::now())
            .await
            .expect("recompute succeeds on empty db");

        assert_eq!(count, 0);
        let all = attention_finding::Entity::find()
            .all(&db)
            .await
            .expect("query");
        assert!(all.is_empty());
    }

    #[tokio::test]
    async fn win_rate_drop_fires_and_persists_expected_values() {
        let db = seed_db().await;
        let now = Utc::now();

        // Previous window: 14 wins / 20 decided = 70%.
        for _ in 0..14 {
            insert_fight(&db, now - ChronoDuration::days(40), "victory", None).await;
        }
        for _ in 0..6 {
            insert_fight(&db, now - ChronoDuration::days(40), "defeat", None).await;
        }
        // Current window: 8 wins / 20 decided = 40%.
        for _ in 0..8 {
            insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
        }
        for _ in 0..12 {
            insert_fight(&db, now - ChronoDuration::days(10), "defeat", None).await;
        }

        // Not asserted as exactly 1: every fight here has `event_id: None`,
        // so `attribution_gap` (0% attributed, 20 >= its 10-fight minimum)
        // legitimately fires too. This test is about `win_rate_drop`
        // specifically, verified below via `findings_for_rule`.
        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert!(count >= 1);

        let rows = findings_for_rule(&db, "win_rate_drop").await;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert!((row.metric_value - 40.0).abs() < 1e-9);
        assert_eq!(row.baseline_value, Some(70.0));
        assert_eq!(row.sample_size, 20);
        assert_eq!(row.subject_type, "guild");
        assert!(row.subject_id.is_none());
    }

    #[tokio::test]
    async fn trade_worsening_fires_from_joined_fight_stats() {
        let db = seed_db().await;
        let now = Utc::now();

        // Previous window: 8 fights, 76M loss / 41M fame total (~9.5M/fight loss, ~5.1M/fight fame).
        for i in 0..8 {
            let fight_id = insert_fight(&db, now - ChronoDuration::days(40), "victory", None).await;
            insert_fight_stat(
                &db,
                fight_id,
                76_000_000 / 8,
                41_000_000 / 8,
                1300.0,
                1300.0,
            )
            .await;
            let _ = i;
        }
        // Current window: 8 fights, 100M loss / 40M fame total (fame roughly flat, loss up sharply).
        for _ in 0..8 {
            let fight_id = insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
            insert_fight_stat(
                &db,
                fight_id,
                100_000_000 / 8,
                40_000_000 / 8,
                1300.0,
                1300.0,
            )
            .await;
        }

        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert!(count >= 1);

        let rows = findings_for_rule(&db, "trade_worsening").await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sample_size, 8);
    }

    #[tokio::test]
    async fn ip_deficit_fires_from_current_window_fight_stats() {
        let db = seed_db().await;
        let now = Utc::now();

        for _ in 0..5 {
            let fight_id = insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
            insert_fight_stat(&db, fight_id, 0, 0, 1300.0, 1450.0).await;
        }

        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert!(count >= 1);

        let rows = findings_for_rule(&db, "ip_deficit").await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sample_size, 5);
        assert!((rows[0].metric_value - (-150.0)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn unpriced_losses_fires_from_the_full_join_chain() {
        let db = seed_db().await;
        let now = Utc::now();

        // 5 fights, each with one battle segment, each battle priced at
        // 4/10 items -> 20 priced / 50 total = 40% coverage.
        for i in 0..5 {
            let fight_id = insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
            let battle_id = 1000 + i;
            link_segment(&db, fight_id, battle_id).await;
            insert_loss_estimate(&db, battle_id, 4, 10).await;
        }

        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert!(count >= 1);

        let rows = findings_for_rule(&db, "unpriced_losses").await;
        assert_eq!(rows.len(), 1);
        assert!((rows[0].metric_value - 40.0).abs() < 1e-9);
        assert_eq!(rows[0].sample_size, 50);
    }

    #[tokio::test]
    async fn attribution_gap_fires_when_most_fights_lack_an_event() {
        let db = seed_db().await;
        let now = Utc::now();

        for _ in 0..8 {
            insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
        }
        let event_id = insert_event(&db, "Attribution Gap Event").await;
        for _ in 0..2 {
            insert_fight(
                &db,
                now - ChronoDuration::days(10),
                "victory",
                Some(event_id),
            )
            .await;
        }

        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert!(count >= 1);

        let rows = findings_for_rule(&db, "attribution_gap").await;
        assert_eq!(rows.len(), 1);
        assert!((rows[0].metric_value - 20.0).abs() < 1e-9);
        assert_eq!(rows[0].sample_size, 10);
    }

    #[tokio::test]
    async fn stale_intel_fires_per_qualifying_enemy_guild() {
        let db = seed_db().await;
        let now = Utc::now();
        let last_seen = now - ChronoDuration::days(45);

        let guild_id = insert_enemy_guild(&db, last_seen).await;
        let player_id = insert_enemy_player(&db, guild_id).await;
        for battle_id in [5000, 5001, 5002] {
            insert_enemy_player_battle(&db, battle_id, player_id, guild_id, last_seen).await;
        }

        let count = recompute_attention_findings(&db, now)
            .await
            .expect("recompute");
        assert_eq!(count, 1);

        let rows = findings_for_rule(&db, "stale_intel").await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject_type, "enemy_guild");
        assert_eq!(rows[0].subject_id, Some(guild_id));
        assert_eq!(rows[0].sample_size, 3);
    }

    /// The single most important test in this file: a finding that was
    /// persisted on one recompute must actually disappear on a later
    /// recompute once its condition stops holding — proving the
    /// delete-then-insert-per-rule_key policy, not merely that it inserts.
    #[tokio::test]
    async fn wholesale_replace_removes_a_finding_that_stops_qualifying() {
        let db = seed_db().await;
        let now = Utc::now();

        for _ in 0..14 {
            insert_fight(&db, now - ChronoDuration::days(40), "victory", None).await;
        }
        for _ in 0..6 {
            insert_fight(&db, now - ChronoDuration::days(40), "defeat", None).await;
        }
        for _ in 0..8 {
            insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
        }
        for _ in 0..12 {
            insert_fight(&db, now - ChronoDuration::days(10), "defeat", None).await;
        }

        recompute_attention_findings(&db, now)
            .await
            .expect("first recompute");
        assert_eq!(findings_for_rule(&db, "win_rate_drop").await.len(), 1);

        // Mutate: add enough current-window wins that the current win rate
        // overtakes the previous period's 70%, so there is no longer any
        // drop at all (current becomes 38 wins / 50 decided = 76%).
        for _ in 0..30 {
            insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
        }

        recompute_attention_findings(&db, now)
            .await
            .expect("second recompute");

        let rows = findings_for_rule(&db, "win_rate_drop").await;
        assert!(
            rows.is_empty(),
            "the stale win_rate_drop finding must be gone, not left over or duplicated"
        );
    }

    /// A recompute touching several rules at once must not let one rule's
    /// `DELETE` reach into another rule's rows.
    #[tokio::test]
    async fn recompute_does_not_leak_deletes_across_rules() {
        let db = seed_db().await;
        let now = Utc::now();

        // win_rate_drop.
        for _ in 0..14 {
            insert_fight(&db, now - ChronoDuration::days(40), "victory", None).await;
        }
        for _ in 0..6 {
            insert_fight(&db, now - ChronoDuration::days(40), "defeat", None).await;
        }
        for _ in 0..8 {
            insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
        }
        for _ in 0..12 {
            insert_fight(&db, now - ChronoDuration::days(10), "defeat", None).await;
        }
        // ip_deficit, layered onto the same current-window fights.
        for _ in 0..5 {
            let fight_id = insert_fight(&db, now - ChronoDuration::days(10), "victory", None).await;
            insert_fight_stat(&db, fight_id, 0, 0, 1300.0, 1450.0).await;
        }

        recompute_attention_findings(&db, now)
            .await
            .expect("recompute");

        assert_eq!(findings_for_rule(&db, "win_rate_drop").await.len(), 1);
        assert_eq!(findings_for_rule(&db, "ip_deficit").await.len(), 1);

        // Recompute again: both must still be present, independently.
        recompute_attention_findings(&db, now)
            .await
            .expect("second recompute");
        assert_eq!(findings_for_rule(&db, "win_rate_drop").await.len(), 1);
        assert_eq!(findings_for_rule(&db, "ip_deficit").await.len(), 1);
    }
}
