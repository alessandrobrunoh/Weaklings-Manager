//! Combat routing module.
//!
//! Exposes the Item Power calculator. Every handler here is a read: nothing in this module writes
//! to the database, which is why none of them log to the audit trail.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::{
    ApiResponse, ApiResponseCombatDataset, ApiResponseItemPower, ApiResponseMasteryGroups,
};

use super::dataset::dataset_version;
use super::models::{
    CombatDatasetView, CreateScenarioRequest, ItemPowerRequest, ItemPowerView, MasteryGroupsView,
    RunDetail, ScenarioDetail, ScenarioSummary, SimulateRequest, SimulateView,
    UpdateScenarioRequest,
};
use super::service::CombatService;
use super::sim;

/// Builds the combat router.
pub fn router() -> Router {
    Router::new()
        .route("/dataset", get(get_dataset))
        .route("/mastery-groups", get(get_mastery_groups))
        .route("/tests", get(list_scenarios).post(create_scenario))
        .route("/tests/{id}", get(get_scenario).patch(update_scenario))
        .route("/tests/{id}/versions", post(create_scenario_version))
        .route("/tests/{id}/archive", post(archive_scenario))
        .route("/tests/{id}/unarchive", post(unarchive_scenario))
        .route("/tests/{id}/run", post(run_scenario))
        .route("/tests/{id}/runs", get(list_runs))
        .route("/runs/{run_id}", get(get_run))
        .route("/item-power", post(post_item_power))
        .route("/members/{user_id}/item-power", get(get_member_item_power))
        .route("/simulate", post(post_simulate))
}

/// Reports which ao-bin-dumps commit the bundled combat data came from.
///
/// Every combat response carries this stamp; the endpoint exists so a client can show it once, in
/// a footer, rather than repeating it beside every number.
#[utoipa::path(
    get,
    path = "/api/combat/dataset",
    tag = "combat",
    summary = "Get the bundled combat dataset's provenance",
    description = "Returns the ao-bin-dumps commit the bundled Albion combat data was generated \
                   from, together with how many items, spells and Destiny Board nodes it covers. \
                   The data is compiled into the binary and refreshed by hand after a patch, so \
                   this is what tells a reader how current the numbers are.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Dataset provenance", body = ApiResponseCombatDataset),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn get_dataset(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
) -> Result<Json<ApiResponse<CombatDatasetView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    Ok(Json(ApiResponse::new(CombatService::dataset())))
}

/// Reports which equippable base identifiers have a family mastery node, and which one.
///
/// A client uses this to attach a "family mastery" level control to one specific weapon or armor
/// entry — the exact identifier it is already rendering — without having to reconcile its own
/// weapon/armor grouping against the game's Destiny Board.
#[utoipa::path(
    get,
    path = "/api/combat/mastery-groups",
    tag = "combat",
    summary = "Get the item-to-family-mastery mapping",
    description = "Maps every equippable base identifier that has a Destiny Board specialization \
                   to the family mastery node above it, e.g. `2H_POLEHAMMER -> COMBAT_HAMMERS`. \
                   Capes, bags and gathering gear are absent: they have no combat specialization.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Item to mastery-node mapping", body = ApiResponseMasteryGroups),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn get_mastery_groups(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
) -> Result<Json<ApiResponse<MasteryGroupsView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    Ok(Json(ApiResponse::new(MasteryGroupsView {
        dataset_version: dataset_version().clone(),
        groups: CombatService::mastery_groups(),
    })))
}

