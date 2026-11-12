//! An event shared across tenants is one event, owned by the tenant that created it.
//!
//! The other tenants (the alliance hub for a guild's event, every member guild for an alliance
//! event) hold a *link*: an event row that carries only what is local to their Discord server
//! (announcement thread, signup card, delivery mode) and an `event_sync_links` row pointing at
//! the origin.
//!
//! This middleware sits in front of the events router. A request addressed to a link
//! (`/api/events/{link id}/...`) is authenticated against the caller's own tenant (their roles and
//! permissions decide what they may do), then re-addressed to the origin event: the handler runs
//! against the origin tenant's database with the caller's user row there (found, or created, by
//! Discord id), so a signup, a seat assignment or a start made from the alliance lands on the one
//! roster every tenant reads. The response is rewritten back to the link's id, and the live roster
//! socket of a link subscribes to the origin's channel, so every viewer of every tenant sees the
//! same changes in real time.
//!
//! Authority follows the tenant the caller stands in:
//!
//! * anyone may sign up, leave and read, as on the origin;
//! * the origin's creator and the origin tenant's `events.manage` holders manage through their own
//!   tenant as usual (no link is involved);
//! * `events.manage` holders of an **alliance** tenant manage the events shared with it, from the
//!   link;
//! * a member guild's officers do not manage an alliance event through their guild's link: for
//!   them the guild's `events.manage` is not honoured (nor its owner's bypass), so only the
//!   event's own creator, resolved by Discord id, can.
//!
//! Only the bot's bookkeeping of the link's own Discord delivery stays local.

use axum::{
    body::{Body, to_bytes},
    extract::{FromRequestParts, Request},
    http::{HeaderValue, Method, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, Statement};
use serde_json::{Map, Value};

use backend_core::errors::AppError;
use backend_entities::events::event;
use backend_identity::auth::{Permissions, ResolvedUserContext, UserContext};
use backend_identity::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantRegistry};
use backend_identity::users::identity::upsert_discord_user;
use backend_runtime::sync::event_links::canonical_event_origin;

/// Largest JSON body rewritten on the way back. Event responses are far smaller; a larger body is
/// passed through untouched rather than buffered.
const MAX_REWRITE_BYTES: usize = 8 * 1024 * 1024;

/// Route segments after `/{id}` that act on the link row itself, not on the shared event.
///
/// The VOD forum post is the bot's delivery bookkeeping for the row it is called on. A link never
/// requests a post (the VOD belongs to the origin's Discord), so these stay local.
const LOCAL_SEGMENTS: &[&str] = &["vod-forum-post"];

/// The link a request was re-addressed through, for handlers that must answer in the caller's
/// terms (the live roster socket reports the link id, not the origin id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventLink {
    /// Tenant that holds the link and that the caller belongs to.
    pub link_tenant_id: String,
    /// `guild` or `alliance`: the kind of [`Self::link_tenant_id`].
    pub link_tenant_kind: String,
    /// The link's event id in [`Self::link_tenant_id`].
    pub link_event_id: i64,
    /// Tenant that owns the event.
    pub origin_tenant_id: String,
    /// The event's id in [`Self::origin_tenant_id`].
    pub origin_event_id: i64,
}

/// What the response rewrite needs besides the link itself: where the link row lives (for its
/// Discord-local fields) and the control plane (for the origin's display name).
struct LinkSide {
    link_db: DatabaseConnection,
    control: DatabaseConnection,
}

/// The event id and the rest of the path of an event-scoped request (`/{id}/rest`).
fn event_scoped_path(path: &str) -> Option<(i64, &str)> {
    let trimmed = path.strip_prefix('/')?;
    let (first, rest) = trimmed.split_once('/').unwrap_or((trimmed, ""));
    let id = first.parse::<i64>().ok()?;
    Some((id, rest))
}

/// Whether a request on this sub-path stays on the link row.
fn is_local(rest: &str) -> bool {
    let segment = rest.split('/').next().unwrap_or("");
    LOCAL_SEGMENTS.contains(&segment)
}

