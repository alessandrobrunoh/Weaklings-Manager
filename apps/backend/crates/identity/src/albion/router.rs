//! Albion routing module.
//!
//! Exposes HTTP endpoints for browsing the configured guild's roster, generic Albion Online
//! API passthroughs, and the self-service Discord <-> Albion player link.

use super::client::{AlbionGuild, AlbionPlayer, AlbionRegion, AlbionSearchResult};
use super::service::{
    AlbionLinkService, AlbionLinkStatus, AlbionService, LinkAudit, pick_exact_player,
};
use crate::albion::schemas::{
    ApiResponseAlbionLinkStatus, ApiResponsePaginatedAlbionGuildMembers, PaginatedAlbionGuildMember,
};
use crate::auth::{Permission, Permissions, UserContext};
use crate::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantRegistry};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};
use backend_core::config::Config;
use backend_core::errors::{AppError, ProblemDetails};
use backend_core::pagination::PaginationParams;
use backend_core::responses::ApiResponse;
use serde::Deserialize;

/// Creates the router for the Albion module.
pub fn router() -> Router {
    Router::new()
        .route("/guild/roster", get(get_guild_roster))
        .route("/search", get(search))
        .route("/players/{id}", get(get_player))
        .route("/guilds/{id}", get(get_guild))
        .route("/link/me", get(get_link_status))
        .route("/link", post(link_player).delete(unlink_player))
        .route("/register", post(register_by_ign))
        .route(
            "/link/users/{user_id}",
            get(get_user_link_status)
                .post(admin_link_user_handler)
                .delete(admin_unlink_user_handler),
        )
}

async fn build_service(
    _cfg: &Config,
    control: &sea_orm::DatabaseConnection,
    tenant_id: &str,
) -> Result<AlbionService, AppError> {
    let scope = crate::albion_scope::load_albion_scope(control, tenant_id)
        .await
        .map_err(AppError::from)?;
    Ok(AlbionService::new(
        AlbionRegion::from_env_str(&scope.region),
        scope.guild_id,
    ))
}

/// Query parameters for browsing the configured guild's roster.
///
/// Pagination fields are declared inline rather than via `#[serde(flatten)]` on
/// `PaginationParams`, since axum's `Query` extractor (backed by `serde_html_form`) cannot
/// deserialize non-string fields (e.g. `u64`) through a flattened struct from a query string.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct RosterQuery {
    /// Optional case-insensitive substring filter on player name.
    pub q: Option<String>,
    /// The page number to fetch (1-indexed). Defaults to 1.
    pub page: Option<u64>,
    /// The maximum number of items per page. Defaults to 10.
    pub limit: Option<u64>,
}

impl RosterQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// List the configured guild's roster, optionally filtered by name.
#[utoipa::path(
    get,
    path = "/api/albion/guild/roster",
    tag = "albion",
    summary = "Browse the configured in-game guild's roster (for the link picker)",
    description = "This is the endpoint the \"link my Discord to my Albion character\" search box \
        should call: it lists members of **the one Albion guild configured server-side** (env \
        `ALBION_GUILD_ID`), not an arbitrary guild — there is no `guild_id` parameter. Filter with \
        `?q=<substring>` (case-insensitive match on player name); omit for the full roster. \
        Live-fetched from Albion Online's own API on every call (no caching), then filtered/paginated \
        locally, since that upstream endpoint has no query support of its own — so a large guild with \
        a narrow `limit` may feel slightly slower than a purely local query. Each `AlbionGuildMember.id` \
        is the value to send as `albion_player_id` to `POST /albion/link`.",
    security(("session_cookie" = [])),
    params(RosterQuery),
    responses(
        (status = 200, description = "Roster retrieved successfully", body = ApiResponsePaginatedAlbionGuildMembers),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_guild_roster(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Extension(crate::tenant::ControlDb(control)): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    Query(query): Query<RosterQuery>,
) -> Result<Json<ApiResponse<PaginatedAlbionGuildMember>>, AppError> {
    let service = build_service(&cfg, &control, &tenant_id).await?;
    let pagination = query.pagination();
    let paginated = service
        .search_configured_guild_roster(query.q.as_deref(), &pagination)
        .await?;

    Ok(Json(ApiResponse::new(PaginatedAlbionGuildMember::from(
        paginated,
    ))))
}

/// Query parameters for the generic Albion search passthrough.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct SearchQuery {
    /// The search term (player or guild name).
    pub q: String,
}