/// Computes Item Power for a loadout described inline.
#[utoipa::path(
    post,
    path = "/api/combat/item-power",
    tag = "combat",
    summary = "Calculate Item Power for an ad-hoc loadout",
    description = "Item Power = base(tier, enchantment) + quality bonus + the Destiny Board \
                   bonuses of whichever specialization levels `spec` selects. The response \
                   itemises every contribution, so each point can be traced to the node that \
                   granted it. `mastery_levels_known` is false while no family mastery level is \
                   recorded, which makes the figure a lower bound rather than the number the game \
                   would show.",
    security(("session_cookie" = [])),
    request_body = ItemPowerRequest,
    responses(
        (status = 200, description = "Item Power breakdown", body = ApiResponseItemPower),
        (status = 400, description = "Unusable loadout or specialization source", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn post_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(request): Json<ItemPowerRequest>,
) -> Result<Json<ApiResponse<ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    let view = CombatService::new().item_power(&db, &request).await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Computes what one member's Item Power would be on a stored build.
#[utoipa::path(
    get,
    path = "/api/combat/members/{user_id}/item-power",
    tag = "combat",
    summary = "Calculate a member's Item Power on a build",
    description = "Scores a stored build with one member's Destiny Board levels — the \"could this \
                   person fly this?\" question. `at_max_spec` is the same build with every node at \
                   100, and `readiness` is the ratio between them, which is comparable across \
                   builds in a way raw Item Power is not.",
    security(("session_cookie" = [])),
    params(
        ("user_id" = i64, Path, description = "Internal user ID"),
        MemberItemPowerParams
    ),
    responses(
        (status = 200, description = "Item Power breakdown", body = ApiResponseItemPower),
        (status = 400, description = "Missing build_id or unusable parameters", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Build not found", body = ProblemDetails)
    )
)]
async fn get_member_item_power(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(user_id): Path<i64>,
    Query(params): Query<MemberItemPowerParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ItemPowerView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    let loadout = super::service::parse_loadout(params.loadout.as_deref())?;
    let view = CombatService::new()
        .build_item_power(
            &db,
            params.build_id,
            loadout,
            params.spec.unwrap_or_default(),
            Some(user_id),
            params.level,
        )
        .await?;
    Ok(Json(ApiResponse::new(view)))
}

/// Query parameters for a member's Item Power on a build.
#[derive(Debug, Clone, serde::Deserialize, utoipa::IntoParams)]
pub struct MemberItemPowerParams {
    /// The build to score. Required.
    pub build_id: i64,
    /// Which loadout to score: `main` (the default) or `swap`.
    #[serde(default)]
    pub loadout: Option<String>,
    /// Which levels to apply. Defaults to the member's own.
    #[serde(default)]
    pub spec: Option<super::models::SpecSource>,
    /// The flat level for `spec=fixed`.
    #[serde(default)]
    pub level: Option<i32>,
}

/// Resolves a declared burst window: every cast's damage, healing and crowd control, after area
/// escalation, focus fire, the zerg debuff and crowd-control diminishing returns.
#[utoipa::path(
    post,
    path = "/api/combat/simulate",
    tag = "combat",
    summary = "Resolve a declared burst window",
    description = "No geometry: the caller declares, per cast, how many targets it hits and the \\
                   cross-cutting context (concurrent attackers on the implied target, prior crowd \\
                   control on it) rather than the engine tracking positions. Every damage and \\
                   healing figure is the spell's baseline value — the caster's own Item Power does \\
                   not yet scale it, since that scaling has not been calibrated against the live \\
                   game (see `combat.ip`'s docs). `unknown_spells` lists spell ids not in the \\
                   bundled dataset at all; each cast's own `unsupported` list names effects on a \\
                   *known* spell this resolver could not turn into numbers — a conditional branch, \\
                   or an effect type (`channelingspell`, `damageshield`, `buffovertime`, …) not yet \\
                   modelled. Both are reported, never silently dropped from a total.",
    security(("session_cookie" = [])),
    request_body = SimulateRequest,
    responses(
        (status = 200, description = "The resolved burst", body = crate::responses::ApiResponseSimulate),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn post_simulate(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Json(request): Json<SimulateRequest>,
) -> Result<Json<ApiResponse<SimulateView>>, AppError> {
    user.require(&perms, Permission::CombatCalculatorUse)
        .await?;
    let result = sim::simulate(&request.casts, request.sides);
    Ok(Json(ApiResponse::new(SimulateView {
        result,
        dataset_version: dataset_version().clone(),
    })))
}

/// Query parameters for listing combat test scenarios.
#[derive(Debug, Clone, Default, serde::Deserialize, utoipa::IntoParams)]
pub struct ListScenariosParams {
    /// When `true`, include archived versions. Defaults to `false`.
    #[serde(
        default,
        deserialize_with = "crate::serde_helpers::optional_bool_from_string_or_bool"
    )]
    pub include_archived: Option<bool>,
}