/// Whether a request changes the Discord voice channel of the event.
///
/// The voice channel belongs to the Discord server of the owning tenant: its id means nothing in
/// any other server, so a link can neither set nor clear it.
fn is_voice_channel_write(method: &Method, rest: &str) -> bool {
    let segment = rest.split('/').next().unwrap_or("");
    segment == "discord-voice-channel" && method != Method::GET && method != Method::HEAD
}

fn readdress(uri: &Uri, origin_event_id: i64, rest: &str) -> Result<Uri, AppError> {
    let mut path = format!("/{origin_event_id}");
    if !rest.is_empty() {
        path.push('/');
        path.push_str(rest);
    }
    if let Some(query) = uri.query() {
        path.push('?');
        path.push_str(query);
    }
    path.parse::<Uri>()
        .map_err(|error| AppError::Internal(format!("could not re-address event request: {error}")))
}

/// Re-addresses requests on an event link to the origin event (see the module docs).
pub async fn proxy_event_links(req: Request, next: Next) -> Response {
    match resolve(req).await {
        Ok(Resolved::PassThrough(req)) => next.run(req).await,
        Ok(Resolved::Linked(req, link, side)) => {
            let response = next.run(*req).await;
            rewrite_response(response, &link, &side).await
        }
        Err(error) => error.into_response(),
    }
}

enum Resolved {
    PassThrough(Request),
    Linked(Box<Request>, EventLink, LinkSide),
}

async fn resolve(req: Request) -> Result<Resolved, AppError> {
    let Some((link_event_id, rest)) = event_scoped_path(req.uri().path()) else {
        return Ok(Resolved::PassThrough(req));
    };
    if is_local(rest) {
        return Ok(Resolved::PassThrough(req));
    }
    let (Some(tenant), Some(control), Some(registry)) = (
        req.extensions().get::<CurrentTenantId>().cloned(),
        req.extensions().get::<ControlDb>().cloned(),
        req.extensions().get::<TenantRegistry>().cloned(),
    ) else {
        return Ok(Resolved::PassThrough(req));
    };
    let (origin_tenant_id, origin_event_id) =
        canonical_event_origin(&control.0, &tenant.0, link_event_id).await?;
    if origin_tenant_id == tenant.0 {
        return Ok(Resolved::PassThrough(req));
    }
    if is_voice_channel_write(req.method(), rest) {
        return Err(AppError::Conflict(
            "the voice channel belongs to the Discord server that owns this event".to_owned(),
        ));
    }

    let link_kind = req
        .extensions()
        .get::<CurrentTenantKind>()
        .map(|kind| kind.0.clone())
        .unwrap_or_default();
    let link_permissions = req.extensions().get::<Permissions>().cloned();
    let link_db = req.extensions().get::<DatabaseConnection>().cloned();
    let (Some(link_db), Some(link_permissions)) = (link_db, link_permissions) else {
        return Ok(Resolved::PassThrough(req));
    };

    let rest = rest.to_owned();
    let (mut parts, body) = req.into_parts();
    // Authenticate in the caller's own tenant: their roles, owner flag and permissions are the
    // ones that decide what they may do, wherever the event lives.
    let mut user = UserContext::from_request_parts(&mut parts, &()).await?;
    let origin = registry.get_or_load(&origin_tenant_id).await?;
    if user.user_id > 0 {
        // The caller acts on the origin's rows, so they need a user row there. It is created as a
        // member Discord has not confirmed in that tenant: it never makes them a guild member.
        user.user_id =
            upsert_discord_user(&origin.db, &user.id, &user.username, "", "User", false).await?;
    }
    if link_kind != "alliance" {
        // A member guild's officers manage their own guild's events, not the alliance's: the
        // guild's `events.manage` (and its owner bypass) stops at the guild's border.
        user.is_tenant_owner = false;
        parts
            .extensions
            .insert(link_permissions.without_events_manage().await);
    }

    let link = EventLink {
        link_tenant_id: tenant.0.clone(),
        link_tenant_kind: link_kind,
        link_event_id,
        origin_tenant_id: origin_tenant_id.clone(),
        origin_event_id,
    };
    parts.uri = readdress(&parts.uri, origin_event_id, &rest)?;
    parts.extensions.insert(ResolvedUserContext(user));
    parts.extensions.insert(origin.db.clone());
    parts.extensions.insert(CurrentTenantId(origin_tenant_id));
    parts.extensions.insert(CurrentTenantKind(origin.kind.clone()));
    parts.extensions.insert(link.clone());
    tracing::debug!(
        link_tenant = %link.link_tenant_id,
        link_event_id,
        origin_tenant = %link.origin_tenant_id,
        origin_event_id,
        "event request re-addressed to its origin"
    );
    Ok(Resolved::Linked(
        Box::new(Request::from_parts(parts, body)),
        link,
        LinkSide {
            link_db,
            control: control.0,
        },
    ))
}

