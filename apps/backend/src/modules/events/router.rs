//! REST API routes and OpenAPI paths for the events module.

use axum::{
    Extension, Json, Router,
    extract::{
        Path, Query,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{delete, get, post, put},
};

use crate::config::Config;
use crate::errors::AppError;
use crate::errors::ProblemDetails;
use crate::modules::audit::service::AuditService;
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use crate::responses::{
    ApiResponse, ApiResponseEventDetail, ApiResponseEventList, ApiResponseEventRosterRoleList,
    ApiResponseEventView,
};

use sea_orm::EntityTrait;
use std::collections::HashSet;

use super::models::{
    AddEventMemberRequest, AssignRosterSeatRequest, CreateEventRequest,
    CreateEventRosterRoleRequest, EventDetailView, EventFilters, EventRosterRoleView,
    EventRosterView, EventSignupOptionsView, EventView, ParticipateEventRequest,
    RosterVersionRequest, SetEventVoiceChannelRequest, SetParticipantRequest,
    SwapRosterSeatsRequest, UpdateEventBattlesRequest, UpdateEventRequest,
};
use super::roster_hub::{RosterHub, RosterNotification};
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
        .route("/{id}/signup-options", get(get_event_signup_options))
        .route("/{id}/roster", get(get_roster))
        .route("/{id}/roster/live", get(roster_live))
        .route(
            "/{id}/roster/seats/{seat_key}",
            put(assign_roster_seat).delete(clear_roster_seat),
        )
        .route("/{id}/roster/swaps", post(swap_roster_seats))
        .route("/{id}/roster/auto-fill", post(auto_fill_roster))
        .route(
            "/{id}/roster-roles",
            get(list_event_roster_roles).post(create_event_roster_role),
        )
        .route(
            "/{id}/roster-roles/{role_id}",
            delete(delete_event_roster_role),
        )
        .route(
            "/{id}/participate",
            post(participate).delete(cancel_participation),
        )
        .route("/{id}/participants", post(add_event_member))
        .route(
            "/{id}/participants/{user_id}",
            put(set_participant).delete(remove_participant),
        )
        .route("/{id}/remind", post(remind_event))
        .route(
            "/{id}/discord-voice-channel",
            put(set_event_voice_channel).delete(clear_event_voice_channel),
        )
        .route("/{id}/start", post(start_event))
        .route("/{id}/cancel", post(cancel_event))
        .route("/{id}/stop", post(stop_event))
        .route(
            "/{id}/battles",
            get(list_event_battles).put(replace_event_battles),
        )
}

/// Lists all events (paginated).
///
/// Requires `events.view` permission.
#[utoipa::path(
    get,
    path = "/api/events",
    tag = "events",
    summary = "List events",
    description = "Returns a paginated list of scheduled events. Requires `events.view` permission.",
    security(("session_cookie" = [])),
    params(
        ("page" = Option<u64>, Query, description = "Page number (1-indexed, default: 1)"),
        ("limit" = Option<u64>, Query, description = "Items per page (1-50, default: 10)"),
        ("search" = Option<String>, Query, description = "Case-insensitive title match"),
        ("status" = Option<String>, Query, description = "Session status: scheduled, live, stopped, auto_stopped, cancelled"),
        ("sort" = Option<String>, Query, description = "Sort column: event_date_utc/start_time_utc, mass_time_utc, title, created_at, status"),
        ("order" = Option<String>, Query, description = "Sort direction: asc (default) or desc"),
        ("date_from" = Option<String>, Query, description = "Inclusive start of start_time_utc (RFC3339)"),
        ("date_to" = Option<String>, Query, description = "Inclusive end of start_time_utc (RFC3339)")
    ),
    responses(
        (status = 200, description = "Events list retrieved successfully", body = ApiResponseEventList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails)
    )
)]
async fn list_events(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(pagination): Query<PaginationParams>,
    Query(filters): Query<EventFilters>,
) -> Result<Json<ApiResponse<PaginatedData<EventView>>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let service = EventService::new();
    let events = service.list_events(&db, pagination, filters).await?;
    Ok(Json(ApiResponse::new(events)))
}

