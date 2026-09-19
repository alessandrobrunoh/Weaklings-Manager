//! Request/response DTOs for the economy read API.
//!
//! Three distinct views, in increasing order of "how real is this money":
//! - [`BattleEconomyView`] / [`FightEconomyView`]: cost and trade comparison
//!   only, read straight from (or summed from) `battle_loss_estimates`. The
//!   `enemy_*` fields on both are a **trade indicator**, never income — see
//!   `modules::economy`'s module doc comment for the rule this whole module
//!   answers to.
//! - [`EventEconomyView`]: the real P&L, built entirely from already-declared
//!   ledger facts (`splits.net_value`, `regear_deaths.final_amount`). No
//!   combat estimate is ever added to its income side; `friendly_combat_loss_total`
//!   is informational context only, never subtracted into `net`.

use sea_orm::prelude::Decimal;
use serde::Serialize;
use utoipa::ToSchema;

/// Trade-and-cost view for `GET /api/economy/battles/{battle_id}`: one
/// `battle_loss_estimates` row, verbatim, plus a derived comparison field.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BattleEconomyView {
    /// Canonical `AlbionBB` battle id this estimate covers.
    pub battle_id: i64,
    /// Silver value of our side's priced victim equipment. A cost figure —
    /// never income.
    pub friendly_estimated_loss: i64,
    /// How many of our side's victim item stacks actually got a market price.
    pub friendly_priced_items: i32,
    /// How many of our side's victim item stacks existed at all — the
    /// denominator for a coverage percentage
    /// (`friendly_priced_items / friendly_total_items`).
    pub friendly_total_items: i32,
    /// Silver value of the enemy side's priced victim equipment. **This is a
    /// trade indicator only, never income.** It exists so an officer can see
    /// "did we come out ahead in the silver trade", not "how much did we
    /// earn" — this module's income is declared via `splits`, never inferred
    /// from combat.
    pub enemy_estimated_loss: i64,
    /// How many of the enemy side's victim item stacks actually got a market price.
    pub enemy_priced_items: i32,
    /// How many of the enemy side's victim item stacks existed at all — the
    /// denominator for a coverage percentage
    /// (`enemy_priced_items / enemy_total_items`).
    pub enemy_total_items: i32,
    /// The city/market location this estimate was priced against.
    pub pricing_location: String,
    /// RFC 3339. When this estimate was computed — the reproducibility
    /// anchor, since market prices drift.
    pub priced_at: String,
    /// `enemy_estimated_loss - friendly_estimated_loss`. Positive means the
    /// enemy lost more silver than we did in this battle; negative means we
    /// came out behind in the trade. **This is a trade comparison, not a
    /// profit figure** — it is never money that moved, and never enters any
    /// income/revenue total.
    pub trade_net: i64,
}

