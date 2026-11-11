//! The regear request-credit balance: a weekly rollover pool plus a giveaway-earned bonus pool.
//!
//! There is no background job topping up the weekly pool. Instead, the pool is advanced lazily:
//! every read or write path routes through [`get_or_create_balance`], which recomputes how many
//! whole weeks have elapsed since the balance's anchor timestamp and applies that many top-ups,
//! capped, before returning. This keeps the displayed balance always accurate without a
//! scheduled tick, and guarantees there is exactly one code path that ever mutates
//! `weekly_balance`/`weekly_last_topup_at` — no drift between what a summary read shows and what
//! a consumption write sees.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};

use backend_core::errors::AppError;

use backend_entities::regear::{
    RegearRequestBalanceActiveModel, RegearRequestBalanceColumn, RegearRequestBalanceEntity,
    RegearRequestBalanceModel, RegearSettingModel,
};

const SECONDS_PER_WEEK: i64 = 7 * 24 * 3600;

/// Advances `balance` to `now`, applying whole elapsed weeks of top-up, capped. Pure — no DB
/// access — so it's unit-testable in isolation.
///
/// If the admin lowers `weekly_request_cap` below a user's current balance, that balance is left
/// alone here (only a top-up clamps) and only converges down the next time a whole week elapses —
/// the same "let existing state ride, converge on next mutation" pattern already used for
/// `enabled_slots_mask` edits not retroactively re-pricing old breakdowns.
fn apply_weekly_topup(
    balance: RegearRequestBalanceModel,
    settings: &RegearSettingModel,
    now: DateTime<Utc>,
) -> RegearRequestBalanceModel {
    let elapsed = now.signed_duration_since(balance.weekly_last_topup_at.with_timezone(&Utc));
    let elapsed_weeks = elapsed.num_seconds() / SECONDS_PER_WEEK;
    if elapsed_weeks < 1 {
        return balance;
    }
    let topped = balance.weekly_balance
        + (elapsed_weeks as i32).saturating_mul(settings.weekly_request_topup_amount);
    let new_balance = topped.min(settings.weekly_request_cap).max(0);
    let new_anchor =
        balance.weekly_last_topup_at + ChronoDuration::seconds(elapsed_weeks * SECONDS_PER_WEEK);
    RegearRequestBalanceModel {
        weekly_balance: new_balance,
        weekly_last_topup_at: new_anchor,
        ..balance
    }
}

/// Inserts the caller's balance row if it does not exist yet.
///
/// `ON CONFLICT DO NOTHING` on the primary key makes two concurrent first-time callers safe: the
/// loser inserts nothing and simply reads the winner's row afterwards.
async fn ensure_balance_row<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
    now: DateTime<Utc>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let active = RegearRequestBalanceActiveModel {
        user_id: Set(user_id),
        weekly_balance: Set(settings.weekly_request_topup_amount.max(0)),
        weekly_last_topup_at: Set(now.into()),
        bonus_balance: Set(0),
        created_at: Set(now.into()),
        updated_at: Set(now.into()),
    };
    RegearRequestBalanceEntity::insert(active)
        .on_conflict(
            OnConflict::column(RegearRequestBalanceColumn::UserId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(db)
        .await?;
    Ok(())
}

/// Loads the caller's balance row, creating it on first need, and applies the lazy weekly
/// top-up, persisting the advance if it changed anything.
///
/// A brand-new row starts at `weekly_request_topup_amount` (not zero) so a first-time member (or
/// one whose row simply didn't exist before this feature shipped) has usable credit immediately
/// rather than waiting a full week for their first top-up.
///
/// Safe under concurrency: the first insert is `ON CONFLICT DO NOTHING`, and the top-up is a
/// compare-and-set on the previous anchor, so two callers that both see an elapsed week apply
/// exactly one top-up.
///
/// # Errors
///
/// Returns [`AppError::Database`] on DB failure.
pub async fn get_or_create_balance<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
) -> Result<RegearRequestBalanceModel, AppError>
where
    C: ConnectionTrait,
{
    let now = Utc::now();
    ensure_balance_row(db, settings, user_id, now).await?;

    // A lost compare-and-set means another caller advanced the anchor first; re-read and retry.
    // Two attempts are plenty: after the winner's advance there is nothing left to apply.
    for _ in 0..3 {
        let balance = RegearRequestBalanceEntity::find()
            .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::Internal(format!("regear balance row for user {user_id} vanished"))
            })?;

        let advanced = apply_weekly_topup(balance.clone(), settings, now);
        if advanced.weekly_balance == balance.weekly_balance
            && advanced.weekly_last_topup_at == balance.weekly_last_topup_at
        {
            return Ok(balance);
        }

        let swapped = RegearRequestBalanceEntity::update_many()
            .col_expr(
                RegearRequestBalanceColumn::WeeklyBalance,
                Expr::value(advanced.weekly_balance),
            )
            .col_expr(
                RegearRequestBalanceColumn::WeeklyLastTopupAt,
                Expr::value(advanced.weekly_last_topup_at),
            )
            .col_expr(
                RegearRequestBalanceColumn::UpdatedAt,
                Expr::value(DateTimeWithTimeZone::from(now)),
            )
            .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
            .filter(RegearRequestBalanceColumn::WeeklyLastTopupAt.eq(balance.weekly_last_topup_at))
            .exec(db)
            .await?;
        if swapped.rows_affected == 1 {
            return Ok(RegearRequestBalanceModel {
                updated_at: now.into(),
                ..advanced
            });
        }
    }
    Err(AppError::Conflict(
        "regear balance is being updated concurrently; retry".to_string(),
    ))
}