/// Gets a detailed event.
///
/// Requires `events.view` permission.
#[utoipa::path(
    get,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Get event detail",
    description = "Returns the full details of an event including active comp configuration and participants list. Requires `events.view` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 200, description = "Event details retrieved successfully", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn get_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
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

/// Returns the next concrete signup choices for the authenticated member.
///
/// The server evaluates an unregistered member as one additional concrete signup and returns the
/// corresponding comp tier. Existing roster members do not inflate the calculation merely by
/// opening the menu.
#[utoipa::path(
    get,
    path = "/api/events/{id}/signup-options",
    tag = "events",
    summary = "Get prospective event signup options",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Prospective signup options retrieved", body = EventSignupOptionsView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn get_event_signup_options(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventSignupOptionsView>>, AppError> {
    let options = EventService::new()
        .get_event_signup_options(&db, id, user.user_id)
        .await?;
    Ok(Json(ApiResponse::new(options)))
}

async fn get_roster(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

async fn assign_roster_seat(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path((id, seat_key)): Path<(i64, String)>,
    Json(request): Json<AssignRosterSeatRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let version = EventService::new()
        .assign_roster_seat(&db, id, &seat_key, request, user.user_id)
        .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        seat_key,
        "roster seat assigned"
    );
    hub.publish(id, version, "assigned", vec![seat_key]);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

async fn clear_roster_seat(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path((id, seat_key)): Path<(i64, String)>,
    Json(request): Json<RosterVersionRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let version = EventService::new()
        .clear_roster_seat(&db, id, &seat_key, request)
        .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        seat_key,
        "roster seat cleared"
    );
    hub.publish(id, version, "cleared", vec![seat_key]);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

async fn swap_roster_seats(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
    Json(request): Json<SwapRosterSeatsRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let keys = vec![
        request.source_seat_key.clone(),
        request.target_seat_key.clone(),
    ];
    let version = EventService::new()
        .swap_roster_seats(&db, id, request, user.user_id)
        .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        "roster seats swapped"
    );
    hub.publish(id, version, "swapped", keys);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

async fn auto_fill_roster(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
    Json(request): Json<RosterVersionRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let (version, changed) = EventService::new()
        .auto_fill_roster(&db, id, request, user.user_id)
        .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        assignments = changed.len(),
        "roster auto-filled"
    );
    hub.publish(id, version, "auto_filled", changed);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

async fn roster_live(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(hub): Extension<RosterHub>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    websocket: WebSocketUpgrade,
) -> Result<Response, AppError> {
    super::entities::event::Entity::find_by_id(id)
        .one(&db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin != Some(cfg.frontend_url.trim_end_matches('/')) {
        return Err(AppError::Forbidden(
            "websocket origin is not allowed".to_string(),
        ));
    }
    Ok(websocket.on_upgrade(move |socket| roster_socket(socket, hub, db, id)))
}

async fn roster_socket(
    mut socket: WebSocket,
    hub: RosterHub,
    db: sea_orm::DatabaseConnection,
    event_id: i64,
) {
    let mut receiver = hub.subscribe();
    let roster_version = match super::entities::event::Entity::find_by_id(event_id)
        .one(&db)
        .await
    {
        Ok(Some(event)) => event.roster_version,
        Ok(None) | Err(_) => return,
    };
    let mut latest_roster_version = roster_version;
    let ready = RosterNotification {
        message_type: "ready",
        event_id,
        roster_version,
        change_kind: None,
        changed_seat_keys: None,
    };
    if send_roster_notification(&mut socket, &ready).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => { if incoming.is_none() { return; } }
            received = receiver.recv() => match received {
            Ok(notification) if notification.event_id == event_id => {
                latest_roster_version = notification.roster_version;
                if send_roster_notification(&mut socket, &notification)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let resync = RosterNotification {
                    message_type: "resync_required",
                    event_id,
                    roster_version: latest_roster_version,
                    change_kind: None,
                    changed_seat_keys: None,
                };
                if send_roster_notification(&mut socket, &resync)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

async fn send_roster_notification(
    socket: &mut WebSocket,
    notification: &RosterNotification,
) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            serde_json::to_string(notification)
                .expect("roster notification serializes")
                .into(),
        ))
        .await
}

/// Lists event roster roles.
///
/// Any authenticated user can read the virtual `Fill` role and persisted extra roles.
#[utoipa::path(
    get,
    path = "/api/events/{id}/roster-roles",
    tag = "events",
    summary = "List event roster roles",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Roster roles retrieved", body = ApiResponseEventRosterRoleList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn list_event_roster_roles(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<Vec<EventRosterRoleView>>>, AppError> {
    let roles = EventService::new().list_event_roster_roles(&db, id).await?;
    Ok(Json(ApiResponse::new(roles)))
}

/// Adds an existing build as an event-specific roster role.
#[utoipa::path(
    post,
    path = "/api/events/{id}/roster-roles",
    tag = "events",
    summary = "Add event roster role",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    request_body = CreateEventRosterRoleRequest,
    responses(
        (status = 200, description = "Roster role added", body = EventRosterRoleView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event or build not found", body = ProblemDetails),
        (status = 409, description = "Build is already an extra roster role", body = ProblemDetails)
    )
)]
async fn create_event_roster_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
    Json(request): Json<CreateEventRosterRoleRequest>,
) -> Result<Json<ApiResponse<EventRosterRoleView>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    let role = EventService::new()
        .create_event_roster_role(&db, id, request)
        .await?;
    notify_roster_roles_changed(&db, &hub, id).await;
    Ok(Json(ApiResponse::new(role)))
}

