//! HTTP handlers for the capabilities documents.

use std::collections::HashSet;

use axum::{
    Extension, Json, Router,
    extract::Path,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

use super::model::{
    ActorFacts, AllianceBlock, ApiResponseCapabilities, Capabilities, TenantFacts, build,
};
use crate::admin::service::AdminService;
use crate::auth::{BotSecret, Permission, Permissions, UserContext};
use crate::tenant::{ControlDb, CurrentTenantId, CurrentTenantKind, TenantFeatures, load_features};
use backend_core::errors::AppError;
use backend_core::responses::ApiResponse;

/// Response header carrying the tenant part of the capabilities version.
pub const CAPABILITIES_VERSION_HEADER: &str = "x-capabilities-version";

/// Routes mounted under `/api/me`.
pub fn router() -> Router {
    Router::new().route("/capabilities", get(me_capabilities))
}

/// What the signed-in user may see and use in the current tenant.
///
/// # Errors
///
/// Returns a database error if the tenant row, the alliance link or the
/// guild settings cannot be read.
#[utoipa::path(
    get,
    path = "/api/me/capabilities",
    tag = "capabilities",
    responses(
        (status = 200, description = "Modules, commands and navigation for the signed-in user", body = ApiResponseCapabilities),
        (status = 304, description = "The If-None-Match ETag still matches; no body")
    ),
    security(("session_cookie" = []))
)]
#[allow(
    clippy::too_many_arguments,
    reason = "one extractor per tenant fact; a wrapper extractor would only move them"
)]
pub async fn me_capabilities(
    user: UserContext,
    headers: HeaderMap,
    Extension(perms): Extension<Permissions>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(tenant): Extension<CurrentTenantId>,
    Extension(kind): Extension<CurrentTenantKind>,
    Extension(features): Extension<TenantFeatures>,
) -> Result<Response, AppError> {
    let (name, _, status) = tenant_row(&control, &tenant.0).await?;
    let timezone = AdminService::get_guild_settings(&db)
        .await?
        .discord_event_timezone;
    let alliance = alliance_block(&control, &tenant.0, &kind.0, &name).await?;

    let mut granted = HashSet::new();
    for permission in Permission::all() {
        if user.has_permission(&perms, *permission).await {
            granted.insert(*permission);
        }
    }
    let facts = TenantFacts {
        id: tenant.0.clone(),
        name,
        kind: kind.0.clone(),
        status,
        timezone: Some(timezone),
        alliance,
        features: features.0.clone(),
    };
    let actor = ActorFacts {
        user_id: user.user_id,
        is_owner: user.is_tenant_owner,
        is_platform_admin: user.is_superadmin(),
        granted,
    };
    Ok(conditional_response(&headers, &build(&facts, Some(&actor))))
}

/// The bot's view of a guild: modules and commands, no user, for command registration.
///
/// # Errors
///
/// Returns `404` when the tenant is not registered, or a database error.
#[utoipa::path(
    get,
    path = "/api/tenants/{id}/capabilities",
    tag = "capabilities",
    params(("id" = String, Path, description = "Discord guild id")),
    responses(
        (status = 200, description = "Modules and commands of the tenant, for the bot", body = ApiResponseCapabilities),
        (status = 304, description = "The If-None-Match ETag still matches; no body")
    )
)]
pub async fn tenant_capabilities(
    _bot: BotSecret,
    headers: HeaderMap,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let (name, kind, status) = tenant_row(&control, &id).await?;
    let features = load_features(&control, &id).await?;
    let alliance = alliance_block(&control, &id, &kind, &name).await?;
    let facts = TenantFacts {
        id,
        name,
        kind,
        status,
        timezone: None,
        alliance,
        features,
    };
    Ok(conditional_response(&headers, &build(&facts, None)))
}