/// Generic passthrough to Albion Online's global search (players and guilds).
#[utoipa::path(
    get,
    path = "/api/albion/search",
    tag = "albion",
    summary = "Global Albion Online search — any player/guild, not just the configured guild",
    description = "Unlike `GET /albion/guild/roster`, this searches **all of Albion Online**, across \
        every guild, not just the one configured server-side. Returns two separate arrays — \
        `guilds` and `players` — both possibly empty. `players` lists members of the configured \
        guild first (`in_guild: true`, matched case- and diacritic-insensitively as a substring \
        against the guild roster, which is cached for 60 s), followed by every other player Albion's \
        global search returned (Albion itself caps that at 10 players per query and returns nothing \
        for a query with leading/trailing spaces or accents, so the query is trimmed and \
        accent-folded before it is forwarded). A player found by both sources appears once. If \
        Albion's global search is down but the roster answered, the call still succeeds with \
        `partial: true`; it only fails with 502 when neither source answered. This is the endpoint \
        every player picker and link flow should use. `q` requires at least 1 character.",
    security(("session_cookie" = [])),
    params(SearchQuery),
    responses(
        (status = 200, description = "Search results retrieved successfully (guilds and players arrays, either may be empty, body = ApiResponse<AlbionSearchResult>)", body = ApiResponse<AlbionSearchResult>),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn search(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Extension(crate::tenant::ControlDb(control)): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<ApiResponse<AlbionSearchResult>>, AppError> {
    let service = build_service(&cfg, &control, &tenant_id).await?;
    Ok(Json(ApiResponse::new(
        service.search_all_players(&query.q).await?,
    )))
}

/// Generic passthrough to Albion Online's player lookup.
#[utoipa::path(
    get,
    path = "/api/albion/players/{id}",
    tag = "albion",
    summary = "Get one Albion Online player's public profile by their Albion player id",
    description = "`id` is Albion Online's own opaque player identifier (e.g. as returned in \
        `AlbionPlayerSummary.id` from `GET /albion/search`, or `AlbionGuildMember.id` from the \
        roster) — **not** this app's internal integer `user_id`, and not a Discord id. Direct, \
        uncached passthrough to Sandbox Interactive's API.",
    security(("session_cookie" = [])),
    params(("id" = String, Path, description = "Albion Online player ID (opaque string, not this app's user_id)")),
    responses(
        (status = 200, description = "Player retrieved successfully", body = AlbionPlayer),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No Albion Online player exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_player(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Extension(crate::tenant::ControlDb(control)): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AlbionPlayer>, AppError> {
    let service = build_service(&cfg, &control, &tenant_id).await?;
    Ok(Json(service.get_player(&id).await?))
}

/// Generic passthrough to Albion Online's guild lookup.
#[utoipa::path(
    get,
    path = "/api/albion/guilds/{id}",
    operation_id = "get_albion_guild",
    tag = "albion",
    summary = "Get one Albion Online guild's public profile by its Albion guild id",
    description = "`id` is Albion Online's own opaque guild identifier — the same shape as the \
        server-side `ALBION_GUILD_ID` config value, but this endpoint accepts **any** guild id, not \
        just the configured one (use `GET /albion/guild/roster` for the configured guild's member \
        list specifically). Direct, uncached passthrough to Sandbox Interactive's API.",
    security(("session_cookie" = [])),
    params(("id" = String, Path, description = "Albion Online guild ID (opaque string)")),
    responses(
        (status = 200, description = "Guild retrieved successfully", body = AlbionGuild),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No Albion Online guild exists with this id", body = ProblemDetails),
        (status = 502, description = "Upstream Albion API error - Sandbox Interactive's gameinfo API failed or timed out", body = ProblemDetails)
    )
)]
pub async fn get_guild(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    Extension(crate::tenant::ControlDb(control)): Extension<crate::tenant::ControlDb>,
    Extension(crate::tenant::CurrentTenantId(tenant_id)): Extension<crate::tenant::CurrentTenantId>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AlbionGuild>, AppError> {
    let service = build_service(&cfg, &control, &tenant_id).await?;
    Ok(Json(service.get_guild(&id).await?))
}

/// Retrieves the current user's Albion player link status.
#[utoipa::path(
    get,
    path = "/api/albion/link/me",
    tag = "albion",
    summary = "Check whether the caller's Discord account is linked to an Albion character",
    description = "Call this to render the dashboard's link status (\"Linked to X\" vs. \"Not linked, \
        search below\"). Always returns `200` — check the `linked` boolean in the response, not the \
        HTTP status; there is no `404` for \"not linked\". When `linked` is `true`, \
        `albion_player_id`/`albion_player_name`/`linked_at` are populated; when `false`, all three \
        are omitted from the JSON entirely (not sent as `null`). On an alliance tenant, a link \
        already present on a member guild is copied into the alliance schema so the user is not \
        asked to link again.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Link status retrieved successfully (check the linked field, body = ApiResponse<AlbionLinkStatus>)", body = ApiResponseAlbionLinkStatus),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn get_link_status(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    let link = super::alliance_fanout::adopt_existing_member_link(
        &control.0, &registry, &cfg, &user, &tenant.0, &kind.0, &db,
    )
    .await?;
    let status = match link {
        Some(link) => AlbionLinkStatus::from(Some(link)),
        None => {
            AlbionLinkService::new()
                .status_for_discord_user(&db, &user.id)
                .await?
        }
    };
    Ok(Json(ApiResponse::new(status)))
}

/// Request body for linking the current Discord account to an Albion player.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[schema(example = json!({ "albion_player_id": "aPngkjfLT2CGiZoWXLr8UQ", "albion_player_name": "Kay" }))]
pub struct LinkPlayerRequest {
    /// The Albion Online player ID to link to, as returned by global search. The server fetches
    /// the live player profile and never trusts the client-side name or guild information.
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub albion_player_id: String,
    /// The Albion Online player's display name. Informational only: the server ignores this
    /// field and persists the name from the live Albion player profile.
    #[serde(rename = "albion_player_name")]
    #[schema(example = "Kay")]
    pub _albion_player_name: String,
}

/// Everything that must happen once a link exists: nickname, Guild base role and the copy to
/// paired alliance/guild tenants. All best effort — Discord failures never undo a link.
#[allow(clippy::too_many_arguments)]
async fn apply_link_effects(
    db: &sea_orm::DatabaseConnection,
    cfg: &Config,
    control: &ControlDb,
    registry: &TenantRegistry,
    tenant: &CurrentTenantId,
    kind: &CurrentTenantKind,
    account: &UserContext,
    player_id: &str,
    player_name: &str,
    player_guild_id: Option<&str>,
) -> Result<(), AppError> {
    super::discord_nick::sync_guild_nickname(cfg, &tenant.0, &account.id, player_name).await;
    let configured_guild = crate::albion_scope::load_albion_scope(&control.0, &tenant.0)
        .await?
        .guild_id;
    if kind.0 != "alliance"
        && super::discord_guild_role::belongs_to_configured_guild(
            player_guild_id,
            &configured_guild,
        )
    {
        super::discord_guild_role::assign_guild_role(db, cfg, &tenant.0, &account.id).await;
    }

    super::alliance_fanout::after_successful_link(
        &control.0,
        registry,
        cfg,
        account,
        &tenant.0,
        &kind.0,
        player_id,
        player_name,
        player_guild_id,
    )
    .await;
    Ok(())
}

/// Shared tail of `POST /albion/link` and `POST /albion/register`.
///
/// The link applies at once. Albion cannot prove who owns a character, so the protections that
/// need no approval stay: one character per account and one account per character (`409`), the
/// alliance guild rule, and an audit row plus a staff notification for every link.
#[allow(clippy::too_many_arguments)]
async fn claim_character(
    user: &UserContext,
    db: &sea_orm::DatabaseConnection,
    cfg: &Config,
    control: &ControlDb,
    registry: &TenantRegistry,
    tenant: &CurrentTenantId,
    kind: &CurrentTenantKind,
    player: &AlbionPlayer,
    via: &'static str,
) -> Result<AlbionLinkStatus, AppError> {
    super::alliance_fanout::assert_register_allowed(
        &control.0,
        &tenant.0,
        &kind.0,
        player.guild_id.as_deref(),
    )
    .await?;

    let link_service = AlbionLinkService::new();
    let audit = LinkAudit {
        actor_user_id: Some(user.user_id),
        via,
    };
    let link = link_service
        .create_link(db, &user.id, &player.id, &player.name, audit)
        .await?;
    apply_link_effects(
        db,
        cfg,
        control,
        registry,
        tenant,
        kind,
        user,
        &player.id,
        &player.name,
        player.guild_id.as_deref(),
    )
    .await?;
    super::notify::announce_link(db, cfg, &user.id, &user.username, player).await;
    Ok(AlbionLinkStatus::from(Some(link)))
}

/// Links the current Discord user to an Albion player.
///
/// # Errors
///
/// * Returns an upstream/not-found error if the player cannot be resolved from Albion.
/// * Returns `AppError::Conflict` if either side of the link is already claimed.
#[utoipa::path(
    post,
    path = "/api/albion/link",
    tag = "albion",
    summary = "Link the caller's Discord account to one Albion character",
    description = "The link applies immediately: the server resolves the selected player from Albion \
        and persists that authoritative name, so callers may link characters in any guild or without \
        a guild. Strictly 1:1: one Discord account holds at most one link, and one Albion \
        character belongs to at most one account — enforced by unique constraints in the \
        database, so a character already linked to someone else answers `409` (an officer holding \
        `roles.manage` can re-assign it with `POST /albion/link/users/{user_id}`). After the link \
        the backend best-effort sets the account's Discord guild nickname to the character name, \
        assigns the configured Guild base role only when the live player profile belongs to the \
        configured Albion guild, copies the link to paired alliance/guild tenants, and posts a \
        notice to the guild's audit-log Discord channel. Discord failures never roll back the link.",
    security(("session_cookie" = [])),
    request_body(content = LinkPlayerRequest, description = "The Albion character to link, as picked from GET /albion/search."),
    responses(
        (status = 200, description = "Linked; linked is true", body = ApiResponseAlbionLinkStatus),
        (status = 404, description = "No Albion player exists for the given albion_player_id", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 409, description = "Conflict - the caller's Discord account already has a link, or this Albion character is already linked to a different Discord account", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn link_player(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Json(body): Json<LinkPlayerRequest>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    let player = build_service(&cfg, &control.0, &tenant.0)
        .await?
        .get_player(&body.albion_player_id)
        .await?;
    let status = claim_character(
        &user, &db, &cfg, &control, &registry, &tenant, &kind, &player, "self",
    )
    .await?;
    Ok(Json(ApiResponse::new(status)))
}

/// Body for `POST /api/albion/register`.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct RegisterByIgnRequest {
    /// In-game name to resolve via Albion search. Must match exactly one player.
    pub ign: String,
}

/// Links the caller by Albion in-game name (unique exact match).
#[utoipa::path(
    post,
    path = "/api/albion/register",
    tag = "albion",
    summary = "Link by Albion IGN",
    description = "Searches Albion for `ign`, requires a unique exact name match, then behaves \
        exactly like `POST /api/albion/link`: the link applies immediately. Zero hits are 404; two \
        or more exact hits are 400. The name is matched case- and diacritic-insensitively against \
        the guild roster and Albion's global search; when several players share the name, the \
        single one in the configured guild wins, otherwise the call is rejected as ambiguous.",
    security(("session_cookie" = [])),
    request_body(content = RegisterByIgnRequest),
    responses(
        (status = 200, description = "Linked; linked is true", body = ApiResponseAlbionLinkStatus),
        (status = 400, description = "Empty or ambiguous IGN", body = ProblemDetails),
        (status = 404, description = "No player with that exact name", body = ProblemDetails),
        (status = 409, description = "Already linked", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn register_by_ign(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
    Json(body): Json<RegisterByIgnRequest>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    let service = build_service(&cfg, &control.0, &tenant.0).await?;
    let search = service.search_all_players(&body.ign).await?;
    let summary = pick_exact_player(&search.players, &body.ign)?;
    let player = service.get_player(&summary.id).await?;
    let status = claim_character(
        &user, &db, &cfg, &control, &registry, &tenant, &kind, &player, "register",
    )
    .await?;
    Ok(Json(ApiResponse::new(status)))
}

/// Unlinks the current Discord user from their Albion player.
///
/// # Errors
///
/// Returns `AppError::NotFound` if the account has no active link.
#[utoipa::path(
    delete,
    path = "/api/albion/link",
    tag = "albion",
    summary = "Unlink the caller's Discord account from its Albion character",
    description = "No request body. Frees the Albion character up so it (or a different one) can be \
        linked again, by this account or another. Not idempotent-by-design: calling this when there's \
        no link returns `404`, so a naive \"always call unlink then re-link\" \
        client pattern must handle that case (or check `GET /albion/link/me` first).",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Link removed successfully; data is null"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "No link exists for this account", body = ProblemDetails)
    )
)]
pub async fn unlink_player(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(control): Extension<ControlDb>,
    Extension(registry): Extension<TenantRegistry>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    let link_service = AlbionLinkService::new();
    let audit = LinkAudit {
        actor_user_id: Some(user.user_id),
        via: "self",
    };
    link_service.delete_link(&db, &user.id, audit).await?;
    super::discord_guild_role::revoke_guild_role(&db, &cfg, &tenant.0, &user.id).await;
    super::alliance_fanout::after_successful_unlink(
        &control.0, &registry, &cfg, &user.id, &tenant.0,
    )
    .await;
    Ok(Json(ApiResponse::new(())))
}

/// Retrieves the Albion player link status for a specific user.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller requests another user's status without
///   `roles.manage`.
/// * Returns `AppError::NotFound` if the target user does not exist.
#[utoipa::path(
    get,
    path = "/api/albion/link/users/{user_id}",
    tag = "albion",
    summary = "Get one user's Albion player link status",
    description = "Same response shape as `GET /albion/link/me`. Callers may always fetch their own \
        status; fetching another user's status requires `roles.manage`.",
    security(("session_cookie" = [])),
    params(("user_id" = i64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Link status retrieved successfully", body = ApiResponseAlbionLinkStatus),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - requires roles.manage to view another user's link status", body = ProblemDetails),
        (status = 404, description = "Target user not found", body = ProblemDetails)
    )
)]
pub async fn get_user_link_status(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Path(user_id): Path<i64>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    if user.user_id != user_id {
        user.require(&perms, Permission::RolesManage).await?;
    }
    let link_service = AlbionLinkService::new();
    Ok(Json(ApiResponse::new(
        link_service.status_for_user_id(&db, user_id).await?,
    )))
}