fn is_json(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json") || value.contains("+json"))
}

async fn rewrite_response(response: Response, link: &EventLink, side: &LinkSide) -> Response {
    if !is_json(&response) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_REWRITE_BYTES).await else {
        tracing::warn!(
            origin_event_id = link.origin_event_id,
            "event response too large to re-address; returned as an error"
        );
        return AppError::Internal("event response too large".to_owned()).into_response();
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let local = load_link_local(side, link).await;
    readdress_json(&mut value, link, &local);
    let Ok(rewritten) = serde_json::to_vec(&value) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    if let Ok(length) = HeaderValue::from_str(&rewritten.len().to_string()) {
        parts.headers.insert(header::CONTENT_LENGTH, length);
    }
    Response::from_parts(parts, Body::from(rewritten))
}

/// The fields of an event view that belong to the link's own Discord server rather than to the
/// shared event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkLocal {
    /// Display name of the owning tenant, when known.
    pub origin_name: Option<String>,
    /// The link's own delivery mode.
    pub discord_delivery: Option<String>,
    /// The link's own Discord voice channel (always empty: it belongs to the origin's server).
    pub discord_voice_channel_id: Option<String>,
    /// The link's own alliance-channel message id.
    pub alliance_discord_message_id: Option<String>,
    /// Whether the link requests a VOD post (never).
    pub vod_forum_post_enabled: bool,
    /// Delivery state of the link's VOD post.
    pub vod_forum_post_status: Option<String>,
    /// Thread of the link's VOD post.
    pub vod_forum_thread_id: Option<String>,
    /// Whether the link row itself was found.
    pub has_row: bool,
}

async fn load_link_local(side: &LinkSide, link: &EventLink) -> LinkLocal {
    let mut local = LinkLocal {
        origin_name: tenant_name(&side.control, &link.origin_tenant_id).await,
        ..LinkLocal::default()
    };
    match event::Entity::find_by_id(link.link_event_id)
        .one(&side.link_db)
        .await
    {
        Ok(Some(row)) => {
            local.has_row = true;
            local.discord_delivery = Some(row.discord_delivery);
            local.discord_voice_channel_id = row.discord_voice_channel_id;
            local.alliance_discord_message_id = row.alliance_discord_message_id;
            local.vod_forum_post_enabled = row.vod_forum_post_enabled;
            local.vod_forum_post_status = Some(row.vod_forum_post_status);
            local.vod_forum_thread_id = row.vod_forum_thread_id;
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(
            link_event_id = link.link_event_id,
            %error,
            "could not read the link row to localize an event response"
        ),
    }
    local
}

async fn tenant_name(control: &DatabaseConnection, tenant_id: &str) -> Option<String> {
    control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT name FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get_by_index::<String>(0).ok())
}

/// Whether a JSON object is an event view (the shape every event response nests).
fn is_event_view(object: &Map<String, Value>) -> bool {
    object.contains_key("event_date_utc") && object.contains_key("status")
}