/// Runs one guarded `UPDATE ... SET col = col - 1 WHERE user_id = $1 AND col > 0` and reports
/// whether a credit was actually taken.
async fn decrement_pool<C>(
    db: &C,
    user_id: i64,
    column: RegearRequestBalanceColumn,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let result = RegearRequestBalanceEntity::update_many()
        .col_expr(column, Expr::col(column).sub(1))
        .col_expr(
            RegearRequestBalanceColumn::UpdatedAt,
            Expr::value(DateTimeWithTimeZone::from(Utc::now())),
        )
        .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
        .filter(column.gt(0))
        .exec(db)
        .await?;
    Ok(result.rows_affected == 1)
}

/// Consumes exactly one request credit for `user_id`: bonus pool first, then weekly.
///
/// The decrement is a conditional `UPDATE ... WHERE pool > 0`, so concurrent callers can never
/// spend more credits than exist: the database serialises them on the row and the loser matches
/// zero rows.
///
/// # Errors
///
/// Returns [`AppError::Validation`] if both pools are at zero.
pub async fn consume_request_credit<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    get_or_create_balance(db, settings, user_id).await?;
    if decrement_pool(db, user_id, RegearRequestBalanceColumn::BonusBalance).await?
        || decrement_pool(db, user_id, RegearRequestBalanceColumn::WeeklyBalance).await?
    {
        return Ok(());
    }
    Err(AppError::Validation(
        "no regear requests remaining (0 weekly, 0 bonus)".to_string(),
    ))
}