/// The document as JSON with its validators, or `304` when the client already has it.
///
/// The `ETag` is the whole-document `version`: tenant name, timezone, alliance link
/// and, for a user, their roles. `X-Capabilities-Version` carries the tenant validator
/// (catalogue, kind, status, features), so a client can tell "the tenant's modules
/// changed" from "my roles changed".
pub fn conditional_response(headers: &HeaderMap, caps: &Capabilities) -> Response {
    let etag = format!("\"{}\"", caps.version);
    let not_modified = headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|raw| raw.split(','))
        .map(str::trim)
        .any(|candidate| {
            candidate == "*"
                || candidate == etag
                || candidate.strip_prefix("W/") == Some(etag.as_str())
        });
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(ApiResponse::new(caps.clone())).into_response()
    };
    let validators = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        validators.insert(header::ETAG, value);
    }
    if let Ok(value) = HeaderValue::from_str(&caps.tenant_version) {
        validators.insert(HeaderName::from_static(CAPABILITIES_VERSION_HEADER), value);
    }
    validators.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response
}

/// `(name, kind, status)` of a registered tenant.
async fn tenant_row(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<(String, String, String), AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT name, kind, status FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let Some(row) = row else {
        return Err(AppError::NotFound(format!(
            "tenant {tenant_id} is not registered"
        )));
    };
    Ok((
        row.try_get_by_index(0).map_err(AppError::Database)?,
        row.try_get_by_index(1).map_err(AppError::Database)?,
        row.try_get_by_index(2).map_err(AppError::Database)?,
    ))
}

/// The alliance a tenant belongs to. An alliance tenant is its own hub.
async fn alliance_block(
    control: &DatabaseConnection,
    tenant_id: &str,
    kind: &str,
    name: &str,
) -> Result<Option<AllianceBlock>, AppError> {
    if kind == "alliance" {
        return Ok(Some(AllianceBlock {
            id: tenant_id.to_owned(),
            name: name.to_owned(),
            role: "hub".to_owned(),
        }));
    }
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT t.id, t.name FROM alliance_memberships m \
             JOIN tenants t ON t.id = m.alliance_tenant_id \
             WHERE m.guild_tenant_id = $1 AND m.status = 'active' LIMIT 1",
            [tenant_id.into()],
        ))
        .await
        .map_err(AppError::Database)?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(AllianceBlock {
        id: row.try_get_by_index(0).map_err(AppError::Database)?,
        name: row.try_get_by_index(1).map_err(AppError::Database)?,
        role: "member".to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> TenantFacts {
        TenantFacts {
            id: "123".to_owned(),
            name: "Weaklings".to_owned(),
            kind: "guild".to_owned(),
            status: "active".to_owned(),
            timezone: Some("Europe/Rome".to_owned()),
            alliance: None,
            features: HashSet::new(),
        }
    }

    fn with_if_none_match(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn matching_etag_gets_304_and_the_validators_stay_on_the_response() {
        let caps = build(&facts(), None);
        let etag = format!("\"{}\"", caps.version);

        let not_modified = conditional_response(&with_if_none_match(&etag), &caps);
        assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            not_modified.headers().get(header::ETAG).unwrap(),
            etag.as_str()
        );

        let weak = conditional_response(&with_if_none_match(&format!("W/{etag}")), &caps);
        assert_eq!(weak.status(), StatusCode::NOT_MODIFIED);
    }

    #[test]
    fn a_stale_or_absent_etag_gets_the_full_document_with_the_version_header() {
        let caps = build(&facts(), None);

        let stale = conditional_response(&with_if_none_match("\"0000\""), &caps);
        assert_eq!(stale.status(), StatusCode::OK);
        assert_eq!(
            stale
                .headers()
                .get(CAPABILITIES_VERSION_HEADER)
                .unwrap()
                .to_str()
                .unwrap(),
            caps.tenant_version
        );

        let absent = conditional_response(&HeaderMap::new(), &caps);
        assert_eq!(absent.status(), StatusCode::OK);
    }
}
