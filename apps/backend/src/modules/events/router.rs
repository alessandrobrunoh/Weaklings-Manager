//! REST API routes and OpenAPI paths for the events module.

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post, put},
};

use crate::config::Config;
use crate::errors::AppError;
use crate::errors::ProblemDetails;
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::{
    ApiResponse, ApiResponseEventDetail, ApiResponseEventList, ApiResponseEventView,
};
use axum::http::StatusCode;
use sea_orm::EntityTrait;
use std::collections::HashSet;

use super::models::{
    CreateEventRequest, EventDetailView, EventFilters, EventView, ParticipateEventRequest,
    SetParticipantRequest, UpdateEventBattlesRequest, UpdateEventRequest,
};
use super::service::{BattleLinkingContext, EventService};
use crate::modules::admin::models::DiscordRoleView;
use crate::modules::admin::service::AdminService;
use crate::modules::albionbb::client::normalize_server;
use crate::modules::albionbb::service::AlbionBbService;

/// Returns the compiled router containing all event endpoints.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_events).post(create_event))
        .route(
            "/{id}",
            get(get_event).patch(update_event).delete(delete_event),
        )
        .route("/discord-roles", get(list_event_discord_roles))
        .route(
            "/{id}/participate",
            post(participate).delete(cancel_participation),
        )
        .route(
            "/{id}/participants/{user_id}",
            put(set_participant).delete(remove_participant),
        )
        .route("/{id}/start", post(start_event))
        .route("/{id}/stop", post(stop_event))
        .route(
            "/{id}/battles",
            get(list_event_battles).put(replace_event_battles),
        )
}

/// Lists all events (paginated).
///
/// Any authenticated user can list events.
#[utoipa::path(
    get,
    path = "/api/events",
    tag = "events",
    summary = "List events",
    description = "Returns a paginated list of scheduled events. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("page" = Option<u64>, Query, description = "Page number (1-indexed, default: 1)"),
        ("limit" = Option<u64>, Query, description = "Items per page (1-50, default: 10)"),
        ("search" = Option<String>, Query, description = "Case-insensitive title match"),
        ("status" = Option<String>, Query, description = "Session status: scheduled, live, stopped, auto_stopped"),
        ("sort" = Option<String>, Query, description = "Sort column: event_date_utc, title, created_at, status"),
        ("order" = Option<String>, Query, description = "Sort direction: asc (default) or desc"),
        ("date_from" = Option<String>, Query, description = "Inclusive start of event_date_utc (RFC3339)"),
        ("date_to" = Option<String>, Query, description = "Inclusive end of event_date_utc (RFC3339)")
    ),
    responses(
        (status = 200, description = "Events list retrieved successfully", body = ApiResponseEventList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
async fn list_events(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(pagination): Query<PaginationParams>,
    Query(filters): Query<EventFilters>,
) -> Result<Json<ApiResponse<PaginatedData<EventView>>>, AppError> {
    let service = EventService::new();
    let events = service.list_events(&db, pagination, filters).await?;
    Ok(Json(ApiResponse::new(events)))
}

/// Gets a detailed event.
///
/// Any authenticated user can fetch an event.
#[utoipa::path(
    get,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Get event detail",
    description = "Returns the full details of an event including active comp configuration and participants list. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 200, description = "Event details retrieved successfully", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn get_event(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let context = BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    );
    let event = service
        .get_event_detail_with_context(&db, id, &context)
        .await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Creates a new event.
///
/// Requires `events.manage` permission.
#[utoipa::path(
    post,
    path = "/api/events",
    tag = "events",
    summary = "Create an event",
    description = "Creates a new event with a base composition. Requires `events.manage` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateEventRequest, description = "Event details"),
    responses(
        (status = 200, description = "Event created successfully", body = ApiResponseEventView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails)
    )
)]
async fn create_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;

    if !req.discord_role_ids.is_empty() {
        let allowed_role_ids: HashSet<String> = AdminService::discord_roles(&cfg)
            .await?
            .into_iter()
            .map(|role| role.id)
            .collect();
        if let Some(invalid_role_id) = req
            .discord_role_ids
            .iter()
            .find(|role_id| !allowed_role_ids.contains(role_id.trim()))
        {
            return Err(AppError::Validation(format!(
                "Discord role {invalid_role_id} was not found in the configured guild or cannot be selected"
            )));
        }
    }

    let service = EventService::new();
    let event = service.create_event(&db, user.user_id, req).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Lists selectable Discord roles for users who can create events.
