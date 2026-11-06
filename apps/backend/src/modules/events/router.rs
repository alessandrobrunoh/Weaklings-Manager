//! REST API routes and `OpenAPI` paths for the events module.

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
use crate::modules::auth::{BotSecret, Permission, Permissions, UserContext};
use crate::pagination::{PaginatedData, PaginationParams};
use serde::Deserialize;

use crate::responses::{
    ApiResponse, ApiResponseEventCalendarList, ApiResponseEventDetail,
    ApiResponseEventFanoutStatus, ApiResponseEventList, ApiResponseEventManagementAuthority,
    ApiResponseEventRevisionList, ApiResponseEventRosterRoleList, ApiResponseEventSummary,
    ApiResponseEventView, ApiResponseParticipationGuildList,
};
use crate::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantRegistry};

use sea_orm::{ConnectionTrait, DbBackend, EntityTrait, Statement, Value};
use std::collections::HashSet;

use super::attribution::{
    ParticipationGuild, eligible_participation_guilds, resolve_join_attribution,
};
use super::lifecycle::{AfterCommit, Cause, Transition, XpFilter, propagate_source_change};
use super::models::{
    AddEventMemberRequest, AssignRosterSeatRequest, CreateEventRequest,
    CreateEventRosterRoleRequest, EventDetailView, EventFilters, EventManagementAuthorityView,
    EventRevision, EventRosterRoleView, EventRosterView, EventSignupOptionsView, EventSummary,
    EventView, ParticipateEventRequest, RosterVersionRequest, SetEventVoiceChannelRequest,
    SetParticipantRequest, SwapRosterSeatsRequest, UpdateEventBattlesRequest, UpdateEventRequest,
};
use super::roster_hub::{RosterHub, RosterNotification};
use super::service::{EventService, apply_alliance_ping_targets, load_alliance_ping_targets};
use super::sync::{assert_active_alliance, create_mirror, sync_participation};
use crate::modules::admin::models::DiscordRoleView;
use crate::modules::admin::service::AdminService;
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::alliance_share::ShareActor;
use crate::modules::sync::{LegacyLinks, SyncKind, assert_writable, copy_role};

/// Rejects a write on a read-only copy of another tenant's event (403 + `origin`).
///
/// Detached copies (sync link disabled) stay locally managed and pass.
async fn assert_event_writable(
    db: &sea_orm::DatabaseConnection,
    control: &ControlDb,
    tenant_id: &str,
    id: i64,
) -> Result<(), AppError> {
    let legacy = LegacyLinks {
        control: &control.0,
        tenant_id,
    };
    assert_writable(db, legacy, SyncKind::Event, id).await
}

async fn hydrate_event_view(
    mut view: EventView,
    control: &ControlDb,
    registry: &TenantRegistry,
    origin_guild_id: &str,
) -> EventView {
    match super::sync::canonical_event_origin(&control.0, origin_guild_id, view.id).await {
        Ok((source_tenant_id, source_event_id)) if source_tenant_id != origin_guild_id => {
            view.source_tenant_id.get_or_insert(source_tenant_id);
            view.source_event_id.get_or_insert(source_event_id);
            view.is_synchronized_copy = true;
        }
        Ok(_) => view.is_synchronized_copy = false,
        Err(error) => {
            tracing::warn!(
                event_id = view.id,
                error = %error,
                "could not resolve synchronized event ownership"
            );
            // Hide owner-only controls while the relationship cannot be
            // verified; backend mutation endpoints also fail closed.
            view.is_synchronized_copy = view.source_event_id.is_some();
        }
    }
    if !view.ping_alliance {
        return view;
    }
    match load_alliance_ping_targets(&control.0, registry, origin_guild_id).await {
        Ok(targets) => apply_alliance_ping_targets(&mut view, &targets),
        Err(error) => {
            tracing::warn!(error = %error, "could not resolve alliance Discord targets");
            view.origin_guild_id = Some(origin_guild_id.to_string());
        }
    }
    view
}

async fn hydrate_event_detail(
    mut detail: EventDetailView,
    control: &ControlDb,
    registry: &TenantRegistry,
    origin_guild_id: &str,
) -> EventDetailView {
    detail.event = hydrate_event_view(detail.event, control, registry, origin_guild_id).await;
    detail
}

async fn hydrate_event_list(
    mut page: PaginatedData<EventView>,
    control: &ControlDb,
    registry: &TenantRegistry,
    origin_guild_id: &str,
) -> PaginatedData<EventView> {
    hydrate_event_copy_identities(&mut page, control, origin_guild_id).await;
    if !page.items.iter().any(|event| event.ping_alliance) {
        return page;
    }
    match load_alliance_ping_targets(&control.0, registry, origin_guild_id).await {
        Ok(targets) => {
            for event in &mut page.items {
                apply_alliance_ping_targets(event, &targets);
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "could not resolve alliance Discord targets");
            for event in &mut page.items {
                if event.ping_alliance {
                    event.origin_guild_id = Some(origin_guild_id.to_string());
                }
            }
        }
    }
    page
}

/// Backfills source identity for older one-to-one mirrors in one control-plane
/// query. New fanout copies already carry their source identity on the event row.
async fn hydrate_event_copy_identities(
    page: &mut PaginatedData<EventView>,
    control: &ControlDb,
    tenant_id: &str,
) {
    let event_ids = page.items.iter().map(|event| event.id).collect::<Vec<_>>();
    if event_ids.is_empty() {
        return;
    }

    let placeholders = (2..event_ids.len() + 2)
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT mirror_event_id, source_tenant_id, source_event_id \
         FROM event_sync_links \
         WHERE mirror_tenant_id = $1 AND sync_enabled \
           AND mirror_event_id IN ({placeholders})"
    );
    let mut values = vec![Value::from(tenant_id.to_owned())];
    values.extend(event_ids.iter().copied().map(Value::from));
    let rows = match control
        .0
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &sql,
            values,
        ))
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "could not resolve event copy identities for list");
            return;
        }
    };
    for row in rows {
        let result = (|| {
            Ok::<_, sea_orm::DbErr>((
                row.try_get_by_index::<i64>(0)?,
                row.try_get_by_index::<String>(1)?,
                row.try_get_by_index::<i64>(2)?,
            ))
        })();
        match result {
            Ok((mirror_event_id, source_tenant_id, source_event_id)) => {
                if let Some(event) = page
                    .items
                    .iter_mut()
                    .find(|event| event.id == mirror_event_id)
                {
                    event.source_tenant_id = Some(source_tenant_id);
                    event.source_event_id = Some(source_event_id);
                    event.is_synchronized_copy = true;
                }
            }
            Err(error) => tracing::warn!(error = %error, "invalid event sync link row"),
        }
    }
}