/// Admin endpoint to link any user to an Albion player.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks `roles.manage`.
/// * Returns an upstream/not-found error if the player cannot be resolved from Albion.
/// * Returns `AppError::Validation` if the target user has no Discord ID.
/// * Returns `AppError::NotFound` if the target user does not exist.
#[utoipa::path(
    post,
    path = "/api/albion/link/users/{user_id}",
    tag = "albion",
    summary = "Admin: link or re-link any user to an Albion character",
    description = "Requires `roles.manage`. Unlike the self-service `POST /albion/link`, this always \
        succeeds in replacing any existing link: it deletes the target user's current link (if any) \
        and any other account's claim on the requested Albion character before creating the new link, \
        all in a single transaction, and writes an `ALBION_RELINK` (or `ALBION_LINK`) audit row \
        naming both replaced links; an account that lost its claim has its guild role revoked. \
        The server resolves the selected player from Albion and persists \
        that authoritative name. After a successful link the backend best-effort sets the target \
        user's Discord guild nickname to the Albion character name.",
    security(("session_cookie" = ["roles.manage"])),
    params(("user_id" = i64, Path, description = "Internal user id")),
    request_body(content = LinkPlayerRequest, description = "The Albion character to claim, as picked from GET /albion/search."),
    responses(
        (status = 200, description = "Player linked successfully; linked is now true", body = ApiResponseAlbionLinkStatus),
        (status = 400, description = "Validation error - target user has no Discord ID", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - requires roles.manage", body = ProblemDetails),
        (status = 404, description = "Target user not found, or no Albion player exists for the given albion_player_id", body = ProblemDetails)
    )
)]
#[allow(clippy::too_many_arguments)]
pub async fn admin_link_user_handler(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(control): Extension<ControlDb>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(user_id): Path<i64>,
    Json(body): Json<LinkPlayerRequest>,
) -> Result<Json<ApiResponse<AlbionLinkStatus>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;

    let player = build_service(&cfg, &control.0, &tenant.0)
        .await?
        .get_player(&body.albion_player_id)
        .await?;

    let link_service = AlbionLinkService::new();
    let outcome = link_service
        .admin_link_user(&db, user_id, &player.id, &player.name, user.user_id)
        .await?;
    let link = outcome.link;
    if let Some(displaced) = &outcome.displaced_discord_id {
        // The previous claimant no longer owns a character, so they must not keep its guild role.
        super::discord_guild_role::revoke_guild_role(&db, &cfg, &tenant.0, displaced).await;
    }

    super::discord_nick::sync_guild_nickname(&cfg, &tenant.0, &link.discord_id, &player.name).await;

    Ok(Json(ApiResponse::new(AlbionLinkStatus::from(Some(link)))))
}