/// Deletes an event-specific roster role.
#[utoipa::path(
    delete,
    path = "/api/events/{id}/roster-roles/{role_id}",
    tag = "events",
    summary = "Remove event roster role",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID"),
        ("role_id" = i64, Path, description = "Persisted extra roster-role ID")
    ),
    responses(
        (status = 204, description = "Roster role removed"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event roster role not found", body = ProblemDetails)
    )
)]
async fn delete_event_roster_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path((id, role_id)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    EventService::new()
        .delete_event_roster_role(&db, id, role_id)
        .await?;
    notify_roster_roles_changed(&db, &hub, id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Tells every live-roster subscriber that the seat layout itself changed.
///
/// Adding or removing an extra role adds or removes seats for everyone looking at the roster, so it
/// belongs on the socket alongside the seat commands. The roster version is unchanged — no seat
/// assignment moved — and clients only skip notifications *older* than their snapshot, so echoing
/// the current version is enough to make them refetch. A missing event or a read failure only costs
/// the other viewers a manual refresh, so it is not worth failing the request that already
/// succeeded.
async fn notify_roster_roles_changed(
    db: &sea_orm::DatabaseConnection,
    hub: &RosterHub,
    event_id: i64,
) {
    let version = super::entities::event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .ok()
        .flatten()
        .map(|event| event.roster_version);
    if let Some(version) = version {
        hub.publish(event_id, version, "roles_changed", Vec::new());
    }
}

/// Creates a new event.
///
/// Requires `events.create` permission.
#[utoipa::path(
    post,
    path = "/api/events",
    tag = "events",
    summary = "Create an event",
    description = "Creates a new event with a base composition. Requires `events.create` permission.",
    security(("session_cookie" = [])),
    request_body(content = CreateEventRequest, description = "Event details"),
    responses(
        (status = 200, description = "Event created successfully", body = ApiResponseEventView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails)
    )
)]
async fn create_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsCreate).await?;

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
    description = "Returns non-managed roles in the configured Discord guild. Requires events.edit.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Discord roles retrieved", body = [DiscordRoleView]),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable or bot token missing", body = ProblemDetails)
    )
)]
async fn list_event_discord_roles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
) -> Result<Json<ApiResponse<Vec<DiscordRoleView>>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_roles(&cfg).await?,
    )))
}