/// Returns the compiled router containing all event endpoints.
pub fn router() -> Router {
    Router::new()
        .route("/", get(list_events).post(create_event))
        .route("/{id}/fanout-status", get(get_event_fanout_status))
        .route("/{id}/mirror-status", get(get_event_mirror_status))
        .route("/{id}/mirror-retry", post(retry_event_mirror))
        .route("/calendar", get(list_event_calendar))
        .route("/summary", get(get_events_summary))
        .route("/revisions", get(list_event_revisions))
        .route(
            "/vod-forum-posts/pending",
            get(list_pending_vod_forum_posts),
        )
        .route(
            "/vod-forum-posts/archived",
            get(list_archived_vod_forum_posts),
        )
        .route("/{id}/vod-forum-post/claim", post(claim_vod_forum_post))
        .route(
            "/{id}/vod-forum-post/created",
            post(record_vod_forum_post_created),
        )
        .route(
            "/{id}/vod-forum-post/deleted",
            post(record_vod_forum_post_deleted),
        )
        .route(
            "/{id}/vod-forum-post/retry-after-verification",
            post(retry_vod_forum_post),
        )
        .route(
            "/{id}",
            get(get_event).patch(update_event).delete(delete_event),
        )
        .route("/{id}/archive", post(archive_event))
        .route("/{id}/unarchive", post(unarchive_event))
        .route("/discord-roles", get(list_event_discord_roles))
        .route("/{id}/signup-options", get(get_event_signup_options))
        .route("/{id}/roster", get(get_roster))
        .route("/{id}/roster/suggestions", get(get_roster_suggestions))
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
        .route("/{id}/participation-guilds", get(get_participation_guilds))
        .route("/{id}/participants", post(add_event_member))
        .route(
            "/{id}/participants/{user_id}",
            put(set_participant).delete(remove_participant),
        )
        .route("/{id}/remind", post(remind_event))
        .route(
            "/{id}/management-authority",
            get(get_event_management_authority),
        )
        .route(
            "/{id}/discord-voice-channel",
            put(set_event_voice_channel).delete(clear_event_voice_channel),
        )
        .route("/{id}/start", post(start_event))
        .route("/{id}/cancel", post(cancel_event))
        .route("/{id}/uncancel", post(uncancel_event))
        .route("/{id}/stop", post(stop_event))
        .route(
            "/{id}/battles",
            get(list_event_battles).put(replace_event_battles),
        )
        .route(
            "/actions",
            get(crate::modules::actions::router::list_event_collection_actions),
        )
        .route(
            "/actions/{action}",
            post(crate::modules::actions::router::run_event_collection_action),
        )
        .route(
            "/{id}/actions",
            get(crate::modules::actions::router::list_event_actions),
        )
        .route(
            "/{id}/actions/{action}",
            post(crate::modules::actions::router::run_event_action),
        )
}

/// Fetches the durable queue of newly requested VOD forum posts for the bot.
#[utoipa::path(
    get,
    path = "/api/events/vod-forum-posts/pending",
    tag = "events",
    summary = "List pending VOD forum post deliveries",
    description = "Requires the configured X-Bot-Secret.",
    responses((status = 200, description = "Pending event posts", body = ApiResponse<Vec<EventView>>))
)]
pub(crate) async fn list_pending_vod_forum_posts(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<EventView>>>, AppError> {
    let items = EventService::new().pending_vod_forum_posts(&db).await?;
    Ok(Json(ApiResponse::new(items)))
}

async fn list_archived_vod_forum_posts(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<EventView>>>, AppError> {
    let items = EventService::new().archived_vod_forum_posts(&db).await?;
    Ok(Json(ApiResponse::new(items)))
}

async fn record_vod_forum_post_deleted(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<RecordVodForumPostRequest>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    let thread_id = req.thread_id.trim();
    if thread_id.is_empty() {
        return Err(AppError::Validation("thread_id is required".to_string()));
    }
    Ok(Json(ApiResponse::new(
        EventService::new()
            .record_vod_forum_post_deleted(&db, id, thread_id)
            .await?,
    )))
}

/// Atomically marks a pending delivery attempted before the bot calls Discord.
#[utoipa::path(
    post,
    path = "/api/events/{id}/vod-forum-post/claim",
    tag = "events",
    summary = "Claim a VOD forum post delivery",
    params(("id" = i64, Path, description = "Event ID")),
    description = "Requires the configured X-Bot-Secret.",
    responses((status = 200, description = "Whether the pending delivery was claimed", body = ApiResponse<bool>))
)]
pub(crate) async fn claim_vod_forum_post(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    Ok(Json(ApiResponse::new(
        EventService::new().claim_vod_forum_post(&db, id).await?,
    )))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub(crate) struct RecordVodForumPostRequest {
    /// Discord thread snowflake created for the VOD post.
    thread_id: String,
}

/// Records a successful creation. An attempted row not confirmed here is never retried.
#[utoipa::path(
    post,
    path = "/api/events/{id}/vod-forum-post/created",
    tag = "events",
    summary = "Record a created VOD forum post",
    params(("id" = i64, Path, description = "Event ID")),
    request_body = RecordVodForumPostRequest,
    description = "Requires the configured X-Bot-Secret.",
    responses((status = 200, description = "Whether the created thread was recorded", body = ApiResponse<bool>))
)]
pub(crate) async fn record_vod_forum_post_created(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<RecordVodForumPostRequest>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    let thread_id = req.thread_id.trim();
    if thread_id.is_empty() {
        return Err(AppError::Validation("thread_id is required".to_string()));
    }
    Ok(Json(ApiResponse::new(
        EventService::new()
            .record_vod_forum_post_created(&db, id, thread_id.to_string())
            .await?,
    )))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub(crate) struct RetryVodForumPostRequest {
    /// Operator confirmed that all bot workers are stopped and no post exists.
    confirm_no_post: bool,
}

/// Requeues an ambiguous delivery only after an operator has verified Discord.
#[utoipa::path(
    post,
    path = "/api/events/{id}/vod-forum-post/retry-after-verification",
    tag = "events",
    summary = "Requeue a verified missing VOD forum post",
    description = "Requires X-Bot-Secret. Stop all bot workers and verify that no post exists before calling; otherwise a duplicate can be created.",
    params(("id" = i64, Path, description = "Event ID")),
    request_body = RetryVodForumPostRequest,
    responses((status = 200, description = "Whether an attempted delivery was requeued", body = ApiResponse<bool>))
)]
pub(crate) async fn retry_vod_forum_post(
    _bot: BotSecret,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
    Json(req): Json<RetryVodForumPostRequest>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    if !req.confirm_no_post {
        return Err(AppError::Validation(
            "confirmation that no post exists is required".to_string(),
        ));
    }
    Ok(Json(ApiResponse::new(
        EventService::new().retry_vod_forum_post(&db, id).await?,
    )))
}