#[utoipa::path(
    get,
    path = "/api/events/discord-roles",
    tag = "events",
    summary = "List Discord roles available for event announcements",
    description = "Returns non-managed roles in the configured Discord guild. Requires events.manage.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Discord roles retrieved", body = [DiscordRoleView]),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable or bot token missing", body = ProblemDetails)
    )
)]
async fn list_event_discord_roles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
) -> Result<Json<ApiResponse<Vec<DiscordRoleView>>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_roles(&cfg).await?,
    )))
}

/// Updates an existing event.
///
/// Requires `events.manage` permission.
#[utoipa::path(
    patch,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Update an event",
    description = "Updates an event. Requires `events.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    request_body(content = UpdateEventRequest, description = "Updated event details"),
    responses(
        (status = 200, description = "Event updated successfully", body = ApiResponseEventView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn update_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateEventRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    let service = EventService::new();
    let event = service.update_event(&db, id, req).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Deletes an event.
///
/// Requires `events.manage` permission.
#[utoipa::path(
    delete,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Delete an event",
    description = "Deletes an event. Requires `events.manage` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 204, description = "Event deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn delete_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    let service = EventService::new();
    service.delete_event(&db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Registers or updates participation for the logged-in user.
///
/// Any authenticated user can participate.
#[utoipa::path(
    post,
    path = "/api/events/{id}/participate",
    tag = "events",
    summary = "Register for an event",
    description = "Registers the logged-in user for the event or updates their build selection. Automatically scales composition variants if needed. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    request_body(content = ParticipateEventRequest, description = "Participation build choices"),
    responses(
        (status = 200, description = "Registered successfully", body = ApiResponseEventDetail),
        (status = 400, description = "Validation error (e.g. comp full, build already taken)", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event or build not found", body = ProblemDetails)
    )
)]
async fn participate(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<ParticipateEventRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let detail = service.participate(&db, id, user.user_id, req).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Cancels participation for the logged-in user.
///
/// Any authenticated user can cancel their participation.
#[utoipa::path(
    delete,
    path = "/api/events/{id}/participate",
    tag = "events",
    summary = "Leave an event",
    description = "Cancels registration of the logged-in user for the event. Any authenticated user can call this.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 200, description = "Cancelled successfully", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event or registration not found", body = ProblemDetails)
    )
)]
async fn cancel_participation(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let detail = service.cancel_participation(&db, id, user.user_id).await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Guard for endpoints that mutate an event's participant roster on behalf of
/// someone other than the caller: either the event's creator or any user with
/// `events.manage` may act. Everyone else gets a 403.
///
/// We intentionally avoid `UserContext::require` here because the policy is an
/// OR between role-based permission and ownership of the row, not a single
/// permission gate.
async fn require_event_management_authority(
    user: &UserContext,
    perms: &Permissions,
    db: &sea_orm::DatabaseConnection,
    event_id: i64,
) -> Result<(), AppError> {
    if user.is_superadmin()
        || perms
            .check(user.is_superadmin(), &user.roles, Permission::EventsManage)
            .await
    {
        return Ok(());
    }

    let owner_id = super::entities::event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?
        .created_by;

    if owner_id == user.user_id {
        return Ok(());
    }

    Err(AppError::Forbidden(
        "Only the event creator or users with events.manage may manage participants".to_string(),
    ))
}

/// Inserts or updates a participant on behalf of an arbitrary guild member.
///
/// Restricted to the event creator or users holding `events.manage`.
#[utoipa::path(
    put,
    path = "/api/events/{id}/participants/{user_id}",
    tag = "events",
    summary = "Set participant build assignment",
    description = "Officer / event-creator endpoint for inserting or updating the build \
        assignment of an arbitrary guild member. Useful when a member cannot sign themselves up \
        (e.g. they are offline) or when the organiser wants to reshuffle builds right before \
        starting the event. The same comp / slot-availability rules as `POST /events/{id}/participate` \
        apply. Returns the refreshed `EventDetailView`.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID"),
        ("user_id" = i64, Path, description = "Internal user ID of the target member")
    ),
    request_body(content = SetParticipantRequest, description = "Build IDs to assign"),
    responses(
        (status = 200, description = "Participant upserted", body = ApiResponseEventDetail),
        (status = 400, description = "Validation error (e.g. comp full, build not allowed)", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - caller is not creator and lacks events.manage", body = ProblemDetails),
        (status = 404, description = "Event / user / build not found", body = ProblemDetails)
    )
)]
async fn set_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path((id, target_user_id)): Path<(i64, i64)>,
    Json(req): Json<SetParticipantRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let service = EventService::new();
    let detail = service
        .set_participant(&db, id, target_user_id, req)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Removes a participant from an event on behalf of an arbitrary guild member.
