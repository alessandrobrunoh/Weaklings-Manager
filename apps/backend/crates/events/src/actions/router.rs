//! HTTP routes of the action engine.
//!
//! Event action handlers are routed from the events router (`/api/events/...`); the catalogue sits at
//! `/api/actions/catalog`. Only event actions are registered in this slice.

use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::Path,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sea_orm::DatabaseConnection;
use serde::Serialize;

use super::engine::{self, Actor, Failure, Request, Target};
use super::entities::event as event_def;
use super::model::{
    ActionDescriptor, ActionList, ActionRequest, ApiResponseActionCatalog, ApiResponseActionList,
    ApiResponseActionResult, CatalogEntry,
};
use crate::events::lifecycle::{AfterCommit, Cause};
use backend_core::errors::AppError;
use backend_core::responses::ApiResponse;
use backend_identity::auth::{Permission, Permissions, UserContext};
use backend_identity::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantRegistry};

/// Routes mounted under `/api/actions`.
pub fn router() -> Router {
    Router::new().route("/catalog", get(get_action_catalog))
}

/// Body of a `stale_entity` conflict: the fresh list, tagged with its code.
#[derive(Serialize)]
struct StaleBody {
    code: &'static str,
    #[serde(flatten)]
    list: ActionList,
}

async fn actor_of(user: &UserContext, perms: &Permissions, kind: &str) -> Actor {
    engine::actor_for(user, perms, kind).await
}

/// Lists the actions an event allows for the caller.
#[utoipa::path(
    get,
    path = "/api/events/{id}/actions",
    tag = "actions",
    summary = "List the actions available on an event",
    description = "Every registered action with `allowed`, `visible` and the machine reason when refused. Clients render this list instead of re-deriving the rules.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Action descriptors for the event", body = ApiResponseActionList),
        (status = 401, description = "Unauthorized - no active session", body = backend_core::errors::ProblemDetails),
        (status = 404, description = "Event not found", body = backend_core::errors::ProblemDetails)
    )
)]
pub async fn list_event_actions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Extension(CurrentTenantKind(kind)): Extension<CurrentTenantKind>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<ActionList>>, AppError> {
    // Checked before the lookup so a non-viewer learns neither the event's state nor whether it exists.
    user.require(&perms, Permission::EventsView).await?;
    let actor = actor_of(&user, &perms, &kind).await;
    let facts = engine::load_event_facts(&db, &control, &tenant_id, id).await?;
    Ok(Json(ApiResponse::new(engine::event_action_list(
        &facts, &actor,
    ))))
}

/// Lists the collection-level actions of events.
#[utoipa::path(
    get,
    path = "/api/events/actions",
    tag = "actions",
    summary = "List the collection-level event actions",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Collection actions for events", body = ApiResponseActionList),
        (status = 401, description = "Unauthorized - no active session", body = backend_core::errors::ProblemDetails)
    )
)]
pub async fn list_event_collection_actions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
) -> Result<Json<ApiResponse<ActionList>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    Ok(Json(ApiResponse::new(engine::event_collection_list())))
}

/// Runs a collection-level event action. None are registered yet, so every name is unknown.
#[utoipa::path(
    post,
    path = "/api/events/actions/{action}",
    tag = "actions",
    summary = "Run a collection-level event action",
    security(("session_cookie" = [])),
    params(("action" = String, Path, description = "Action id")),
    responses(
        (status = 404, description = "Unknown action", body = backend_core::errors::ProblemDetails)
    )
)]
pub async fn run_event_collection_action(Path(action): Path<String>) -> Result<Response, AppError> {
    Err(AppError::NotFound(format!("Unknown event action {action}")))
}