/// Lists combat test scenarios, most recently updated first.
#[utoipa::path(
    get,
    path = "/api/combat/tests",
    tag = "combat",
    summary = "List combat test scenarios",
    description = "Every saved combat test version, newest-updated first. Requires \
                   `combat.tests.view`.",
    security(("session_cookie" = [])),
    params(ListScenariosParams),
    responses(
        (status = 200, description = "Scenario versions", body = crate::responses::ApiResponseScenarioSummaryList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_scenarios(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Query(params): Query<ListScenariosParams>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<ScenarioSummary>>>, AppError> {
    user.require(&perms, Permission::CombatTestsView).await?;
    let scenarios = CombatService::new()
        .list_scenarios(&db, params.include_archived.unwrap_or(false))
        .await?;
    Ok(Json(ApiResponse::new(scenarios)))
}

/// Creates a new combat test scenario at version 1.
#[utoipa::path(
    post,
    path = "/api/combat/tests",
    tag = "combat",
    summary = "Create a combat test scenario",
    description = "Requires `combat.tests.manage`.",
    security(("session_cookie" = [])),
    request_body = CreateScenarioRequest,
    responses(
        (status = 200, description = "The created scenario", body = crate::responses::ApiResponseScenarioDetail),
        (status = 400, description = "Empty name", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.tests.manage", body = ProblemDetails),
        (status = 409, description = "Name already taken", body = ProblemDetails)
    )
)]
async fn create_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(request): Json<CreateScenarioRequest>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsManage).await?;
    let scenario = CombatService::new()
        .create_scenario(&db, user.user_id, &request)
        .await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Reads one combat test scenario version, with its definition and version siblings.
#[utoipa::path(
    get,
    path = "/api/combat/tests/{id}",
    tag = "combat",
    summary = "Get a combat test scenario",
    description = "Requires `combat.tests.view`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    responses(
        (status = 200, description = "The scenario version", body = crate::responses::ApiResponseScenarioDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails)
    )
)]
async fn get_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsView).await?;
    let scenario = CombatService::new().get_scenario(&db, id).await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Edits a scenario version's name and/or definition in place — no new version is created.
#[utoipa::path(
    patch,
    path = "/api/combat/tests/{id}",
    tag = "combat",
    summary = "Edit a combat test scenario in place",
    description = "A test scenario is a scratch document, unlike a build or a comp: every group \
                   or timeline tweak edits the same version rather than creating a new one. \
                   Renaming moves every version sharing the old name. Requires \
                   `combat.tests.manage`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    request_body = UpdateScenarioRequest,
    responses(
        (status = 200, description = "The updated scenario", body = crate::responses::ApiResponseScenarioDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.tests.manage", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails),
        (status = 409, description = "Name already taken", body = ProblemDetails)
    )
)]
async fn update_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(request): Json<UpdateScenarioRequest>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsManage).await?;
    let scenario = CombatService::new()
        .update_scenario(&db, id, &request)
        .await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Creates a new version by cloning this one's current definition.
