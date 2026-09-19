//! `Economy` routing module.
//!
//! Three endpoints, all gated on `intel.report.view` (the same officer-level
//! combat/economy reporting bucket already used by the guild/player report
//! endpoints and the `fingerprints`/`enemies` drill-downs):
//! - `GET /battles/{battle_id}` — one battle's trade-and-cost view.
//! - `GET /fights/{fight_id}` — one fight's segments summed into one total.
//! - `GET /events/{event_id}` — the real event-level P&L.
//!
//! Nested at `/economy` in `modules::mod`, so the full paths are
//! `/api/economy/battles/{battle_id}`, `/api/economy/fights/{fight_id}`,
//! `/api/economy/events/{event_id}`.

use axum::{Extension, Json, Router, extract::Path, routing::get};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::{
    ApiResponse, ApiResponseBattleEconomy, ApiResponseEventEconomy, ApiResponseFightEconomy,
};

use super::models::{BattleEconomyView, EventEconomyView, FightEconomyView};
use super::service::EconomyService;

/// Creates the router for the `economy` module.
pub fn router() -> Router {
    Router::new()
        .route("/battles/{battle_id}", get(get_battle_economy))
        .route("/fights/{fight_id}", get(get_fight_economy))
        .route("/events/{event_id}", get(get_event_economy))
}

/// Get one battle's trade-and-cost view.
#[utoipa::path(
    get,
    path = "/api/economy/battles/{battle_id}",
    tag = "economy",
    summary = "Get one battle's trade-and-cost view",
    description = "Reads the battle's `battle_loss_estimates` row verbatim, plus a derived \
        `trade_net` (`enemy_estimated_loss - friendly_estimated_loss`). `enemy_estimated_loss` and \
        `trade_net` are trade indicators only — never income; this module's income is declared \
        via `splits`, never inferred from combat.",
    security(("session_cookie" = ["intel.report.view"])),
    params(("battle_id" = i64, Path, description = "Canonical AlbionBB battle id")),
    responses(
        (status = 200, description = "Battle economy retrieved successfully", body = ApiResponseBattleEconomy),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails),
        (status = 404, description = "No loss estimate has been computed yet for this battle", body = ProblemDetails)
    )
)]
pub async fn get_battle_economy(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(battle_id): Path<i64>,
) -> Result<Json<ApiResponse<BattleEconomyView>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let view = EconomyService::new()
        .get_battle_economy(&db, battle_id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Get one fight's trade-and-cost view, summed across its segments.
#[utoipa::path(
    get,
    path = "/api/economy/fights/{fight_id}",
    tag = "economy",
    summary = "Get one fight's trade-and-cost view",
    description = "Sums every segment's `battle_loss_estimates` row into one fight-level total \
        — a battle belongs to exactly one fight (`fight_battles.battle_id` is unique table-wide), \
        so this can never double-count. A segment with no estimate yet contributes zero rather \
        than blocking the view; `segments_total`/`segments_priced` on the response say how \
        complete the coverage is. `pricing_location` is `None` when priced segments disagree on \
        location; `priced_at` is the oldest among them. `enemy_estimated_loss` and `trade_net` \
        are trade indicators only — never income.",
    security(("session_cookie" = ["intel.report.view"])),
    params(("fight_id" = i64, Path, description = "Canonical fight id")),
    responses(
        (status = 200, description = "Fight economy retrieved successfully", body = ApiResponseFightEconomy),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails),
        (status = 404, description = "No fight exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_fight_economy(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(fight_id): Path<i64>,
) -> Result<Json<ApiResponse<FightEconomyView>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let view = EconomyService::new()
        .get_fight_economy(&db, fight_id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Get one event's real P&L.
#[utoipa::path(
    get,
    path = "/api/economy/events/{event_id}",
    tag = "economy",
    summary = "Get one event's real P&L",
    description = "Every income figure here comes from the real ledger (`splits.net_value` for \
        completed splits, `regear_deaths.final_amount` for approved regears) — never from a \
        combat estimate. `net = income_total - regear_paid_total` is the only real \
        money-movement figure; `friendly_combat_loss_total` and `regear_coverage_pct` are \
        informational context only and are never subtracted into `net`. An event with no \
        splits/regears/fights at all returns all-zero figures, not an error.",
    security(("session_cookie" = ["intel.report.view"])),
    params(("event_id" = i64, Path, description = "Event id")),
    responses(
        (status = 200, description = "Event economy retrieved successfully", body = ApiResponseEventEconomy),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails),
        (status = 404, description = "No event exists with this id", body = ProblemDetails)
    )
)]
pub async fn get_event_economy(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(event_id): Path<i64>,
) -> Result<Json<ApiResponse<EventEconomyView>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    let view = EconomyService::new()
        .get_event_economy(&db, event_id)
        .await?;
    Ok(Json(ApiResponse::new(view)))
}