/// Updates an existing event.
///
/// Requires `events.edit` permission.
#[utoipa::path(
    patch,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Update an event",
    description = "Updates an event. Requires `events.edit` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    request_body(content = UpdateEventRequest, description = "Updated event details"),
    responses(
        (status = 200, description = "Event updated successfully", body = ApiResponseEventView),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
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
    user.require(&perms, Permission::EventsEdit).await?;
    let service = EventService::new();
    let event = service.update_event(&db, id, req).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Deletes an event.
///
/// Requires `events.delete` permission.
#[utoipa::path(
    delete,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Delete an event",
    description = "Deletes an event. Requires `events.delete` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 204, description = "Event deleted successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn delete_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    user.require(&perms, Permission::EventsDelete).await?;
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
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
    Json(req): Json<ParticipateEventRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let (detail, version) = service
        .participate_with_roster_version(&db, id, user.user_id, req)
        .await?;
    hub.publish(id, version, "participation_changed", Vec::new());
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
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let (detail, version, seat_key) = service.cancel_participation(&db, id, user.user_id).await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        "participation cancelled"
    );
    hub.publish(
        id,
        version,
        "participant_left",
        seat_key.into_iter().collect(),
    );
    Ok(Json(ApiResponse::new(detail)))
}

/// Guard for endpoints that mutate an event's participant roster on behalf of
/// someone other than the caller: either the event's creator or any user with
/// `events.edit` may act. Everyone else gets a 403.
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
            .check(user.is_superadmin(), &user.roles, Permission::EventsEdit)
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
        "Only the event creator or users with events.edit may manage participants".to_string(),
    ))
}

/// Adds or updates a participant on behalf of an arbitrary guild member.
///
/// Restricted to the event creator or users holding `events.edit`.
#[utoipa::path(
    post,
    path = "/api/events/{id}/participants",
    tag = "events",
    summary = "Add a member to an event",
    description = "Adds an existing member to the event using the same comp, build-slot, roster, and capacity invariants as self-service participation. Repeating the request updates that member's build assignment.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    request_body(content = AddEventMemberRequest, description = "Member and build IDs to assign"),
    responses(
        (status = 200, description = "Member added", body = ApiResponseEventDetail),
        (status = 400, description = "Validation error (e.g. comp full, build not allowed)", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - caller is not creator and lacks events.edit", body = ProblemDetails),
        (status = 404, description = "Event / user / build not found", body = ProblemDetails)
    )
)]
async fn add_event_member(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path(id): Path<i64>,
    Json(req): Json<AddEventMemberRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let service = EventService::new();
    let (detail, version) = service.add_member_with_roster_version(&db, id, req).await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        "event member added"
    );
    hub.publish(id, version, "participation_changed", Vec::new());
    Ok(Json(ApiResponse::new(detail)))
}

/// Inserts or updates a participant on behalf of an arbitrary guild member.
///
/// Restricted to the event creator or users holding `events.edit`. This URL form is retained for
/// clients that already send the target user ID as a path parameter.
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
        (status = 403, description = "Forbidden - caller is not creator and lacks events.edit", body = ProblemDetails),
        (status = 404, description = "Event / user / build not found", body = ProblemDetails)
    )
)]
async fn set_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path((id, target_user_id)): Path<(i64, i64)>,
    Json(req): Json<SetParticipantRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let service = EventService::new();
    let (detail, version) = service
        .set_participant_with_roster_version(&db, id, target_user_id, req)
        .await?;
    hub.publish(id, version, "participation_changed", Vec::new());
    Ok(Json(ApiResponse::new(detail)))
}

/// Removes a participant from an event on behalf of an arbitrary guild member.
///
/// Restricted to the event creator or users holding `events.edit`.
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
        (status = 403, description = "Forbidden - caller is not creator and lacks events.edit", body = ProblemDetails),
        (status = 404, description = "Event / participation not found", body = ProblemDetails)
    )
)]
async fn remove_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Path((id, target_user_id)): Path<(i64, i64)>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id).await?;
    let service = EventService::new();
    let (detail, version, seat_key) = service
        .cancel_participation(&db, id, target_user_id)
        .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        target_user_id,
        "participant removed"
    );
    hub.publish(
        id,
        version,
        "participant_removed",
        seat_key.into_iter().collect(),
    );
    Ok(Json(ApiResponse::new(detail)))
}