/// Returns all live and upcoming events used by the Discord calendar.
///
/// Requires `events.edit` because the corresponding bot command republishes the guild-wide
/// calendar message.
#[utoipa::path(
    get,
    path = "/api/events/calendar",
    tag = "events",
    summary = "List events for the Discord calendar",
    description = "Returns every non-archived live event and every future scheduled event, without \
        pagination. Requires `events.edit`; the bot uses this feed for both its scheduled calendar \
        updates and the manual `/event-calendar-refresh` command.",
    security(("session_cookie" = ["events.edit"])),
    responses(
        (status = 200, description = "Calendar events retrieved", body = ApiResponseEventCalendarList),
        (status = 401, description = "Unauthorized - no active session or linked website account", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails)
    )
)]
pub async fn list_event_calendar(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<EventView>>>, AppError> {
    user.require(&perms, Permission::EventsEdit).await?;
    let events = EventService::new().list_calendar_events(&db).await?;
    Ok(Json(ApiResponse::new(events)))
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
        ("date_to" = Option<String>, Query, description = "Inclusive end of start_time_utc (RFC3339)"),
        ("archived" = Option<bool>, Query, description = "When true, only archived events. Default: only active events")
    ),
    responses(
        (status = 200, description = "Events list retrieved successfully", body = ApiResponseEventList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn list_events(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Query(pagination): Query<PaginationParams>,
    Query(filters): Query<EventFilters>,
) -> Result<Json<ApiResponse<PaginatedData<EventView>>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let service = EventService::new();
    let events = service.list_events(&db, pagination, filters).await?;
    Ok(Json(ApiResponse::new(
        hydrate_event_list(events, &control, &registry, &tenant_id).await,
    )))
}

/// Returns counts of non-archived events by status and call-to-arms flag.
///
/// Requires `events.view` permission.
#[utoipa::path(
    get,
    path = "/api/events/summary",
    tag = "events",
    summary = "Summarize events",
    description = "Returns the number of non-archived events in total, live, scheduled and flagged \
        as call to arms. Counted in the database, so it is exact for any number of events. \
        Requires `events.view` permission.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Event counts retrieved", body = ApiResponseEventSummary),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails)
    )
)]
pub async fn get_events_summary(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<EventSummary>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let summary = EventService::new().summarize_events(&db).await?;
    Ok(Json(ApiResponse::new(summary)))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
struct EventRevisionsQuery {
    /// Comma-separated event ids.
    ids: String,
}

fn parse_event_revision_ids(raw: &str) -> Result<Vec<i64>, AppError> {
    let mut ids = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let id = part.parse::<i64>().map_err(|_| {
            AppError::Validation(format!("invalid event id in revisions query: {part}"))
        })?;
        if id > 0 {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(200);
    Ok(ids)
}

/// Returns status/roster fingerprints for a set of events.
///
/// The Discord poller uses this to skip full `GET /events/{id}` hydration when
/// nothing changed.
#[utoipa::path(
    get,
    path = "/api/events/revisions",
    tag = "events",
    summary = "Fingerprint event roster/status",
    description = "Returns `roster_version`, `status`, and `archived_at` for the given event ids. Missing ids are omitted. Requires `events.view`.",
    security(("session_cookie" = [])),
    params(EventRevisionsQuery),
    responses(
        (status = 200, description = "Event revisions retrieved successfully", body = ApiResponseEventRevisionList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails)
    )
)]
async fn list_event_revisions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Query(query): Query<EventRevisionsQuery>,
) -> Result<Json<ApiResponse<Vec<EventRevision>>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let ids = parse_event_revision_ids(&query.ids)?;
    let revisions = EventService::new().list_event_revisions(&db, &ids).await?;
    Ok(Json(ApiResponse::new(revisions)))
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
#[allow(clippy::too_many_arguments)]
async fn get_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(_cfg): Extension<Config>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let service = EventService::new();
    let context = crate::albion_scope::load_event_read_scope(&control.0, &tenant_id)
        .await?
        .linking_context();
    let event = service
        .get_event_detail_with_context(&db, id, &context)
        .await?;
    Ok(Json(ApiResponse::new(
        hydrate_event_detail(event, &control, &registry, &tenant_id).await,
    )))
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
        (status = 200, description = "Prospective signup options retrieved", body = ApiResponse<EventSignupOptionsView>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
pub(crate) async fn get_event_signup_options(
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

/// Previews an Item-Power-optimal roster assignment without applying it.
///
/// Gated the same way as [`combat::readiness.view`] rather than open to every member: it scores
/// the whole guild's specializations against every open seat at once, which is roster management
/// rather than something a member needs about themselves.
#[utoipa::path(
    get,
    path = "/api/events/{id}/roster/suggestions",
    tag = "events",
    summary = "Preview an optimal roster assignment",
    description = "Solves every unassigned participant against every open seat with the Hungarian \
                   algorithm, maximising total Item-Power readiness plus signup preference. Never \
                   applied automatically — `POST .../roster/auto-fill` with \
                   `strategy: \"spec_optimal\"` applies the same solve for real.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Proposed assignment", body = crate::responses::ApiResponseRosterSuggestions),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing combat.readiness.view", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn get_roster_suggestions(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<crate::modules::combat::fit::Assignment>>, AppError> {
    user.require(&perms, Permission::CombatReadinessView)
        .await?;
    let suggestions = EventService::new().get_roster_suggestions(&db, id).await?;
    Ok(Json(ApiResponse::new(suggestions)))
}