/// Trade-and-cost view for `GET /api/economy/fights/{fight_id}`: every
/// `battle_loss_estimates` row for the fight's segments, summed. Since a
/// battle belongs to exactly one fight (`fight_battles.battle_id` is unique
/// table-wide), this sum can never double-count a segment.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FightEconomyView {
    /// The canonical fight id this view was computed for.
    pub fight_id: i64,
    /// Sum of `friendly_estimated_loss` across every priced segment. A cost
    /// figure — never income.
    pub friendly_estimated_loss: i64,
    /// Sum of `friendly_priced_items` across every priced segment.
    pub friendly_priced_items: i32,
    /// Sum of `friendly_total_items` across every priced segment.
    pub friendly_total_items: i32,
    /// Sum of `enemy_estimated_loss` across every priced segment. **This is a
    /// trade indicator only, never income** — see [`BattleEconomyView::enemy_estimated_loss`].
    pub enemy_estimated_loss: i64,
    /// Sum of `enemy_priced_items` across every priced segment.
    pub enemy_priced_items: i32,
    /// Sum of `enemy_total_items` across every priced segment.
    pub enemy_total_items: i32,
    /// The pricing location every priced segment agrees on. `None` when the
    /// fight has zero priced segments, or when its priced segments disagree
    /// on location (each segment is priced independently at its own
    /// hydration time, so this can genuinely happen) — a "mixed locations"
    /// state, never resolved by arbitrarily picking one.
    pub pricing_location: Option<String>,
    /// RFC 3339. The OLDEST `priced_at` among this fight's priced segments —
    /// "this whole figure is only as fresh as its stalest input." `None` when
    /// the fight has zero priced segments yet.
    pub priced_at: Option<String>,
    /// Total number of `fight_battles` segments this fight has, priced or not.
    pub segments_total: i64,
    /// How many of those segments actually have a `battle_loss_estimates`
    /// row. `segments_priced < segments_total` means this figure is a
    /// partial view, not an error — a caller can tell "3 of 3 segments
    /// priced" from "1 of 3" instead of silently treating incomplete
    /// coverage as complete.
    pub segments_priced: i64,
    /// `enemy_estimated_loss - friendly_estimated_loss`, computed from the
    /// summed totals above. Positive means the enemy lost more silver than
    /// we did across this fight's priced segments. **This is a trade
    /// comparison, not a profit figure.**
    pub trade_net: i64,
}

/// The real P&L view for `GET /api/economy/events/{event_id}`.
///
/// Every income figure here comes from the real ledger (`splits`,
/// `regear_deaths`) — never from a combat estimate. See the module doc
/// comment above and `modules::economy`'s own doc comment for the rule this
/// answers to.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EventEconomyView {
    /// The event this view was computed for.
    pub event_id: i64,
    /// That event's title, joined from `events.title`.
    pub event_title: String,
    /// `SUM(splits.net_value)` for this event's splits with
    /// `status = "completed"` — the only split status whose `net_value`
    /// represents real, realized income. Deliberately excludes
    /// `siphoned_energy_entries` (it carries no `event_id`, and attributing
    /// one to a specific event would require an unreliable timestamp-overlap
    /// guess); the guild-wide `GET /api/intel/report` already covers siphoned
    /// energy in its own broader weekly view, this endpoint is deliberately
    /// event-scoped and narrower.
    #[schema(value_type = String, example = "125000.00")]
    pub income_total: Decimal,
    /// `SUM(regear_deaths.final_amount)` for this event's regear deaths with
    /// `status = "approved"` — the only state where a regear was actually
    /// paid out of the bank.
    #[schema(value_type = String, example = "42000.00")]
    pub regear_paid_total: Decimal,
    /// `SUM(regear_deaths.auto_estimate_total)` across EVERY regear death row
    /// for this event, regardless of status — every death ever logged as
    /// regear-eligible, whether or not it was ultimately paid. Purely
    /// informational context (see `regear_coverage_pct`); never summed into `net`.
    #[schema(value_type = String, example = "60000.00")]
    pub regear_requested_total: Decimal,
    /// `income_total - regear_paid_total`. **The only real money-movement
    /// figure.** Deliberately does NOT subtract `friendly_combat_loss_total`:
    /// a loss that got paid out is already reflected in `regear_paid_total`,
    /// and a loss that never got a regear request was never guild money in
    /// the first place — subtracting it again would double-count.
    #[schema(value_type = String, example = "83000.00")]
    pub net: Decimal,
    /// Sum of `battle_loss_estimates.friendly_estimated_loss` across every
    /// battle belonging to any fight attached to this event. Informational
    /// context only — how costly the fighting was, regardless of whether it
    /// got reimbursed. Never subtracted into `net`.
    pub friendly_combat_loss_total: i64,
    /// `regear_paid_total / friendly_combat_loss_total * 100.0` — what
    /// fraction of our actual combat losses the guild ended up reimbursing.
    /// `None` when `friendly_combat_loss_total` is `0` (never divides by zero).
    pub regear_coverage_pct: Option<f64>,
}