/// Credits `amount` requests to `user_id`'s bonus pool, clamped at `bonus_request_cap` — even a
/// single large giveaway win cannot push the pool past the admin-configured ceiling.
///
/// The add-and-clamp is a single `UPDATE`, so concurrent credits never lose an increment.
///
/// # Errors
///
/// Returns [`AppError::Database`] on DB failure.
pub async fn credit_bonus<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
    amount: i32,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if amount <= 0 {
        return Ok(());
    }
    get_or_create_balance(db, settings, user_id).await?;
    let cap = settings.bonus_request_cap;
    let raised = Expr::col(RegearRequestBalanceColumn::BonusBalance).add(amount);
    let clamped = Expr::case(
        Expr::col(RegearRequestBalanceColumn::BonusBalance).gt(cap - amount),
        Expr::value(cap),
    )
    .finally(raised);
    RegearRequestBalanceEntity::update_many()
        .col_expr(RegearRequestBalanceColumn::BonusBalance, clamped.into())
        .col_expr(
            RegearRequestBalanceColumn::UpdatedAt,
            Expr::value(DateTimeWithTimeZone::from(Utc::now())),
        )
        .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
        .exec(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(topup: i32, weekly_cap: i32, bonus_cap: i32) -> RegearSettingModel {
        RegearSettingModel {
            id: 1,
            weekly_request_topup_amount: topup,
            weekly_request_cap: weekly_cap,
            bonus_request_cap: bonus_cap,
            enabled_slots_mask: 0,
            pricing_location: "Caerleon".to_string(),
            pricing_fallback_strategy: "cheapest_any".to_string(),
            updated_at: Utc::now().into(),
            updated_by_user_id: None,
        }
    }

    fn balance(weekly: i32, anchor: DateTimeWithTimeZone) -> RegearRequestBalanceModel {
        RegearRequestBalanceModel {
            user_id: 1,
            weekly_balance: weekly,
            weekly_last_topup_at: anchor,
            bonus_balance: 0,
            created_at: anchor,
            updated_at: anchor,
        }
    }

    #[test]
    fn no_topup_before_a_full_week_elapses() {
        let now = Utc::now();
        let anchor: DateTimeWithTimeZone = (now - ChronoDuration::days(3)).into();
        let advanced = apply_weekly_topup(balance(1, anchor), &settings(2, 4, 10), now);
        assert_eq!(advanced.weekly_balance, 1);
        assert_eq!(advanced.weekly_last_topup_at, anchor);
    }

    #[test]
    fn one_elapsed_week_tops_up_and_advances_anchor_exactly() {
        let now = Utc::now();
        let anchor: DateTimeWithTimeZone = (now - ChronoDuration::days(8)).into();
        let advanced = apply_weekly_topup(balance(0, anchor), &settings(2, 4, 10), now);
        assert_eq!(advanced.weekly_balance, 2);
        assert_eq!(
            advanced.weekly_last_topup_at,
            anchor + ChronoDuration::seconds(SECONDS_PER_WEEK)
        );
    }

    #[test]
    fn multiple_elapsed_weeks_multiply() {
        let now = Utc::now();
        let anchor: DateTimeWithTimeZone = (now - ChronoDuration::days(22)).into();
        let advanced = apply_weekly_topup(balance(0, anchor), &settings(2, 10, 10), now);
        // 3 whole weeks elapsed.
        assert_eq!(advanced.weekly_balance, 6);
        assert_eq!(
            advanced.weekly_last_topup_at,
            anchor + ChronoDuration::seconds(3 * SECONDS_PER_WEEK)
        );
    }

    #[test]
    fn topup_clamps_at_the_cap() {
        let now = Utc::now();
        let anchor: DateTimeWithTimeZone = (now - ChronoDuration::days(30)).into();
        let advanced = apply_weekly_topup(balance(3, anchor), &settings(2, 4, 10), now);
        assert_eq!(advanced.weekly_balance, 4);
    }

    #[test]
    fn balance_above_a_lowered_cap_is_left_alone_until_next_topup() {
        let now = Utc::now();
        let anchor: DateTimeWithTimeZone = (now - ChronoDuration::days(1)).into();
        // Cap was lowered to 2 while the user sits at 5; less than a week has elapsed, so the
        // existing balance rides as-is rather than being clamped down immediately.
        let advanced = apply_weekly_topup(balance(5, anchor), &settings(2, 2, 10), now);
        assert_eq!(advanced.weekly_balance, 5);
    }

    // --- ledger invariants (DB-backed) ---

    use sea_orm::DatabaseConnection;

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    async fn set_pools(db: &DatabaseConnection, user_id: i64, weekly: i32, bonus: i32) {
        RegearRequestBalanceEntity::update_many()
            .col_expr(
                RegearRequestBalanceColumn::WeeklyBalance,
                Expr::value(weekly),
            )
            .col_expr(RegearRequestBalanceColumn::BonusBalance, Expr::value(bonus))
            .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
            .exec(db)
            .await
            .expect("set pools");
    }

    async fn pools(db: &DatabaseConnection, user_id: i64) -> (i32, i32) {
        let row = RegearRequestBalanceEntity::find_by_id(user_id)
            .one(db)
            .await
            .expect("load balance")
            .expect("balance row");
        (row.weekly_balance, row.bonus_balance)
    }

    #[tokio::test]
    async fn first_read_creates_exactly_one_row_and_repeats_are_idempotent() {
        let db = seed_db().await;
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        let first = get_or_create_balance(&db, &settings, 7).await.unwrap();
        let second = get_or_create_balance(&db, &settings, 7).await.unwrap();
        assert_eq!(first.weekly_balance, settings.weekly_request_topup_amount);
        assert_eq!(second.weekly_balance, first.weekly_balance);
        let rows = RegearRequestBalanceEntity::find().all(&db).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn consume_spends_bonus_first_then_weekly_and_never_goes_negative() {
        let db = seed_db().await;
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        get_or_create_balance(&db, &settings, 1).await.unwrap();
        set_pools(&db, 1, 1, 1).await;

        consume_request_credit(&db, &settings, 1).await.unwrap();
        assert_eq!(pools(&db, 1).await, (1, 0), "bonus pool is spent first");
        consume_request_credit(&db, &settings, 1).await.unwrap();
        assert_eq!(pools(&db, 1).await, (0, 0));
        for _ in 0..3 {
            let err = consume_request_credit(&db, &settings, 1).await.unwrap_err();
            assert!(matches!(err, AppError::Validation(_)));
        }
        assert_eq!(pools(&db, 1).await, (0, 0), "balance must not go negative");
    }

    #[tokio::test]
    async fn consume_with_one_credit_left_succeeds_exactly_once() {
        let db = seed_db().await;
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        get_or_create_balance(&db, &settings, 2).await.unwrap();
        set_pools(&db, 2, 1, 0).await;

        let mut ok = 0;
        for _ in 0..5 {
            if consume_request_credit(&db, &settings, 2).await.is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 1);
    }

    #[tokio::test]
    async fn credit_bonus_adds_and_clamps_at_the_cap_in_one_statement() {
        let db = seed_db().await;
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        credit_bonus(&db, &settings, 3, 1).await.unwrap();
        assert_eq!(pools(&db, 3).await.1, 1.min(settings.bonus_request_cap));
        credit_bonus(&db, &settings, 3, settings.bonus_request_cap + 10)
            .await
            .unwrap();
        assert_eq!(pools(&db, 3).await.1, settings.bonus_request_cap);
        credit_bonus(&db, &settings, 3, 0).await.unwrap();
        assert_eq!(pools(&db, 3).await.1, settings.bonus_request_cap);
    }

    #[tokio::test]
    async fn weekly_topup_is_applied_once_per_elapsed_week() {
        let db = seed_db().await;
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        get_or_create_balance(&db, &settings, 4).await.unwrap();
        set_pools(&db, 4, 0, 0).await;
        let anchor: DateTimeWithTimeZone = (Utc::now() - ChronoDuration::days(8)).into();
        RegearRequestBalanceEntity::update_many()
            .col_expr(
                RegearRequestBalanceColumn::WeeklyLastTopupAt,
                Expr::value(anchor),
            )
            .filter(RegearRequestBalanceColumn::UserId.eq(4))
            .exec(&db)
            .await
            .unwrap();

        let first = get_or_create_balance(&db, &settings, 4).await.unwrap();
        let second = get_or_create_balance(&db, &settings, 4).await.unwrap();
        let expected = settings
            .weekly_request_topup_amount
            .min(settings.weekly_request_cap);
        assert_eq!(first.weekly_balance, expected);
        assert_eq!(
            second.weekly_balance, expected,
            "a second read must not top up again"
        );
        assert_eq!(pools(&db, 4).await.0, expected);
    }

    // --- Postgres concurrency (skipped without TEST_DATABASE_URL) ---

    #[tokio::test]
    async fn pg_concurrent_consumers_cannot_overspend_the_balance() {
        let Some(tenant) = backend_migration::testkit::TenantSchema::try_new("it_rgc").await else {
            return;
        };
        let db = tenant.db.clone();
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        get_or_create_balance(&db, &settings, 1).await.unwrap();
        set_pools(&db, 1, 1, 1).await;

        let attempts = 12;
        let mut handles = Vec::new();
        for _ in 0..attempts {
            let db = db.clone();
            let settings = settings.clone();
            handles.push(tokio::spawn(async move {
                consume_request_credit(&db, &settings, 1).await
            }));
        }
        let mut ok = 0;
        for handle in handles {
            if handle.await.unwrap().is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 2, "exactly the two available credits are spent");
        assert_eq!(pools(&db, 1).await, (0, 0));
        tenant.cleanup().await;
    }

    #[tokio::test]
    async fn pg_concurrent_first_reads_create_a_single_row() {
        let Some(tenant) = backend_migration::testkit::TenantSchema::try_new("it_rgf").await else {
            return;
        };
        let db = tenant.db.clone();
        let settings = backend_entities::regear::load_settings(&db).await.unwrap();
        let mut handles = Vec::new();
        for _ in 0..8 {
            let db = db.clone();
            let settings = settings.clone();
            handles.push(tokio::spawn(async move {
                get_or_create_balance(&db, &settings, 9).await
            }));
        }
        for handle in handles {
            handle.await.unwrap().expect("no primary key race");
        }
        assert_eq!(
            RegearRequestBalanceEntity::find()
                .all(&db)
                .await
                .unwrap()
                .len(),
            1
        );
        tenant.cleanup().await;
    }
}