#[allow(clippy::too_many_arguments)]
async fn assign_roster_seat(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((id, seat_key)): Path<(i64, String)>,
    Json(request): Json<AssignRosterSeatRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
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
    hub.publish(&tenant.0, id, version, "assigned", vec![seat_key]);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

#[allow(clippy::too_many_arguments)]
async fn clear_roster_seat(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((id, seat_key)): Path<(i64, String)>,
    Json(request): Json<RosterVersionRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
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
    hub.publish(&tenant.0, id, version, "cleared", vec![seat_key]);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

#[allow(clippy::too_many_arguments)]
async fn swap_roster_seats(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(request): Json<SwapRosterSeatsRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
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
    hub.publish(&tenant.0, id, version, "swapped", keys);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

#[allow(clippy::too_many_arguments)]
async fn auto_fill_roster(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(request): Json<RosterVersionRequest>,
) -> Result<Json<ApiResponse<EventRosterView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
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
    hub.publish(&tenant.0, id, version, "auto_filled", changed);
    Ok(Json(ApiResponse::new(
        EventService::new().get_roster(&db, id).await?,
    )))
}

// One more `Extension` than the `clippy::too_many_arguments` default allows —
// each is a distinct axum extractor, not a group crying out to be bundled.
#[allow(clippy::too_many_arguments)]
async fn roster_live(
    _user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
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
    Ok(websocket.on_upgrade(move |socket| roster_socket(socket, hub, db, tenant.0, id)))
}

async fn roster_socket(
    mut socket: WebSocket,
    hub: RosterHub,
    db: sea_orm::DatabaseConnection,
    tenant_id: String,
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
    let ready = RosterNotification::ready(tenant_id.clone(), event_id, roster_version);
    if send_roster_notification(&mut socket, &ready).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => { if incoming.is_none() { return; } }
            received = receiver.recv() => match received {
            Ok(notification)
                if notification.event_id == event_id && notification.tenant_id == tenant_id =>
            {
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
                let resync = RosterNotification::resync_required(
                    tenant_id.clone(),
                    event_id,
                    latest_roster_version,
                );
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
        (status = 200, description = "Roster role added", body = ApiResponse<EventRosterRoleView>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event or build not found", body = ProblemDetails),
        (status = 409, description = "Build is already an extra roster role", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn create_event_roster_role(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(request): Json<CreateEventRosterRoleRequest>,
) -> Result<Json<ApiResponse<EventRosterRoleView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
    let role = EventService::new()
        .create_event_roster_role(&db, id, request)
        .await?;
    notify_roster_roles_changed(&db, &hub, &tenant.0, id).await;
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
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((id, role_id)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
    EventService::new()
        .delete_event_roster_role(&db, id, role_id)
        .await?;
    notify_roster_roles_changed(&db, &hub, &tenant.0, id).await;
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
    tenant_id: &str,
    event_id: i64,
) {
    let version = super::entities::event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .ok()
        .flatten()
        .map(|event| event.roster_version);
    if let Some(version) = version {
        hub.publish(tenant_id, event_id, version, "roles_changed", Vec::new());
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
#[allow(clippy::too_many_arguments)]
async fn create_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    user.require(&perms, Permission::EventsCreate).await?;

    if !req.discord_role_ids.is_empty() {
        let allowed_role_ids: HashSet<String> = AdminService::discord_roles(&cfg, &tenant.0)
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
                "Discord role {invalid_role_id} was not found in this server or cannot be selected"
            )));
        }
    }

    let source_context = registry.get_or_load(&tenant.0).await?;
    let alliance_origin = source_context.kind == "alliance";
    if alliance_origin && req.ping_alliance {
        return Err(AppError::Validation(
            "alliance-owned events are automatically distributed to active member guilds"
                .to_owned(),
        ));
    }
    let create_mirror_requested = req.ping_alliance;
    if create_mirror_requested {
        if source_context.kind != "guild" {
            return Err(AppError::Validation(
                "only guild events can be shared to the alliance".to_owned(),
            ));
        }
        assert_active_alliance(&control.0, &tenant.0).await?;
    }
    let service = EventService::new();
    let event = service.create_event(&db, user.user_id, req).await?;
    if alliance_origin {
        let target_rows = control
            .0
            .query_all(sea_orm::Statement::from_sql_and_values(
                sea_orm::DbBackend::Postgres,
                "SELECT guild_tenant_id FROM alliance_memberships \
                 WHERE alliance_tenant_id=$1 AND status='active' \
                 ORDER BY guild_tenant_id",
                [tenant.0.clone().into()],
            ))
            .await?;
        let targets = target_rows
            .into_iter()
            .map(|row| row.try_get_by_index::<String>(0))
            .collect::<Result<Vec<_>, _>>()?;
        let enqueue = super::fanout_outbox::enqueue(
            &control.0,
            &tenant.0,
            event.id,
            super::fanout_outbox::Operation::Publish,
            &format!("publish:{}", event.id),
            &targets,
        )
        .await;
        match enqueue {
            Ok(_) => {
                if let Err(error) =
                    super::fanout_worker::process_due_targets(&control.0, &registry).await
                {
                    tracing::error!(
                        tenant_id = %tenant.0,
                        event_id = event.id,
                        error = %error,
                        "alliance event fanout queued but immediate processing failed"
                    );
                }
            }
            Err(error) => {
                tracing::error!(
                    tenant_id = %tenant.0,
                    event_id = event.id,
                    error = %error,
                    "alliance event committed but fanout job could not be enqueued"
                );
                return Err(AppError::Conflict(format!(
                    "event {} was created, but guild distribution could not be queued; do not create it again",
                    event.id
                )));
            }
        }
    } else if create_mirror_requested {
        let actor = ShareActor {
            discord_id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
        };
        if let Err(error) =
            create_mirror(&control.0, &registry, &db, &tenant.0, &event, &actor).await
        {
            // The source row is already committed. Do not turn a cross-tenant
            // mirror failure into an HTTP failure that suggests it rolled back;
            // queue a durable retry instead.
            tracing::error!(
                tenant_id = %tenant.0,
                event_id = event.id,
                error = %error,
                "event mirror creation failed after source event committed; queued for retry"
            );
            if let Err(queue_error) = super::mirror_retry::enqueue(
                &control.0,
                &tenant.0,
                event.id,
                &actor,
                &error.to_string(),
            )
            .await
            {
                tracing::error!(
                    tenant_id = %tenant.0,
                    event_id = event.id,
                    error = %queue_error,
                    "alliance mirror retry could not be queued"
                );
            }
        }
    }
    Ok(Json(ApiResponse::new(
        hydrate_event_view(event, &control, &registry, &tenant.0).await,
    )))
}

/// Returns per-guild publication state for an alliance-owned event.
#[utoipa::path(
    get,
    path = "/api/events/{id}/fanout-status",
    tag = "events",
    summary = "Get alliance event publication status",
    description = "Returns per-guild copy status for an alliance-owned event. Requires event management authority.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Alliance-owned source event ID")),
    responses(
        (status = 200, description = "Per-guild publication state", body = ApiResponseEventFanoutStatus),
        (status = 403, description = "Forbidden - lacks event management authority", body = ProblemDetails),
        (status = 404, description = "Event fanout job not found", body = ProblemDetails)
    )
)]
async fn get_event_fanout_status(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<super::fanout_outbox::EventFanoutStatus>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    let status = super::fanout_outbox::status_for_event(&control.0, &tenant_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("event fanout status not found".to_owned()))?;
    Ok(Json(ApiResponse::new(status)))
}