#[utoipa::path(
    post,
    path = "/api/combat/tests/{id}/versions",
    tag = "combat",
    summary = "Create a new combat test scenario version",
    description = "Clones the current definition into a new version, for keeping this exact state \
                   around to compare against — deliberately separate from the in-place edit that \
                   `PATCH .../tests/{id}` does. Requires `combat.tests.manage`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Source scenario version ID")),
    responses(
        (status = 200, description = "The new version", body = crate::responses::ApiResponseScenarioDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.tests.manage", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails)
    )
)]
async fn create_scenario_version(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsManage).await?;
    let scenario = CombatService::new()
        .create_scenario_version(&db, id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Archives a scenario version: hidden from the default list, but never deleted.
#[utoipa::path(
    post,
    path = "/api/combat/tests/{id}/archive",
    tag = "combat",
    summary = "Archive a combat test scenario",
    description = "Requires `combat.tests.manage`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    responses(
        (status = 200, description = "The archived scenario", body = crate::responses::ApiResponseScenarioDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.tests.manage", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails)
    )
)]
async fn archive_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsManage).await?;
    let scenario = CombatService::new()
        .set_scenario_archived(&db, id, true)
        .await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Reverses [`archive_scenario`].
#[utoipa::path(
    post,
    path = "/api/combat/tests/{id}/unarchive",
    tag = "combat",
    summary = "Unarchive a combat test scenario",
    description = "Requires `combat.tests.manage`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    responses(
        (status = 200, description = "The unarchived scenario", body = crate::responses::ApiResponseScenarioDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.tests.manage", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails)
    )
)]
async fn unarchive_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ScenarioDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsManage).await?;
    let scenario = CombatService::new()
        .set_scenario_archived(&db, id, false)
        .await?;
    Ok(Json(ApiResponse::new(scenario)))
}

/// Runs a scenario version now and pins the result.
#[utoipa::path(
    post,
    path = "/api/combat/tests/{id}/run",
    tag = "combat",
    summary = "Run a combat test scenario",
    description = "Resolves the scenario's declared groups and timeline through the same engine \
                   `POST /api/combat/simulate` uses, but threads each named target's hit points \
                   down over time — see `combat::scenario`'s docs for what that adds. The result \
                   is pinned with the engine version and dataset commit at run time, then \
                   returned. Requires `combat.tests.view`: running a saved test is self-service, \
                   like the Item Power calculator.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    responses(
        (status = 200, description = "The pinned run", body = crate::responses::ApiResponseRunDetail),
        (status = 400, description = "Stored scenario definition is unreadable", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Scenario not found", body = ProblemDetails)
    )
)]
async fn run_scenario(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<RunDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsView).await?;
    let run = CombatService::new()
        .run_scenario(&db, id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(run)))
}

/// Lists a scenario's past runs, most recent first.
#[utoipa::path(
    get,
    path = "/api/combat/tests/{id}/runs",
    tag = "combat",
    summary = "List a combat test scenario's past runs",
    description = "Requires `combat.tests.view`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Scenario version ID")),
    responses(
        (status = 200, description = "Past runs", body = crate::responses::ApiResponseRunSummaryList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_runs(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<super::models::RunSummary>>>, AppError> {
    user.require(&perms, Permission::CombatTestsView).await?;
    let runs = CombatService::new().list_runs(&db, id).await?;
    Ok(Json(ApiResponse::new(runs)))
}

/// Reads one pinned run, with its full resolved result.
#[utoipa::path(
    get,
    path = "/api/combat/runs/{run_id}",
    tag = "combat",
    summary = "Get a pinned combat test run",
    description = "Requires `combat.tests.view`.",
    security(("session_cookie" = [])),
    params(("run_id" = i64, Path, description = "Run ID")),
    responses(
        (status = 200, description = "The pinned run", body = crate::responses::ApiResponseRunDetail),
        (status = 400, description = "Stored run is unreadable", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Run not found", body = ProblemDetails)
    )
)]
async fn get_run(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Path(run_id): Path<i64>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<RunDetail>>, AppError> {
    user.require(&perms, Permission::CombatTestsView).await?;
    let run = CombatService::new().get_run(&db, run_id).await?;
    Ok(Json(ApiResponse::new(run)))
}
