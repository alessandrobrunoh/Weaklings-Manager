//! Read-only queries backing the economy endpoints.
//!
//! Restates the rule from `modules::economy`'s own doc comment, because it
//! governs every line below: **income is declared, never inferred from
//! combat.** The battle/fight views below only ever read (or sum)
//! `battle_loss_estimates` rows, and their `enemy_*` fields are surfaced as a
//! trade indicator only — nothing here ever folds an enemy loss into an
//! income total. The event view is the one place real money is computed, and
//! it is built entirely from already-declared ledger facts
//! (`splits.net_value`, `regear_deaths.final_amount`); no combat estimate
//! ever touches its income side.
//!
//! Every sum here is folded in Rust from already-fetched rows rather than
//! pushed into a SQL `SUM(..)` aggregate, mirroring `fingerprints::service` /
//! `enemies::service`'s established technique for this exact class of
//! problem: plain, portable queries, no backend-specific casts or window
//! functions, and no risk of a `Decimal` aggregate behaving differently
//! between Postgres and the `SQLite` used in tests.

use rust_decimal::prelude::ToPrimitive;
use sea_orm::prelude::Decimal;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::events::entities::{event, fight, fight_battle};
use crate::modules::regear::entities::regear_death;
use crate::modules::regear::status::RegearStatus;
use crate::modules::splits::entities::split;
use crate::modules::splits::status::SplitStatus;

use super::entities::battle_loss_estimate;
use super::models::{BattleEconomyView, EventEconomyView, FightEconomyView};

/// Stateless economy read operations.
pub struct EconomyService;

impl Default for EconomyService {
    fn default() -> Self {
        Self
    }
}

impl EconomyService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// One battle's trade-and-cost view, read straight from its
    /// `battle_loss_estimates` row.
    ///
    /// # Errors
    ///
    /// `404` if this battle has never been hydrated through the economy
    /// writer (no estimate computed yet — a real, meaningful "not yet
    /// computed" state, not an error to hide); database errors otherwise.
    pub async fn get_battle_economy(
        &self,
        db: &DatabaseConnection,
        battle_id: i64,
    ) -> Result<BattleEconomyView, AppError> {
        let model = battle_loss_estimate::Entity::find()
            .filter(battle_loss_estimate::Column::BattleId.eq(battle_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "no loss estimate has been computed yet for battle {battle_id}"
                ))
            })?;
        Ok(battle_view(&model))
    }

    /// One fight's trade-and-cost view: every segment's `battle_loss_estimates`
    /// row summed into one total. A segment with no estimate yet contributes
    /// zero rather than blocking the whole view — see `segments_total` /
    /// `segments_priced` on the response for how to tell a complete figure
    /// from a partial one.
    ///
    /// # Errors
    ///
    /// `404` if `fight_id` does not exist; database errors otherwise.
    pub async fn get_fight_economy(
        &self,
        db: &DatabaseConnection,
        fight_id: i64,
    ) -> Result<FightEconomyView, AppError> {
        fight::Entity::find_by_id(fight_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("fight {fight_id} not found")))?;

        let segments = fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.eq(fight_id))
            .all(db)
            .await?;
        let segments_total = i64::try_from(segments.len()).unwrap_or(i64::MAX);

        let battle_ids: Vec<i64> = segments.iter().map(|s| s.battle_id).collect();
        let estimates = estimates_for_battles(db, &battle_ids).await?;

        Ok(fight_view(fight_id, segments_total, &estimates))
    }

    /// One event's real P&L: income and regear payout drawn entirely from the
    /// ledger, plus informational (never-summed-into-`net`) combat-loss
    /// context. An event with no splits/regears/fights at all returns
    /// all-zero figures — a quiet CTA with no loot and no losses is a valid,
    /// real state, not an error.
    ///
    /// # Errors
    ///
    /// `404` if `event_id` does not exist; database errors otherwise.
    pub async fn get_event_economy(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
    ) -> Result<EventEconomyView, AppError> {
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("event {event_id} not found")))?;

        let completed_splits = split::Entity::find()
            .filter(split::Column::EventId.eq(event_id))
            .filter(split::Column::Status.eq(SplitStatus::Completed.to_string()))
            .all(db)
            .await?;
        let income_total: Decimal = completed_splits.iter().filter_map(|s| s.net_value).sum();

        let regears = regear_death::Entity::find()
            .filter(regear_death::Column::EventId.eq(event_id))
            .all(db)
            .await?;
        let regear_paid_total: Decimal = regears
            .iter()
            .filter(|r| r.status == RegearStatus::Approved.to_string())
            .filter_map(|r| r.final_amount)
            .sum();
        let regear_requested_total: Decimal = regears.iter().map(|r| r.auto_estimate_total).sum();

        let fight_ids: Vec<i64> = fight::Entity::find()
            .filter(fight::Column::EventId.eq(event_id))
            .all(db)
            .await?
            .into_iter()
            .map(|f| f.id)
            .collect();
        let battle_ids = battle_ids_for_fights(db, &fight_ids).await?;
        let estimates = estimates_for_battles(db, &battle_ids).await?;
        let friendly_combat_loss_total: i64 =
            estimates.iter().map(|e| e.friendly_estimated_loss).sum();

        let net = income_total - regear_paid_total;
        // A silver total in the billions would still be exact at f64.
        #[allow(clippy::cast_precision_loss)]
        let regear_coverage_pct = if friendly_combat_loss_total > 0 {
            regear_paid_total
                .to_f64()
                .map(|paid| paid / friendly_combat_loss_total as f64 * 100.0)
        } else {
            None
        };

        Ok(EventEconomyView {
            event_id: event_model.id,
            event_title: event_model.title,
            income_total,
            regear_paid_total,
            regear_requested_total,
            net,
            friendly_combat_loss_total,
            regear_coverage_pct,
        })
    }
}