/// Authorizes a manual Discord reminder for a scheduled event.
///
/// Requires `events.edit` permission. Discord delivery remains the bot's responsibility.
#[utoipa::path(
    post,
    path = "/api/events/{id}/remind",
    tag = "events",
    summary = "Prepare a manual event reminder",
    description = "Validates that the caller can manage events and that the event is still scheduled, then records the reminder request for the Discord bot.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Reminder authorized", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is not scheduled", body = ProblemDetails)
    )
)]
async fn remind_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    let event = EventService::new().prepare_event_reminder(&db, id).await?;

    let _ = AuditService::log(
        &db,
        "EVENT_REMINDER_REQUESTED",
        Some("EVENT"),
        Some(id),
        Some(user.user_id),
        Some(serde_json::json!({ "event_date_utc": event.event_date_utc })),
    )
    .await;

    Ok(Json(ApiResponse::new(event)))
}

/// Associates the Discord voice channel created by the bot at Mass or Start.
///
/// Requires `events.edit` permission.
#[utoipa::path(
    put,
    path = "/api/events/{id}/discord-voice-channel",
    tag = "events",
    summary = "Bind a Discord voice channel to a scheduled or live event",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    request_body = SetEventVoiceChannelRequest,
    responses(
        (status = 200, description = "Voice channel bound", body = ApiResponseEventView),
        (status = 400, description = "Invalid Discord channel ID", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is not scheduled/live or has another voice channel", body = ProblemDetails)
    )
)]
async fn set_event_voice_channel(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<SetEventVoiceChannelRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    let event = EventService::new()
        .bind_event_voice_channel(&db, id, &req.channel_id)
        .await?;
    let _ = AuditService::log(
        &db,
        "EVENT_VOICE_CHANNEL_BOUND",
        Some("EVENT"),
        Some(id),
        Some(user.user_id),
        Some(serde_json::json!({ "channel_id": event.discord_voice_channel_id })),
    )
    .await;
    Ok(Json(ApiResponse::new(event)))
}

/// Clears the persisted Discord voice channel after a stopped event's cleanup.
///
/// Requires `events.edit` permission.
#[utoipa::path(
    delete,
    path = "/api/events/{id}/discord-voice-channel",
    tag = "events",
    summary = "Clear a stopped event's Discord voice channel binding",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Voice channel binding cleared", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is not stopped, auto-stopped, or cancelled", body = ProblemDetails)
    )
)]
async fn clear_event_voice_channel(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    let event = EventService::new()
        .clear_event_voice_channel(&db, id)
        .await?;
    let _ = AuditService::log(
        &db,
        "EVENT_VOICE_CHANNEL_CLEARED",
        Some("EVENT"),
        Some(id),
        Some(user.user_id),
        None,
    )
    .await;
    Ok(Json(ApiResponse::new(event)))
}

/// Starts an event session (status -> live).
///
/// Requires `events.edit` permission.
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
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
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
    user.require(&perms, Permission::EventsEdit).await?;
    let service = EventService::new();
    let event = service.start_event(&db, id).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Cancels an event (status -> cancelled).
///
/// Requires `events.edit` permission. Repeating the request for an already cancelled event is safe.
#[utoipa::path(
    post,
    path = "/api/events/{id}/cancel",
    tag = "events",
    summary = "Cancel event",
    description = "Cancels a scheduled or live event. Completed events cannot be cancelled.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Event cancelled", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is already completed", body = ProblemDetails)
    )
)]
async fn cancel_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    Ok(Json(ApiResponse::new(
        EventService::new().cancel_event(&db, id).await?,
    )))
}

/// Stops an event session (status -> stopped).
///
/// Requires `events.edit` permission. Auto-stops (`status=auto_stopped`) are
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
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
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
    user.require(&perms, Permission::EventsEdit).await?;
    let service = EventService::new();
    let event = service.stop_event(&db, id, false).await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Returns the battles linked to an event session so far.
///
/// Requires `events.view` permission; it's the same data already embedded
/// in `EventDetailView.battles`.
#[utoipa::path(
    get,
    path = "/api/events/{id}/battles",
    tag = "events",
    summary = "List battles linked to an event",
    description = "Returns battles pulled from AlbionBB whose guild-player count matches the event's sign-up range. Requires `events.view` permission.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Linked battles", body = ApiResponseEventDetail),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn list_event_battles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
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
/// Requires `events.edit` permission. Passing an empty `battle_ids` array is valid and removes
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
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
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
    user.require(&perms, Permission::EventsEdit).await?;
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
