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
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter,
};

use crate::errors::AppError;

use super::entities::{
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

/// Loads the caller's balance row, creating it on first need, and applies the lazy weekly
/// top-up, persisting the advance if it changed anything.
///
/// A brand-new row starts at `weekly_request_topup_amount` (not zero) so a first-time member (or
/// one whose row simply didn't exist before this feature shipped) has usable credit immediately
/// rather than waiting a full week for their first top-up.
///
/// # Errors
///
/// Returns [`AppError::Database`] on DB failure.
pub(crate) async fn get_or_create_balance<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
) -> Result<RegearRequestBalanceModel, AppError>
where
    C: ConnectionTrait,
{
    let now = Utc::now();
    let existing = RegearRequestBalanceEntity::find()
        .filter(RegearRequestBalanceColumn::UserId.eq(user_id))
        .one(db)
        .await?;

    let balance = match existing {
        Some(model) => model,
        None => {
            let active = RegearRequestBalanceActiveModel {
                user_id: Set(user_id),
                weekly_balance: Set(settings.weekly_request_topup_amount.max(0)),
                weekly_last_topup_at: Set(now.into()),
                bonus_balance: Set(0),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
            };
            return Ok(active.insert(db).await?);
        }
    };

    let advanced = apply_weekly_topup(balance.clone(), settings, now);
    if advanced.weekly_balance == balance.weekly_balance
        && advanced.weekly_last_topup_at == balance.weekly_last_topup_at
    {
        return Ok(balance);
    }

    let mut active: RegearRequestBalanceActiveModel = advanced.into();
    active.updated_at = Set(now.into());
    Ok(active.update(db).await?)
}

/// Consumes exactly one request credit for `user_id`: bonus pool first, then weekly.
///
/// # Errors
///
/// Returns [`AppError::Validation`] if both pools are at zero.
pub(crate) async fn consume_request_credit<C>(
    db: &C,
    settings: &RegearSettingModel,
    user_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let balance = get_or_create_balance(db, settings, user_id).await?;
    let mut active: RegearRequestBalanceActiveModel = balance.clone().into();
    if balance.bonus_balance > 0 {
        active.bonus_balance = Set(balance.bonus_balance - 1);
    } else if balance.weekly_balance > 0 {
        active.weekly_balance = Set(balance.weekly_balance - 1);
    } else {
        return Err(AppError::Validation(
            "no regear requests remaining (0 weekly, 0 bonus)".to_string(),
        ));
    }
    active.updated_at = Set(Utc::now().into());
    active.update(db).await?;
    Ok(())
}

/// Credits `amount` requests to `user_id`'s bonus pool, clamped at `bonus_request_cap` — even a
/// single large giveaway win cannot push the pool past the admin-configured ceiling.
///
/// # Errors
///
/// Returns [`AppError::Database`] on DB failure.
pub(crate) async fn credit_bonus<C>(
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
    let balance = get_or_create_balance(db, settings, user_id).await?;
    let mut active: RegearRequestBalanceActiveModel = balance.clone().into();
    active.bonus_balance = Set((balance.bonus_balance + amount).min(settings.bonus_request_cap));
    active.updated_at = Set(Utc::now().into());
    active.update(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::prelude::DateTimeWithTimeZone;

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
}