/// Runs one action on an event.
///
/// A refused action answers 403 or 409 with the denied descriptor as the body, the same entry
/// `GET .../actions` lists for it.
#[utoipa::path(
    post,
    path = "/api/events/{id}/actions/{action}",
    tag = "actions",
    summary = "Run an action on an event",
    description = "Applies the transition in one transaction with the action log row, or answers `noop` when the event is already in the target state. `expected_etag` guards against stale clients (409 `stale_entity`); `idempotency_key` (body or `Idempotency-Key` header) makes retries apply once.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID"),
        ("action" = String, Path, description = "Action id, e.g. `start`")
    ),
    request_body(content = ActionRequest, description = "Optional parameters, revision and idempotency key"),
    responses(
        (status = 200, description = "Action applied, replayed or no-op", body = ApiResponseActionResult),
        (status = 400, description = "Invalid request body or action not executable yet", body = backend_core::errors::ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = backend_core::errors::ProblemDetails),
        (status = 403, description = "Refused: the denied descriptor", body = ActionDescriptor),
        (status = 404, description = "Event or action not found", body = backend_core::errors::ProblemDetails),
        (status = 409, description = "Refused by state, archive or a stale revision", body = ActionDescriptor)
    )
)]
#[allow(
    clippy::too_many_arguments,
    reason = "one extractor per request fact; a wrapper extractor would only move them"
)]
pub async fn run_event_action(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Extension(CurrentTenantKind(kind)): Extension<CurrentTenantKind>,
    headers: HeaderMap,
    Path((id, action)): Path<(i64, String)>,
    body: Bytes,
) -> Result<Response, AppError> {
    let parsed = parse_request(&body)?;
    let header_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let idempotency_key = parsed.idempotency_key.clone().or(header_key);
    let actor = actor_of(&user, &perms, &kind).await;
    let target = Target {
        db: &db,
        control: &control,
        tenant_id: &tenant_id,
    };
    let after = AfterCommit::legacy_propagation(&control, &registry, &tenant_id);
    let request = Request {
        action: &action,
        expected_etag: parsed.expected_etag.as_deref(),
        idempotency_key: idempotency_key.as_deref(),
        params: parsed.params.as_ref(),
    };
    match engine::execute(&target, &actor, id, &request, Cause::Web, &after).await {
        Ok(result) => Ok(Json(ApiResponse::new(result)).into_response()),
        Err(Failure::Denied { status, entry }) => Ok(denied_response(status, &entry)),
        Err(Failure::Stale(list)) => Ok((
            StatusCode::CONFLICT,
            [(header::CONTENT_TYPE, "application/json")],
            Json(StaleBody {
                code: "stale_entity",
                list: *list,
            }),
        )
            .into_response()),
        Err(Failure::Error(error)) => Err(error),
    }
}

fn denied_response(status: u16, entry: &ActionDescriptor) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN);
    (code, Json(entry)).into_response()
}

fn parse_request(body: &[u8]) -> Result<ActionRequest, AppError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(ActionRequest::default());
    }
    serde_json::from_slice(body)
        .map_err(|error| AppError::Validation(format!("invalid action body: {error}")))
}

/// The action catalogue: every registered action, without any entity.
#[utoipa::path(
    get,
    path = "/api/actions/catalog",
    tag = "actions",
    summary = "List every registered action",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Action catalogue", body = ApiResponseActionCatalog),
        (status = 401, description = "Unauthorized - no active session", body = backend_core::errors::ProblemDetails)
    )
)]
pub async fn get_action_catalog() -> Json<ApiResponse<Vec<CatalogEntry>>> {
    let entries = event_def::DEFS
        .iter()
        .map(|def| CatalogEntry {
            entity: def.entity.to_owned(),
            id: def.id.to_owned(),
            label_key: def.label_key.to_owned(),
            style: def.style,
            group: def.group.to_owned(),
            module: def.module.to_owned(),
            from: def.from.iter().map(|state| (*state).to_owned()).collect(),
            to: def.to.map(str::to_owned),
            transport: match def.transport {
                super::model::Transport::Action => "action",
                super::model::Transport::Direct { .. } => "direct",
            }
            .to_owned(),
            implemented: def.implemented,
            requires_confirm: def.confirm.is_some(),
        })
        .collect();
    Json(ApiResponse::new(entries))
}