/// Every `battle_loss_estimates` row for the given battle ids. Empty input
/// short-circuits to no query (`is_in([])` is valid SQL but a wasted round trip).
async fn estimates_for_battles(
    db: &DatabaseConnection,
    battle_ids: &[i64],
) -> Result<Vec<battle_loss_estimate::Model>, AppError> {
    if battle_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(battle_loss_estimate::Entity::find()
        .filter(battle_loss_estimate::Column::BattleId.is_in(battle_ids.to_vec()))
        .all(db)
        .await?)
}

/// Every battle id belonging to any segment of the given fights. Empty input
/// short-circuits to no query. `fight_battles.battle_id` is unique table-wide,
/// so this can never contain a duplicate.
async fn battle_ids_for_fights(
    db: &DatabaseConnection,
    fight_ids: &[i64],
) -> Result<Vec<i64>, AppError> {
    if fight_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.is_in(fight_ids.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|segment| segment.battle_id)
        .collect())
}

/// Builds the battle view straight from one `battle_loss_estimates` row.
fn battle_view(model: &battle_loss_estimate::Model) -> BattleEconomyView {
    BattleEconomyView {
        battle_id: model.battle_id,
        friendly_estimated_loss: model.friendly_estimated_loss,
        friendly_priced_items: model.friendly_priced_items,
        friendly_total_items: model.friendly_total_items,
        enemy_estimated_loss: model.enemy_estimated_loss,
        enemy_priced_items: model.enemy_priced_items,
        enemy_total_items: model.enemy_total_items,
        pricing_location: model.pricing_location.clone(),
        priced_at: model.priced_at.to_rfc3339(),
        trade_net: model.enemy_estimated_loss - model.friendly_estimated_loss,
    }
}