/// Rewrites the origin's event id to the link's, wherever the response names this event.
///
/// An event view gets the link's id, is marked as a link (`is_link`, with the origin's identity)
/// and takes the link's own Discord-local fields back (delivery mode, voice channel, VOD, alliance
/// ping), so the link's server announces the event under its own settings. Any `event_id` naming
/// the origin event (roster, participants, seats) is pointed at the link too. Ids of other
/// entities (users, builds, comps) belong to the origin tenant and are left as they are: every
/// follow-up request on the link is re-addressed to the origin, where those ids are valid.
pub fn readdress_json(value: &mut Value, link: &EventLink, local: &LinkLocal) {
    match value {
        Value::Object(object) => {
            if is_event_view(object)
                && object.get("id").and_then(Value::as_i64) == Some(link.origin_event_id)
            {
                localize_event_view(object, link, local);
            }
            if object.get("event_id").and_then(Value::as_i64) == Some(link.origin_event_id) {
                object.insert("event_id".to_owned(), Value::from(link.link_event_id));
            }
            for child in object.values_mut() {
                readdress_json(child, link, local);
            }
        }
        Value::Array(items) => {
            for item in items {
                readdress_json(item, link, local);
            }
        }
        _ => {}
    }
}

fn localize_event_view(object: &mut Map<String, Value>, link: &EventLink, local: &LinkLocal) {
    object.insert("id".to_owned(), Value::from(link.link_event_id));
    object.insert("is_link".to_owned(), Value::Bool(true));
    object.insert(
        "source_tenant_id".to_owned(),
        Value::from(link.origin_tenant_id.clone()),
    );
    object.insert(
        "source_event_id".to_owned(),
        Value::from(link.origin_event_id),
    );
    object.insert(
        "source_tenant_name".to_owned(),
        local
            .origin_name
            .clone()
            .map_or(Value::Null, Value::from),
    );
    // The roles, alliance channel and voice channel of the origin's Discord server mean nothing
    // in the link's: the link's server announces under its own settings.
    object.insert("discord_role_ids".to_owned(), Value::Array(Vec::new()));
    object.insert("ping_alliance".to_owned(), Value::Bool(false));
    object.insert("alliance_discord_channel_id".to_owned(), Value::Null);
    object.insert("alliance_discord_role_ids".to_owned(), Value::Array(Vec::new()));
    object.insert("origin_guild_id".to_owned(), Value::Null);
    if !local.has_row {
        object.insert("discord_voice_channel_id".to_owned(), Value::Null);
        object.insert("alliance_discord_message_id".to_owned(), Value::Null);
        object.insert("vod_forum_post_enabled".to_owned(), Value::Bool(false));
        return;
    }
    let string_or_null = |value: &Option<String>| value.clone().map_or(Value::Null, Value::from);
    if let Some(delivery) = &local.discord_delivery {
        object.insert(
            "discord_delivery".to_owned(),
            Value::from(super::links::announcement_delivery(delivery, true)),
        );
    }
    object.insert(
        "discord_voice_channel_id".to_owned(),
        string_or_null(&local.discord_voice_channel_id),
    );
    object.insert(
        "alliance_discord_message_id".to_owned(),
        string_or_null(&local.alliance_discord_message_id),
    );
    object.insert(
        "vod_forum_post_enabled".to_owned(),
        Value::Bool(local.vod_forum_post_enabled),
    );
    if let Some(status) = &local.vod_forum_post_status {
        object.insert("vod_forum_post_status".to_owned(), Value::from(status.clone()));
    }
    object.insert(
        "vod_forum_thread_id".to_owned(),
        string_or_null(&local.vod_forum_thread_id),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn link() -> EventLink {
        EventLink {
            link_tenant_id: "alliance".to_owned(),
            link_tenant_kind: "alliance".to_owned(),
            link_event_id: 29,
            origin_tenant_id: "guild".to_owned(),
            origin_event_id: 213,
        }
    }

    #[test]
    fn event_scoped_paths_are_recognised() {
        assert_eq!(event_scoped_path("/29"), Some((29, "")));
        assert_eq!(event_scoped_path("/29/roster/live"), Some((29, "roster/live")));
        assert_eq!(event_scoped_path("/"), None);
        assert_eq!(event_scoped_path("/calendar"), None);
        assert_eq!(event_scoped_path("/vod-forum-posts/pending"), None);
    }

    #[test]
    fn only_the_links_own_delivery_bookkeeping_stays_local() {
        assert!(is_local("vod-forum-post/claim"));
        assert!(!is_local(""));
        assert!(!is_local("participate"));
        assert!(!is_local("roster/seats/R1-1"));
        assert!(!is_local("start"));
    }

    #[test]
    fn a_link_can_read_but_not_write_the_voice_channel() {
        assert!(is_voice_channel_write(&Method::PUT, "discord-voice-channel"));
        assert!(is_voice_channel_write(&Method::DELETE, "discord-voice-channel"));
        assert!(!is_voice_channel_write(&Method::GET, "discord-voice-channel"));
        assert!(!is_voice_channel_write(&Method::PUT, "participate"));
    }

    #[test]
    fn readdressing_keeps_the_rest_of_the_path_and_the_query() {
        let uri: Uri = "/29/participate?guild_tenant_id=g1".parse().unwrap();
        let readdressed = readdress(&uri, 213, "participate").unwrap();
        assert_eq!(readdressed.to_string(), "/213/participate?guild_tenant_id=g1");
        let bare: Uri = "/29".parse().unwrap();
        assert_eq!(readdress(&bare, 213, "").unwrap().to_string(), "/213");
    }

    #[test]
    fn responses_name_the_link_not_the_origin() {
        let mut value = json!({
            "data": {
                "id": 213,
                "event_date_utc": "2026-11-11T20:00:00Z",
                "status": "scheduled",
                "is_link": false,
                "participants": [{ "event_id": 213, "user_id": 7 }],
                "splits": [{ "id": 213, "event_id": 213 }],
                "comp_id": 213
            }
        });
        let local = LinkLocal {
            origin_name: Some("Guild".to_owned()),
            ..LinkLocal::default()
        };
        readdress_json(&mut value, &link(), &local);
        let data = &value["data"];
        assert_eq!(data["id"], 29);
        assert_eq!(data["is_link"], true);
        assert_eq!(data["source_tenant_id"], "guild");
        assert_eq!(data["source_event_id"], 213);
        assert_eq!(data["source_tenant_name"], "Guild");
        assert_eq!(data["participants"][0]["event_id"], 29);
        assert_eq!(data["participants"][0]["user_id"], 7, "origin user ids are kept");
        assert_eq!(data["splits"][0]["id"], 213, "a split is not an event view");
        assert_eq!(data["splits"][0]["event_id"], 29);
        assert_eq!(data["comp_id"], 213);
    }

    #[test]
    fn the_links_discord_fields_replace_the_origins() {
        let mut value = json!({
            "id": 213,
            "event_date_utc": "2026-11-11T20:00:00Z",
            "status": "scheduled",
            "discord_delivery": "forum",
            "discord_role_ids": ["origin-role"],
            "ping_alliance": true,
            "alliance_discord_channel_id": "origin-channel",
            "origin_guild_id": "guild",
            "discord_voice_channel_id": "origin-voice",
            "vod_forum_post_enabled": true
        });
        let local = LinkLocal {
            has_row: true,
            discord_delivery: Some("calendar".to_owned()),
            discord_voice_channel_id: None,
            vod_forum_post_enabled: false,
            vod_forum_post_status: Some("not_requested".to_owned()),
            ..LinkLocal::default()
        };
        readdress_json(&mut value, &link(), &local);
        assert_eq!(
            value["discord_delivery"], "message",
            "a shared event is announced publicly even where the server keeps a calendar"
        );
        assert_eq!(value["discord_role_ids"], json!([]));
        assert_eq!(value["ping_alliance"], false);
        assert_eq!(value["alliance_discord_channel_id"], Value::Null);
        assert_eq!(value["origin_guild_id"], Value::Null);
        assert_eq!(value["discord_voice_channel_id"], Value::Null);
        assert_eq!(value["vod_forum_post_enabled"], false);
        assert_eq!(value["vod_forum_post_status"], "not_requested");
    }

    #[test]
    fn unrelated_event_views_are_left_alone() {
        let mut value = json!({ "id": 5, "event_date_utc": "x", "status": "live", "event_id": 6 });
        readdress_json(&mut value, &link(), &LinkLocal::default());
        assert_eq!(value["id"], 5);
        assert_eq!(value["event_id"], 6);
        assert!(value.get("source_event_id").is_none());
    }
}