///
/// Restricted to the event creator or users holding `events.manage`.
#[utoipa::path(
    delete,
    path = "/api/events/{id}/participants/{user_id}",
    tag = "events",
    summary = "Remove a participant",
    description = "Officer / event-creator endpoint for removing an arbitrary guild member from the \
        event roster. Returns the refreshed `EventDetailView`.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID"),
        ("user_id" = i64, Path, description = "Internal user ID of the target member")
    ),
    responses(
        (status = 200, description = "Participant removed", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - caller is not creator and lacks events.manage", body = ProblemDetails),
        (status = 404, description = "Event / participation not found", body = ProblemDetails)
    )
)]
async fn remove_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path((id, target_user_id)): Path<(i64, i64)>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let service = EventService::new();
    let detail = service
        .cancel_participation(&db, id, target_user_id)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Starts an event session (status -> live).
///
/// Requires `events.manage` permission.
#[utoipa::path(
    post,
    path = "/api/events/{id}/start",
    tag = "events",
    summary = "Start event session",
    description = "Marks the event as live, records `started_at = now` and computes an `auto_stop_deadline` 3 hours out. The background linker will start pulling AlbionBB battles into the session window.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Session started", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event already live", body = ProblemDetails)
    )
)]
async fn start_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    let service = EventService::new();
    let event = service.start_event(&db, id).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Stops an event session (status -> stopped).
///
/// Requires `events.manage` permission. Auto-stops (`status=auto_stopped`) are
/// handled by the background worker.
#[utoipa::path(
    post,
    path = "/api/events/{id}/stop",
    tag = "events",
    summary = "Stop event session",
    description = "Marks a live event session as stopped. The linker keeps refreshing battles for a grace period after the stop.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Session stopped", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is not live", body = ProblemDetails)
    )
)]
async fn stop_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    let service = EventService::new();
    let event = service.stop_event(&db, id, false).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Returns the battles linked to an event session so far.
///
/// Any authenticated user can read this; it's the same data already embedded
/// in `EventDetailView.battles`.
#[utoipa::path(
    get,
    path = "/api/events/{id}/battles",
    tag = "events",
    summary = "List battles linked to an event",
    description = "Returns battles pulled from AlbionBB whose guild-player count matches the event's sign-up range.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Linked battles", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn list_event_battles(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let context = BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    );
    let detail = service
        .get_event_detail_with_context(&db, id, &context)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

/// Replaces the complete set of battles linked to an event.
///
/// Requires `events.manage` permission. Passing an empty `battle_ids` array is valid and removes
/// every linked battle, so an event can explicitly have zero battles.
#[utoipa::path(
    put,
    path = "/api/events/{id}/battles",
    tag = "events",
    summary = "Replace battles linked to an event",
    description = "Officer/admin endpoint for manually setting the exact AlbionBB battles fought during an event. The request body replaces the complete linked set; use an empty `battle_ids` array to leave the event with zero linked battles. Each battle is fetched from AlbionBB and must include the configured guild before analytics are updated.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    request_body(content = UpdateEventBattlesRequest, description = "Complete set of AlbionBB battle IDs to link"),
    responses(
        (status = 200, description = "Linked battles replaced", body = ApiResponseEventDetail),
        (status = 400, description = "Invalid battle list or battle outside configured guild", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.manage permission", body = ProblemDetails),
        (status = 404, description = "Event or battle not found", body = ProblemDetails),
        (status = 502, description = "Upstream AlbionBB API error", body = ProblemDetails)
    )
)]
async fn replace_event_battles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(albionbb): Extension<AlbionBbService>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateEventBattlesRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    user.require(&perms, Permission::EventsManage).await?;
    let service = EventService::new();
    let server = normalize_server(Some(&cfg.albion_api_region));
    let context = BattleLinkingContext::new(
        &cfg.albion_guild_id,
        &cfg.albion_allied_guild_ids(),
        &cfg.albion_allied_guild_names(),
    );
    let detail = service
        .replace_event_battles(&db, &albionbb, &context, Some(&server), id, req)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}