/// Admin endpoint to unlink any user from their Albion player.
///
/// # Errors
///
/// * Returns `AppError::Forbidden` if the caller lacks `roles.manage`.
/// * Returns `AppError::NotFound` if the target user does not exist.
#[utoipa::path(
    delete,
    path = "/api/albion/link/users/{user_id}",
    tag = "albion",
    summary = "Admin: unlink any user from their Albion character",
    description = "Requires `roles.manage`. Idempotent, unlike the self-service `DELETE /albion/link`: \
        succeeds whether or not the target user currently has a link. When a link is removed, the \
        backend best-effort revokes the configured Discord guild role from the target user.",
    security(("session_cookie" = ["roles.manage"])),
    params(("user_id" = i64, Path, description = "Internal user id")),
    responses(
        (status = 200, description = "Unlinked successfully (or already had no link); data is null"),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Forbidden - requires roles.manage", body = ProblemDetails),
        (status = 404, description = "Target user not found", body = ProblemDetails)
    )
)]
pub async fn admin_unlink_user_handler(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Extension(cfg): Extension<Config>,
    Extension(tenant): Extension<CurrentTenantId>,
    Path(user_id): Path<i64>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    user.require(&perms, Permission::RolesManage).await?;
    let link_service = AlbionLinkService::new();
    if let Some(discord_id) = link_service
        .admin_unlink_user(&db, user_id, user.user_id)
        .await?
    {
        super::discord_guild_role::revoke_guild_role(&db, &cfg, &tenant.0, &discord_id).await;
    }
    Ok(Json(ApiResponse::new(())))
}