/// Folds a fight's priced segments into the summed fight-level view.
///
/// `pricing_location` is `Some` only when every priced segment agrees;
/// `priced_at` is the oldest `priced_at` among priced segments. Both are
/// `None` when there are zero priced segments.
fn fight_view(
    fight_id: i64,
    segments_total: i64,
    estimates: &[battle_loss_estimate::Model],
) -> FightEconomyView {
    let segments_priced = i64::try_from(estimates.len()).unwrap_or(i64::MAX);

    let mut friendly_estimated_loss = 0_i64;
    let mut friendly_priced_items = 0_i32;
    let mut friendly_total_items = 0_i32;
    let mut enemy_estimated_loss = 0_i64;
    let mut enemy_priced_items = 0_i32;
    let mut enemy_total_items = 0_i32;
    for estimate in estimates {
        friendly_estimated_loss += estimate.friendly_estimated_loss;
        friendly_priced_items += estimate.friendly_priced_items;
        friendly_total_items += estimate.friendly_total_items;
        enemy_estimated_loss += estimate.enemy_estimated_loss;
        enemy_priced_items += estimate.enemy_priced_items;
        enemy_total_items += estimate.enemy_total_items;
    }

    let pricing_location = estimates
        .first()
        .map(|first| &first.pricing_location)
        .and_then(|first_location| {
            let all_agree = estimates
                .iter()
                .all(|estimate| &estimate.pricing_location == first_location);
            all_agree.then(|| first_location.clone())
        });

    let priced_at = estimates
        .iter()
        .map(|estimate| estimate.priced_at)
        .min()
        .map(|dt| dt.to_rfc3339());

    FightEconomyView {
        fight_id,
        friendly_estimated_loss,
        friendly_priced_items,
        friendly_total_items,
        enemy_estimated_loss,
        enemy_priced_items,
        enemy_total_items,
        pricing_location,
        priced_at,
        segments_total,
        segments_priced,
        trade_net: enemy_estimated_loss - friendly_estimated_loss,
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, FixedOffset};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::entities::{comp as comp_entities, comp_category};
    use crate::modules::users::entities as user_entities;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    fn ts(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).expect("hard-coded timestamp")
    }

    async fn insert_estimate(
        db: &DatabaseConnection,
        battle_id: i64,
        friendly_estimated_loss: i64,
        enemy_estimated_loss: i64,
        pricing_location: &str,
        priced_at: &str,
    ) -> i64 {
        battle_loss_estimate::ActiveModel {
            battle_id: Set(battle_id),
            friendly_estimated_loss: Set(friendly_estimated_loss),
            friendly_priced_items: Set(3),
            friendly_total_items: Set(4),
            enemy_estimated_loss: Set(enemy_estimated_loss),
            enemy_priced_items: Set(2),
            enemy_total_items: Set(5),
            pricing_location: Set(pricing_location.to_string()),
            priced_at: Set(ts(priced_at)),
            created_at: Set(ts(priced_at)),
            updated_at: Set(ts(priced_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert estimate")
        .id
    }

    async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
        user_entities::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("member".to_string()),
            discord_id: Set(Some(format!("discord-{name}"))),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    /// Minimal fixture chain (comp category -> comp -> event) so tests can
    /// insert real `events` rows without depending on the events module's
    /// own test helpers.
    async fn insert_event(db: &DatabaseConnection, title: &str) -> i64 {
        let user_id = insert_user(db, &format!("creator-{title}")).await;

        let comp_category_id = comp_category::ActiveModel {
            name: Set("Comp Category".to_string()),
            slug: Set(format!("comp-category-{title}")),
            description: Set(None),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
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
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
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
            event_date_utc: Set(ts("2026-01-01T00:00:00Z")),
            mass_time_utc: Set(None),
            start_time_utc: Set(None),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
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

    async fn insert_fight(db: &DatabaseConnection, event_id: Option<i64>) -> i64 {
        fight::ActiveModel {
            event_id: Set(event_id),
            started_at: Set(ts("2026-01-01T00:00:00Z")),
            ended_at: Set(None),
            grouping_method: Set("manual".to_string()),
            grouping_confidence: Set(1.0),
            grouping_version: Set("v1".to_string()),
            needs_review: Set(false),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
        .id
    }

    async fn insert_fight_battle(
        db: &DatabaseConnection,
        fight_id: i64,
        battle_id: i64,
        sequence_number: i32,
    ) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(sequence_number),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight battle");
    }

    async fn insert_split(
        db: &DatabaseConnection,
        created_by: i64,
        event_id: Option<i64>,
        status: SplitStatus,
        net_value: Option<&str>,
    ) -> i64 {
        split::ActiveModel {
            created_by: Set(created_by),
            status: Set(status.to_string()),
            estimated_market_value: Set(Decimal::ZERO),
            fee: Set(Decimal::ZERO),
            repair_value: Set(Decimal::ZERO),
            bags_value: Set(Decimal::ZERO),
            net_value: Set(net_value.map(|v| v.parse().expect("decimal"))),
            note: Set(None),
            event_id: Set(event_id),
            island_tab_id: Set(None),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            finalized_at: Set(None),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert split")
        .id
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_regear_death(
        db: &DatabaseConnection,
        event_id: i64,
        status: RegearStatus,
        auto_estimate_total: &str,
        final_amount: Option<&str>,
    ) -> i64 {
        regear_death::ActiveModel {
            event_id: Set(event_id),
            event_battle_id: Set(None),
            albionbb_battle_id: Set(None),
            albion_kill_event_id: Set(None),
            killed_at: Set(ts("2026-01-01T00:00:00Z")),
            user_id: Set(None),
            player_name: Set("Victim".to_string()),
            guild_id: Set("guild".to_string()),
            primary_build_id: Set(None),
            loadout_json: Set("{}".to_string()),
            auto_estimate_total: Set(auto_estimate_total.parse().expect("decimal")),
            auto_estimate_breakdown_json: Set("[]".to_string()),
            status: Set(status.to_string()),
            requested_at: Set(None),
            decided_at: Set(None),
            decided_by_user_id: Set(None),
            final_amount: Set(final_amount.map(|v| v.parse().expect("decimal"))),
            final_breakdown_json: Set(None),
            officer_note: Set(None),
            bank_transaction_id: Set(None),
            source: Set("extracted".to_string()),
            override_loadout_json: Set(None),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert regear death")
        .id
    }

    #[tokio::test]
    async fn get_battle_economy_returns_view_with_trade_net() {
        let db = seed_db().await;
        insert_estimate(&db, 100, 1_000, 1_500, "Caerleon", "2026-01-01T00:00:00Z").await;

        let service = EconomyService::new();
        let view = service.get_battle_economy(&db, 100).await.expect("view");

        assert_eq!(view.battle_id, 100);
        assert_eq!(view.friendly_estimated_loss, 1_000);
        assert_eq!(view.enemy_estimated_loss, 1_500);
        assert_eq!(view.trade_net, 500, "enemy lost more => positive trade_net");
        assert_eq!(view.pricing_location, "Caerleon");
    }

    #[tokio::test]
    async fn get_battle_economy_returns_not_found_when_never_hydrated() {
        let db = seed_db().await;
        let service = EconomyService::new();
        let err = service.get_battle_economy(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn get_fight_economy_sums_segments_and_reports_partial_coverage() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db, None).await;
        insert_fight_battle(&db, fight_id, 1, 0).await;
        insert_fight_battle(&db, fight_id, 2, 1).await;
        insert_fight_battle(&db, fight_id, 3, 2).await;
        insert_estimate(&db, 1, 1_000, 1_200, "Caerleon", "2026-01-02T00:00:00Z").await;
        insert_estimate(&db, 2, 500, 300, "Caerleon", "2026-01-01T00:00:00Z").await;
        // Battle 3 never hydrated - contributes zero, not an error.

        let service = EconomyService::new();
        let view = service
            .get_fight_economy(&db, fight_id)
            .await
            .expect("view");

        assert_eq!(view.segments_total, 3);
        assert_eq!(view.segments_priced, 2, "only 2 of 3 segments were priced");
        assert_eq!(view.friendly_estimated_loss, 1_500);
        assert_eq!(view.enemy_estimated_loss, 1_500);
        assert_eq!(view.trade_net, 0);
        assert_eq!(view.pricing_location.as_deref(), Some("Caerleon"));
        assert_eq!(
            view.priced_at.as_deref(),
            Some("2026-01-01T00:00:00+00:00"),
            "oldest priced_at among covered segments"
        );
    }

    #[tokio::test]
    async fn get_fight_economy_reports_mixed_pricing_locations_as_none() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db, None).await;
        insert_fight_battle(&db, fight_id, 1, 0).await;
        insert_fight_battle(&db, fight_id, 2, 1).await;
        insert_estimate(&db, 1, 100, 100, "Caerleon", "2026-01-01T00:00:00Z").await;
        insert_estimate(&db, 2, 100, 100, "Bridgewatch", "2026-01-02T00:00:00Z").await;

        let service = EconomyService::new();
        let view = service
            .get_fight_economy(&db, fight_id)
            .await
            .expect("view");

        assert_eq!(
            view.pricing_location, None,
            "disagreeing segment locations must never be arbitrarily resolved"
        );
    }

    #[tokio::test]
    async fn get_fight_economy_returns_not_found_for_unknown_fight() {
        let db = seed_db().await;
        let service = EconomyService::new();
        let err = service.get_fight_economy(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn get_fight_economy_with_zero_segments_is_all_zero_not_an_error() {
        let db = seed_db().await;
        let fight_id = insert_fight(&db, None).await;

        let service = EconomyService::new();
        let view = service
            .get_fight_economy(&db, fight_id)
            .await
            .expect("view");

        assert_eq!(view.segments_total, 0);
        assert_eq!(view.segments_priced, 0);
        assert_eq!(view.friendly_estimated_loss, 0);
        assert_eq!(view.pricing_location, None);
        assert_eq!(view.priced_at, None);
    }

    #[tokio::test]
    async fn get_event_economy_computes_real_pnl_without_double_counting_combat_loss() {
        let db = seed_db().await;
        let event_id = insert_event(&db, "Main Event").await;
        let user_id = insert_user(&db, "split-creator").await;

        insert_split(
            &db,
            user_id,
            Some(event_id),
            SplitStatus::Completed,
            Some("100000"),
        )
        .await;
        // A non-completed split's net_value must never be counted as income.
        insert_split(
            &db,
            user_id,
            Some(event_id),
            SplitStatus::Pending,
            Some("999999"),
        )
        .await;

        insert_regear_death(
            &db,
            event_id,
            RegearStatus::Approved,
            "20000",
            Some("20000"),
        )
        .await;
        insert_regear_death(&db, event_id, RegearStatus::Pending, "5000", None).await;

        let fight_id = insert_fight(&db, Some(event_id)).await;
        insert_fight_battle(&db, fight_id, 1, 0).await;
        insert_estimate(&db, 1, 30_000, 45_000, "Caerleon", "2026-01-01T00:00:00Z").await;

        let service = EconomyService::new();
        let view = service
            .get_event_economy(&db, event_id)
            .await
            .expect("view");

        assert_eq!(view.event_title, "Main Event");
        assert_eq!(
            view.income_total,
            Decimal::new(100_000, 0),
            "only the completed split counts as income"
        );
        assert_eq!(view.regear_paid_total, Decimal::new(20_000, 0));
        assert_eq!(
            view.regear_requested_total,
            Decimal::new(25_000, 0),
            "every regear death counts here regardless of status"
        );
        assert_eq!(
            view.net,
            Decimal::new(80_000, 0),
            "net = income_total - regear_paid_total only"
        );
        assert_ne!(
            view.net,
            view.income_total
                - view.regear_paid_total
                - Decimal::from(view.friendly_combat_loss_total),
            "net must never also subtract friendly_combat_loss_total"
        );
        assert_eq!(view.friendly_combat_loss_total, 30_000);
        assert_eq!(view.regear_coverage_pct, Some(20_000.0 / 30_000.0 * 100.0));
    }

    #[tokio::test]
    async fn get_event_economy_with_nothing_at_all_is_all_zero_not_an_error() {
        let db = seed_db().await;
        let event_id = insert_event(&db, "Empty Event").await;

        let service = EconomyService::new();
        let view = service
            .get_event_economy(&db, event_id)
            .await
            .expect("view");

        assert_eq!(view.income_total, Decimal::ZERO);
        assert_eq!(view.regear_paid_total, Decimal::ZERO);
        assert_eq!(view.regear_requested_total, Decimal::ZERO);
        assert_eq!(view.net, Decimal::ZERO);
        assert_eq!(view.friendly_combat_loss_total, 0);
        assert_eq!(view.regear_coverage_pct, None, "never divide by zero");
    }

    #[tokio::test]
    async fn get_event_economy_returns_not_found_for_unknown_event() {
        let db = seed_db().await;
        let service = EconomyService::new();
        let err = service.get_event_economy(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