/// Returns the alliance mirror retry state for a guild-owned event.
#[utoipa::path(
    get,
    path = "/api/events/{id}/mirror-status",
    tag = "events",
    summary = "Get alliance mirror status",
    description = "Returns the durable retry state of the alliance mirror requested for a guild event. Requires event management authority.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Guild-owned source event ID")),
    responses(
        (status = 200, description = "Mirror request state", body = ApiResponse<super::mirror_retry::MirrorRequestStatus>),
        (status = 403, description = "Forbidden - lacks event management authority", body = ProblemDetails),
        (status = 404, description = "No mirror request exists", body = ProblemDetails)
    )
)]
async fn get_event_mirror_status(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<super::mirror_retry::MirrorRequestStatus>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    let status = super::mirror_retry::status_for_event(&control.0, &tenant_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("event mirror request not found".to_owned()))?;
    Ok(Json(ApiResponse::new(status)))
}

/// Re-arms an exhausted, failed, or inactive guild-to-alliance mirror request.
#[utoipa::path(
    post,
    path = "/api/events/{id}/mirror-retry",
    tag = "events",
    summary = "Retry a failed alliance event mirror",
    description = "Re-arms a failed or inactive guild-owned event mirror and immediately tries it once. \
        Requires event management authority and an active alliance membership.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Guild-owned source event ID")),
    responses(
        (status = 200, description = "Current mirror retry state", body = ApiResponse<super::mirror_retry::MirrorRequestStatus>),
        (status = 403, description = "Forbidden - lacks event management authority", body = ProblemDetails),
        (status = 404, description = "No mirror request exists", body = ProblemDetails),
        (status = 409, description = "Mirror request is not failed or no active alliance exists", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn retry_event_mirror(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<super::mirror_retry::MirrorRequestStatus>>, AppError> {
    if kind.0 != "guild" {
        return Err(AppError::NotFound(
            "alliance mirror retries are available only in guild tenants".to_owned(),
        ));
    }
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    super::sync::assert_active_alliance(&control.0, &tenant_id).await?;
    super::mirror_retry::requeue(&control.0, &tenant_id, id).await?;
    super::mirror_retry::process_due(&control.0, &registry).await?;
    let status = super::mirror_retry::status_for_event(&control.0, &tenant_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("event mirror request not found".to_owned()))?;
    Ok(Json(ApiResponse::new(status)))
}

/// Lists selectable Discord roles for users who can create events.
#[utoipa::path(
    get,
    path = "/api/events/discord-roles",
    tag = "events",
    summary = "List Discord roles available for event announcements",
    description = "Returns non-managed roles in this tenant's Discord server. Requires events.create.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Discord roles retrieved", body = ApiResponse<Vec<DiscordRoleView>>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.create permission", body = ProblemDetails),
        (status = 502, description = "Discord API unavailable or bot token missing", body = ProblemDetails)
    )
)]
async fn list_event_discord_roles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<Vec<DiscordRoleView>>>, AppError> {
    user.require(&perms, Permission::EventsCreate).await?;
    Ok(Json(ApiResponse::new(
        AdminService::discord_roles(&cfg, &tenant.0).await?,
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
#[allow(clippy::too_many_arguments)]
async fn update_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateEventRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    if req.ping_alliance == Some(true) {
        assert_active_alliance(&control.0, &tenant_id).await?;
    }
    let service = EventService::new();
    let alliance_sync_requested = req.ping_alliance == Some(true);
    let event = service.update_event(&db, id, req).await?;
    if alliance_sync_requested {
        let actor = ShareActor {
            discord_id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
        };
        if let Err(error) =
            create_mirror(&control.0, &registry, &db, &tenant_id, &event, &actor).await
        {
            // The update is already committed: queue a retry. Only surface the
            // error when the retry itself cannot be recorded.
            tracing::error!(
                tenant_id = %tenant_id,
                event_id = id,
                error = %error,
                "event mirror creation failed after update committed; queued for retry"
            );
            super::mirror_retry::enqueue(&control.0, &tenant_id, id, &actor, &error.to_string())
                .await
                .map_err(|_| error)?;
        }
    }
    sync_source_change(&control, &registry, &db, &tenant_id, id).await?;
    Ok(Json(ApiResponse::new(
        hydrate_event_view(event, &control, &registry, &tenant_id).await,
    )))
}

/// Loads the persisted source event and propagates the change to its copies.
async fn sync_source_change(
    control: &ControlDb,
    registry: &TenantRegistry,
    db: &sea_orm::DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
) -> Result<(), AppError> {
    let Some(model) = super::entities::event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
    else {
        return Ok(());
    };
    propagate_source_change(&control.0, registry, tenant_id, &model).await
}

/// Applies one lifecycle transition for a web request, then propagates it to copies.
///
/// The transition core is shared with the scheduler and the sync engine; the route only adds
/// the caller's identity and the legacy post-commit propagation.
async fn run_transition(
    user: &UserContext,
    db: &sea_orm::DatabaseConnection,
    control: &ControlDb,
    registry: &TenantRegistry,
    tenant_id: &str,
    id: i64,
    transition: Transition,
) -> Result<EventView, AppError> {
    let done = EventService::new()
        .transition(db, id, transition, Cause::Web, Some(&user.id))
        .await?;
    done.outcome
        .after_commit(&AfterCommit::legacy_propagation(
            &control.0, registry, tenant_id,
        ))
        .await?;
    Ok(done.view)
}

/// Deletes an event.
///
/// Requires `events.delete` permission.
#[utoipa::path(
    delete,
    path = "/api/events/{id}",
    tag = "events",
    summary = "Archive an event",
    description = "Archives an event and every split linked to it. The rows stay in the database with their ids, titles, and dates. Requires `events.delete` permission.",
    security(("session_cookie" = [])),
    params(
        ("id" = i64, Path, description = "Event ID")
    ),
    responses(
        (status = 204, description = "Event archived successfully"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn delete_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsDelete).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Archive,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Archives an event and its linked splits, keeping every row.
#[utoipa::path(
    post,
    path = "/api/events/{id}/archive",
    tag = "events",
    summary = "Archive an event",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Event archived", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn archive_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsDelete).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let event = run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Archive,
    )
    .await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Restores an archived event and its linked splits to the active lists.
#[utoipa::path(
    post,
    path = "/api/events/{id}/unarchive",
    tag = "events",
    summary = "Unarchive an event",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Event restored", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 403, description = "Forbidden", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn unarchive_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsDelete).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let event = run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Unarchive,
    )
    .await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Query parameters accepted by the participate endpoint.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
struct ParticipateQuery {
    /// Explicit guild attribution, required when the caller belongs to more
    /// than one eligible guild in alliance context.
    guild_tenant_id: Option<String>,
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
        ("id" = i64, Path, description = "Event ID"),
        ("guild_tenant_id" = Option<String>, Query, description = "Explicit guild attribution, required when multiple guilds are eligible")
    ),
    request_body(content = ParticipateEventRequest, description = "Participation build choices"),
    responses(
        (status = 200, description = "Registered successfully", body = ApiResponseEventDetail),
        (status = 400, description = "Validation error (e.g. comp full, build already taken)", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event or build not found", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
async fn participate(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<i64>,
    Query(query): Query<ParticipateQuery>,
    Json(req): Json<ParticipateEventRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let request_for_sync = req.clone();
    // Resolve and persist guild attribution before touching any roster so an
    // invalid or ambiguous choice cannot leave a partial signup behind.
    let attributed_guild = resolve_join_attribution(
        &control.0,
        &tenant.0,
        id,
        &user.id,
        query.guild_tenant_id.as_deref(),
    )
    .await?;
    let (detail, version) = service
        .participate_with_roster_version(&db, id, user.user_id, req)
        .await?;
    sync_participation(
        &control.0,
        &registry,
        &tenant.0,
        id,
        &ShareActor {
            discord_id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
        },
        Some(request_for_sync),
        Some(&attributed_guild),
    )
    .await?;
    hub.publish(&tenant.0, id, version, "participation_changed", Vec::new());
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
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    let service = EventService::new();
    let (detail, version, seat_key) = service.cancel_participation(&db, id, user.user_id).await?;
    sync_participation(
        &control.0,
        &registry,
        &tenant.0,
        id,
        &ShareActor {
            discord_id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
        },
        None,
        None,
    )
    .await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        "participation cancelled"
    );
    hub.publish(
        &tenant.0,
        id,
        version,
        "participant_left",
        seat_key.into_iter().collect(),
    );
    Ok(Json(ApiResponse::new(detail)))
}

/// Lists the caller's eligible guild attributions for a linked event.
///
/// A guild tenant always returns itself. An alliance tenant returns the
/// active membership guilds the caller belongs to; more than one entry means
/// the join request must pass `guild_tenant_id`.
#[utoipa::path(
    get,
    path = "/api/events/{id}/participation-guilds",
    tag = "events",
    summary = "List eligible participation guilds",
    description = "Returns the caller's eligible active guilds for this event. In a guild tenant the only eligible guild is the tenant itself. In an alliance tenant the eligible guilds are the active member guilds the caller belongs to; pass one as `guild_tenant_id` when joining if more than one is eligible.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Eligible guilds", body = ApiResponseParticipationGuildList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Conflict - caller belongs to no active guild in this alliance", body = ProblemDetails)
    )
)]
async fn get_participation_guilds(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(control): Extension<ControlDb>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<Vec<ParticipationGuild>>>, AppError> {
    // Fail closed on unknown events so the endpoint cannot be used to probe
    // guild membership for arbitrary ids.
    super::entities::event::Entity::find_by_id(id)
        .one(&db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
    let guilds = eligible_participation_guilds(&control.0, &tenant.0, &user.id).await?;
    if guilds.is_empty() {
        return Err(AppError::Conflict(
            "you are not a member of any active guild in this alliance; join a member guild server or ask the alliance staff to add you".to_owned(),
        ));
    }
    Ok(Json(ApiResponse::new(guilds)))
}

/// Resolves the `users.id` that created the event.
async fn event_creator_id(
    db: &sea_orm::DatabaseConnection,
    event_id: i64,
) -> Result<i64, AppError> {
    Ok(super::entities::event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?
        .created_by)
}

/// Guard for an event-specific management mutation. The creator may manage
/// their own event; everyone else needs the permission for the requested action.
///
/// We intentionally avoid `UserContext::require` here because the policy is an
/// OR between a role-based permission and ownership of the row.
async fn require_event_management_authority(
    user: &UserContext,
    perms: &Permissions,
    db: &sea_orm::DatabaseConnection,
    event_id: i64,
    permission: Permission,
) -> Result<(), AppError> {
    if user.has_permission(perms, permission).await {
        return Ok(());
    }

    if event_creator_id(db, event_id).await? == user.user_id {
        return Ok(());
    }

    Err(AppError::Forbidden(format!(
        "Only the event creator or users with {} may manage this event",
        permission.as_str()
    )))
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
#[allow(clippy::too_many_arguments)]
async fn add_event_member(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<AddEventMemberRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
    let service = EventService::new();
    let (detail, version) = service.add_member_with_roster_version(&db, id, req).await?;
    tracing::info!(
        event_id = id,
        roster_version = version,
        actor_id = user.user_id,
        "event member added"
    );
    hub.publish(&tenant.0, id, version, "participation_changed", Vec::new());
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((id, target_user_id)): Path<(i64, i64)>,
    Json(req): Json<SetParticipantRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
    let service = EventService::new();
    let (detail, version) = service
        .set_participant_with_roster_version(&db, id, target_user_id, req)
        .await?;
    hub.publish(&tenant.0, id, version, "participation_changed", Vec::new());
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
pub(crate) async fn remove_participant(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(hub): Extension<RosterHub>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path((id, target_user_id)): Path<(i64, i64)>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant.0, id).await?;
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
        &tenant.0,
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
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
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

/// Reports whether the caller may manage a given event — the read-only twin of
/// the guards on start/stop/cancel/uncancel/remind. The Discord bot calls this
/// before acting on the thread control buttons, so members who cannot manage
/// an event get a clear ephemeral refusal instead of a raw mutation error.
#[utoipa::path(
    get,
    path = "/api/events/{id}/management-authority",
    tag = "events",
    summary = "Check whether the caller may manage this event",
    description = "Returns the same organizer-or-`events.edit` decision that guards \
         start/stop/cancel/uncancel/remind. Requires `events.view`.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Authority decision for the caller", body = ApiResponseEventManagementAuthority),
        (status = 401, description = "Unauthorized - no active session or linked website account", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.view permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails)
    )
)]
async fn get_event_management_authority(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventManagementAuthorityView>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let legacy = LegacyLinks {
        control: &control.0,
        tenant_id: &tenant_id,
    };
    let is_copy = copy_role(&db, legacy, SyncKind::Event, id)
        .await?
        .is_read_only();
    let is_organizer = !is_copy && event_creator_id(&db, id).await? == user.user_id;
    let can_manage =
        !is_copy && (is_organizer || user.has_permission(&perms, Permission::EventsEdit).await);
    Ok(Json(ApiResponse::new(EventManagementAuthorityView {
        is_organizer,
        can_manage,
        required_permission: Permission::EventsEdit.as_str().to_string(),
    })))
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
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<SetEventVoiceChannelRequest>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
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
    Extension(control): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
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
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let event = run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Start,
    )
    .await?;
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
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let event = run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Cancel,
    )
    .await?;
    Ok(Json(ApiResponse::new(event)))
}

/// Restores a cancelled event (status -> scheduled).
///
/// Requires `events.edit` permission. Use this to undo a mistaken cancellation.
#[utoipa::path(
    post,
    path = "/api/events/{id}/uncancel",
    tag = "events",
    summary = "Restore cancelled event",
    description = "Restores a cancelled event to scheduled so it can be started or edited again.",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Event ID")),
    responses(
        (status = 200, description = "Event restored", body = ApiResponseEventView),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - lacks events.edit permission", body = ProblemDetails),
        (status = 404, description = "Event not found", body = ProblemDetails),
        (status = 409, description = "Event is not cancelled", body = ProblemDetails)
    )
)]
async fn uncancel_event(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let event = run_transition(
        &user,
        &db,
        &control,
        &registry,
        &tenant_id,
        id,
        Transition::Uncancel,
    )
    .await?;
    Ok(Json(ApiResponse::new(event)))
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
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    // Only a detached copy reaches this point; it still awards nothing, exactly as
    // before (progression belongs to the origin tenant).
    let legacy = LegacyLinks {
        control: &control.0,
        tenant_id: &tenant_id,
    };
    let award_xp = !copy_role(&db, legacy, SyncKind::Event, id).await?.is_copy();
    let stop = Transition::Stop {
        auto: false,
        xp: XpFilter::from_award_xp(award_xp),
    };
    let event = run_transition(&user, &db, &control, &registry, &tenant_id, id, stop).await?;
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
    Extension(_cfg): Extension<Config>,
    Extension(control): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    user.require(&perms, Permission::EventsView).await?;
    let service = EventService::new();
    let context = crate::albion_scope::load_event_read_scope(&control.0, &tenant_id)
        .await?
        .linking_context();
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
#[allow(clippy::too_many_arguments)]
async fn replace_event_battles(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(_cfg): Extension<Config>,
    Extension(albionbb): Extension<AlbionBbService>,
    Extension(control): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateEventBattlesRequest>,
) -> Result<Json<ApiResponse<EventDetailView>>, AppError> {
    require_event_management_authority(&user, &perms, &db, id, Permission::EventsEdit).await?;
    assert_event_writable(&db, &control, &tenant_id, id).await?;
    let service = EventService::new();
    let scope = crate::albion_scope::load_albion_scope(&control.0, &tenant_id)
        .await
        .map_err(AppError::from)?;
    let server = scope.server();
    let context = scope.linking_context();
    let detail = service
        .replace_event_battles(&db, &albionbb, &context, Some(&server), id, req)
        .await?;
    Ok(Json(ApiResponse::new(detail)))
}

#[cfg(test)]
mod tests {
    use super::{
        EventManagementAuthorityView, get_event_management_authority, get_events_summary,
        list_event_calendar, parse_event_revision_ids, require_event_management_authority,
    };
    use crate::errors::AppError;
    use crate::modules::auth::{
        Permission, Permissions, UserContext,
        entities::{role, role_permission},
    };
    use crate::modules::comps::entities::{comp, comp_category};
    use crate::modules::events::entities::event;
    use crate::modules::users::entities as users;
    use crate::tenant::{ControlDb, CurrentTenantId};
    use axum::Extension;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ConnectionTrait, Database, DatabaseConnection,
        DbBackend, Statement,
    };
    use sea_orm_migration::MigratorTrait;

    async fn authorization_test_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("test database should connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("test database migrations should run");
        db.execute_unprepared(
            "CREATE TABLE event_sync_links (
                source_tenant_id TEXT NOT NULL,
                source_event_id BIGINT NOT NULL,
                mirror_tenant_id TEXT NOT NULL,
                mirror_event_id BIGINT NOT NULL,
                sync_enabled BOOLEAN NOT NULL DEFAULT TRUE
            )",
        )
        .await
        .expect("test event links should be created");
        db
    }

    async fn event_authority_view(
        user: UserContext,
        permissions: Permissions,
        db: &DatabaseConnection,
        event_id: i64,
    ) -> EventManagementAuthorityView {
        get_event_management_authority(
            user,
            Extension(permissions),
            Extension(db.clone()),
            Extension(ControlDb(db.clone())),
            Extension(CurrentTenantId("authorization-tenant".to_owned())),
            axum::extract::Path(event_id),
        )
        .await
        .expect("event authority should resolve")
        .0
        .data
    }

    async fn insert_authorization_test_user(db: &DatabaseConnection, name: &str) -> i64 {
        users::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("User".to_string()),
            discord_id: Set(Some(format!("discord-{name}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("test user should be inserted")
        .id
    }

    async fn insert_authorization_test_event(
        db: &DatabaseConnection,
        title: &str,
        creator_id: i64,
    ) -> i64 {
        let category_id = comp_category::ActiveModel {
            name: Set(format!("category-{title}")),
            slug: Set(format!("category-{title}").to_lowercase()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("test comp category should be inserted")
        .id;
        let comp_id = comp::ActiveModel {
            name: Set(format!("comp-{title}")),
            category_id: Set(category_id),
            created_by: Set(creator_id),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("test comp should be inserted")
        .id;
        event::ActiveModel {
            title: Set(title.to_string()),
            comp_id: Set(Some(comp_id)),
            created_by: Set(creator_id),
            event_date_utc: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("test event should be inserted")
        .id
    }

    async fn insert_test_role_with_permission(
        db: &DatabaseConnection,
        role_id: &str,
        permission: Permission,
    ) {
        role::ActiveModel {
            id: Set(role_id.to_string()),
            name: Set(format!("Test {role_id}")),
            priority: Set(50),
            discord_role_id: Set(Some(format!("discord-{role_id}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("test role should be inserted");
        role_permission::ActiveModel {
            role_id: Set(role_id.to_string()),
            permission: Set(permission.as_str().to_string()),
        }
        .insert(db)
        .await
        .expect("test role permission should be inserted");
    }

    fn authorization_test_user(user_id: i64, role: &str) -> UserContext {
        UserContext {
            id: format!("discord-{user_id}"),
            username: format!("Member {user_id}"),
            email: None,
            avatar: None,
            roles: vec![role.to_string()],
            highest_role: role.to_string(),
            user_id,
            super_admin_id: None,
            is_tenant_owner: false,
        }
    }

    #[test]
    fn parse_event_revision_ids_dedupes_and_drops_junk() {
        let ids = parse_event_revision_ids(" 3, 1,1, 2 ").unwrap();
        assert_eq!(ids, vec![1, 2, 3]);
        assert!(parse_event_revision_ids("").unwrap().is_empty());
        assert!(matches!(
            parse_event_revision_ids("1,nope"),
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn calendar_feed_requires_events_edit() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("test database should connect");
        let user = UserContext {
            id: "discord-user".to_string(),
            username: "Member".to_string(),
            email: None,
            avatar: None,
            roles: vec!["User".to_string()],
            highest_role: "User".to_string(),
            user_id: 1,
            super_admin_id: None,
            is_tenant_owner: false,
        };

        let result =
            list_event_calendar(user, Extension(Permissions::new_empty()), Extension(db)).await;

        assert!(matches!(
            result,
            Err(AppError::Forbidden(message)) if message.contains("events.edit")
        ));
    }

    #[tokio::test]
    async fn events_summary_requires_events_view() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("test database should connect");
        let user = UserContext {
            id: "discord-user".to_string(),
            username: "Member".to_string(),
            email: None,
            avatar: None,
            roles: vec!["User".to_string()],
            highest_role: "User".to_string(),
            user_id: 1,
            super_admin_id: None,
            is_tenant_owner: false,
        };

        let result =
            get_events_summary(user, Extension(Permissions::new_empty()), Extension(db)).await;

        assert!(matches!(
            result,
            Err(AppError::Forbidden(message)) if message.contains("events.view")
        ));
    }

    #[tokio::test]
    async fn event_management_allows_owners_and_requires_matching_permission_for_other_events() {
        let db = authorization_test_db().await;
        let owner_id = insert_authorization_test_user(&db, "owner").await;
        let other_owner_id = insert_authorization_test_user(&db, "other-owner").await;
        let editor_id = insert_authorization_test_user(&db, "editor").await;
        let deleter_id = insert_authorization_test_user(&db, "deleter").await;
        let first_event = insert_authorization_test_event(&db, "first", owner_id).await;
        let second_event = insert_authorization_test_event(&db, "second", other_owner_id).await;
        insert_test_role_with_permission(&db, "test-events-editor", Permission::EventsEdit).await;
        insert_test_role_with_permission(&db, "test-events-deleter", Permission::EventsDelete)
            .await;
        let permissions = Permissions::new_empty();
        permissions
            .reload(&db)
            .await
            .expect("test permissions should load");

        let owner = authorization_test_user(owner_id, "User");
        assert!(
            require_event_management_authority(
                &owner,
                &permissions,
                &db,
                first_event,
                Permission::EventsEdit
            )
            .await
            .is_ok()
        );
        assert!(
            require_event_management_authority(
                &owner,
                &permissions,
                &db,
                first_event,
                Permission::EventsDelete
            )
            .await
            .is_ok()
        );
        assert!(matches!(
            require_event_management_authority(
                &owner,
                &permissions,
                &db,
                second_event,
                Permission::EventsEdit
            )
            .await,
            Err(AppError::Forbidden(_))
        ));

        let editor = authorization_test_user(editor_id, "Test test-events-editor");
        assert!(
            require_event_management_authority(
                &editor,
                &permissions,
                &db,
                first_event,
                Permission::EventsEdit
            )
            .await
            .is_ok()
        );
        assert!(matches!(
            require_event_management_authority(
                &editor,
                &permissions,
                &db,
                first_event,
                Permission::EventsDelete
            )
            .await,
            Err(AppError::Forbidden(_))
        ));

        let deleter = authorization_test_user(deleter_id, "Test test-events-deleter");
        assert!(
            require_event_management_authority(
                &deleter,
                &permissions,
                &db,
                first_event,
                Permission::EventsDelete
            )
            .await
            .is_ok()
        );
        assert!(matches!(
            require_event_management_authority(
                &deleter,
                &permissions,
                &db,
                first_event,
                Permission::EventsEdit
            )
            .await,
            Err(AppError::Forbidden(_))
        ));

        let member = authorization_test_user(other_owner_id, "User");
        assert!(matches!(
            require_event_management_authority(
                &member,
                &permissions,
                &db,
                first_event,
                Permission::EventsEdit
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
    }

    #[tokio::test]
    async fn management_authority_reports_organizer_or_events_edit_decision() {
        let db = authorization_test_db().await;
        let owner_id = insert_authorization_test_user(&db, "authority-owner").await;
        let member_id = insert_authorization_test_user(&db, "authority-member").await;
        let event_id = insert_authorization_test_event(&db, "authority", owner_id).await;
        insert_test_role_with_permission(&db, "test-events-manager", Permission::EventsManage)
            .await;
        let permissions = Permissions::new_empty();
        permissions
            .reload(&db)
            .await
            .expect("test permissions should load");

        // The organizer may manage their own event without any role permission.
        let owner = authorization_test_user(owner_id, "User");
        let view = event_authority_view(owner, permissions.clone(), &db, event_id).await;
        assert!(view.is_organizer);
        assert!(view.can_manage);
        assert_eq!(view.required_permission, "events.edit");

        // A plain member may neither — ownership belongs to someone else.
        let member = authorization_test_user(member_id, "User");
        let view = event_authority_view(member, permissions.clone(), &db, event_id).await;
        assert!(!view.is_organizer);
        assert!(!view.can_manage);

        // Baseline roles are Admin, Moderator, and User. `events.edit` is seeded to
        // Admin and Officer, but no Officer row is created, so that grant never lands.
        // Admin is the seeded role that can manage an event it did not create.
        let admin = authorization_test_user(member_id, "Admin");
        let view = event_authority_view(admin, permissions.clone(), &db, event_id).await;
        assert!(!view.is_organizer);
        assert!(view.can_manage);

        // Moderator is seeded and only receives events.view, not events.edit.
        let moderator = authorization_test_user(member_id, "Moderator");
        let view = event_authority_view(moderator, permissions.clone(), &db, event_id).await;
        assert!(!view.is_organizer);
        assert!(!view.can_manage);

        // The legacy events.manage permission still implies the granular one.
        let manager = authorization_test_user(member_id, "Test test-events-manager");
        let view = event_authority_view(manager, permissions.clone(), &db, event_id).await;
        assert!(!view.is_organizer);
        assert!(view.can_manage);

        db.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO event_sync_links \
             (source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id, sync_enabled) \
             VALUES ('source-tenant', 123, 'authorization-tenant', $1, TRUE)",
            [event_id.into()],
        ))
        .await
        .expect("copy link should be inserted");
        let copied_owner = authorization_test_user(owner_id, "User");
        let view = event_authority_view(copied_owner, permissions.clone(), &db, event_id).await;
        assert!(!view.is_organizer);
        assert!(!view.can_manage);
        let copied_admin = authorization_test_user(member_id, "Admin");
        let view = event_authority_view(copied_admin, permissions, &db, event_id).await;
        assert!(!view.can_manage);
    }
}
